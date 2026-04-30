const mongoose = require("mongoose");
const Photo = require("../models/Photo");
const Guest = require("../models/Guest");
const Match = require("../models/Match");
const DownloadLog = require("../models/DownloadLog");
const Event = require("../models/Event");
const { assertUploadAllowed, incrementUsage } = require("../services/billingService");
const { runMatchingForEvent } = require("../services/matchService");
const { getPhotoQueue } = require("../queues/photoQueue");

const getOwnedEvents = (adminId) => Event.find({ ownerId: adminId });

const getOwnedEventByCode = (adminId, eventCode) =>
    Event.findOne({ code: eventCode, ownerId: adminId });

const getOwnedEventById = (adminId, eventId) =>
    Event.findOne({ _id: eventId, ownerId: adminId });

exports.uploadPhotos = async (req, res) => {
    try {
        const { eventId } = req.body;
        const files = req.files;

        const event = await getOwnedEventByCode(req.user.userId, eventId);
        if (!event) {
            return res.status(404).json({ error: "Event not found" });
        }

        if (!files || files.length === 0) {
            return res.status(400).json({ error: "No photos uploaded" });
        }

        const billing = await assertUploadAllowed(req.user.userId, files.length);

        // Create Photo records immediately (no face data yet) and queue one
        // face_detection job per photo. The job runner processes them in the
        // background: detects faces, uploads to Cloudinary, then triggers
        // matching once all photos in this event are processed.
        const photos = await Promise.all(
            files.map(() =>
                Photo.create({
                    cloudinaryUrl: null,
                    publicId: null,
                    eventId,
                    detectedFaces: [],
                    processed: false,
                })
            )
        );

        await getPhotoQueue().addBulk(
            files.map((file, i) => ({
                name: "face_detection",
                data: {
                    photoId: photos[i]._id.toString(),
                    tempPath: file.path,
                    eventId,
                },
            }))
        );

        const updatedUsage = await incrementUsage(
            req.user.userId,
            billing.subscription._id,
            photos.length
        );

        return res.status(202).json({
            success: true,
            message: `${photos.length} photo${photos.length === 1 ? "" : "s"} uploaded. Face detection and matching are running in the background — guests will be emailed automatically when ready.`,
            uploadedCount: photos.length,
            usage: {
                usedUploads:
                    updatedUsage?.usedUploads ??
                    billing.usage.usedUploads + photos.length,
                remainingUploads: Math.max(
                    0,
                    billing.subscription.uploadLimit -
                        (updatedUsage?.usedUploads ??
                            billing.usage.usedUploads + photos.length)
                ),
            },
        });
    } catch (error) {
        console.error("Upload error:", error);
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        return res.status(500).json({ error: "Photo upload failed. Please try again." });
    }
};

exports.startMatching = async (req, res) => {
    try {
        const { eventId } = req.body;
        const event = await getOwnedEventByCode(req.user.userId, eventId);
        if (!event) {
            return res.status(404).json({ error: "Event not found" });
        }

        const result = await runMatchingForEvent(eventId, { requireGuests: true });

        res.json({
            success: true,
            message: `Matching complete. Found ${result.matchCount} matches. Emails sent to ${result.notifiedGuests} guests.`,
            ...result,
        });
    } catch (error) {
        console.error("Matching error:", error);
        if (error.statusCode) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        return res.status(500).json({ error: "Matching failed. Please try again." });
    }
};

exports.getDownloadStats = async (req, res) => {
    try {
        const eventId = String(req.query.eventId || "").trim();
        if (!eventId) {
            return res.status(400).json({ error: "eventId is required" });
        }

        const event = await getOwnedEventByCode(req.user.userId, eventId);
        if (!event) {
            return res.status(404).json({ error: "Event not found" });
        }

        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(startOfDay);
        endOfDay.setDate(endOfDay.getDate() + 1);
        const start7Days = new Date(startOfDay);
        start7Days.setDate(start7Days.getDate() - 6);

        const todayDownloads = await DownloadLog.countDocuments({
            eventId,
            downloadedAt: { $gte: startOfDay, $lt: endOfDay },
        });

        const allTimeDownloads = await DownloadLog.countDocuments({ eventId });
        const totalPhotos = await Photo.countDocuments({ eventId });
        const downloadedPhotos = (
            await DownloadLog.distinct("photoId", { eventId })
        ).length;
        const uniqueGuestsDownloaded = (
            await DownloadLog.distinct("guestId", { eventId })
        ).length;

        const trendRows = await DownloadLog.aggregate([
            {
                $match: {
                    eventId,
                    downloadedAt: { $gte: start7Days, $lt: endOfDay },
                },
            },
            {
                $group: {
                    _id: {
                        $dateToString: { format: "%Y-%m-%d", date: "$downloadedAt" },
                    },
                    count: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        const trendMap = new Map(trendRows.map((row) => [row._id, row.count]));
        const last7Days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(start7Days);
            d.setDate(start7Days.getDate() + i);
            const key = d.toISOString().slice(0, 10);
            last7Days.push({ date: key, count: trendMap.get(key) || 0 });
        }

        return res.json({
            success: true,
            eventId,
            todayDownloads,
            allTimeDownloads,
            totalPhotos,
            downloadedPhotos,
            notDownloadedPhotos: Math.max(0, totalPhotos - downloadedPhotos),
            uniqueGuestsDownloaded,
            downloadCoveragePercent: totalPhotos
                ? Math.round((downloadedPhotos / totalPhotos) * 100)
                : 0,
            last7Days,
            date: startOfDay.toISOString().slice(0, 10),
        });
    } catch (error) {
        console.error("Download stats error:", error);
        return res.status(500).json({ error: "Failed to load download statistics." });
    }
};

exports.getDashboardStats = async (req, res) => {
    try {
        const events = await getOwnedEvents(req.user.userId).sort({ createdAt: -1 }).lean();
        const eventCodes = events.map((event) => event.code);
        const totalEvents = events.length;
        const totalGuests = eventCodes.length
            ? await Guest.countDocuments({ eventId: { $in: eventCodes } })
            : 0;
        const totalPhotos = eventCodes.length
            ? await Photo.countDocuments({ eventId: { $in: eventCodes } })
            : 0;

        let totalMatches = 0;
        if (eventCodes.length) {
            const photoIds = await Photo.distinct("_id", { eventId: { $in: eventCodes } });
            if (photoIds.length) {
                totalMatches = await Match.countDocuments({ photoId: { $in: photoIds } });
            }
        }

        const recentEvents = events.slice(0, 5);

        res.json({
            success: true,
            totalEvents,
            totalGuests,
            totalPhotos,
            totalMatches,
            recentEvents,
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).json({ error: "Failed to load dashboard statistics." });
    }
};

exports.getEvents = async (req, res) => {
    try {
        const ownerId = new mongoose.Types.ObjectId(req.user.userId);

        const events = await Event.aggregate([
            { $match: { ownerId } },
            { $sort: { createdAt: -1 } },
            {
                $lookup: {
                    from: "guests",
                    localField: "code",
                    foreignField: "eventId",
                    as: "_guests",
                },
            },
            {
                $lookup: {
                    from: "photos",
                    localField: "code",
                    foreignField: "eventId",
                    as: "_photos",
                },
            },
            {
                $addFields: {
                    guestCount: { $size: "$_guests" },
                    photoCount: { $size: "$_photos" },
                },
            },
            { $project: { _guests: 0, _photos: 0 } },
        ]);

        res.json({ success: true, events });
    } catch (error) {
        console.error("Get events error:", error);
        res.status(500).json({ error: "Failed to load events." });
    }
};

exports.createEvent = async (req, res) => {
    try {
        const { name, code } = req.body || {};
        if (!name || !code) {
            return res.status(400).json({ error: "Name and code are required" });
        }

        const existingEvent = await Event.findOne({ code });
        if (existingEvent) {
            return res.status(400).json({ error: "Event code already exists" });
        }

        const event = await Event.create({ name, code, ownerId: req.user.userId });
        res.status(201).json({ success: true, event });
    } catch (error) {
        console.error("Create event error:", error);
        res.status(500).json({ error: "Failed to create event." });
    }
};

exports.getEventById = async (req, res) => {
    try {
        const { id } = req.params;
        const event = await getOwnedEventById(req.user.userId, id).lean();
        if (!event) {
            return res.status(404).json({ error: "Event not found" });
        }

        const guests = await Guest.find({ eventId: event.code })
            .select("-faceDescriptor -selfiePublicId")
            .lean();
        const photoCount = await Photo.countDocuments({ eventId: event.code });
        const guestIds = guests.map((g) => g._id);
        const matchCount = await Match.countDocuments({ guestId: { $in: guestIds } });

        // Count photos still being processed by the job runner.
        const pendingProcessing = await Photo.countDocuments({
            eventId: event.code,
            cloudinaryUrl: null,
        });

        res.json({
            success: true,
            event: {
                ...event,
                guests,
                photoCount,
                matchCount,
                pendingProcessing,
            },
        });
    } catch (error) {
        console.error("Get event by id error:", error);
        res.status(500).json({ error: "Failed to load event details." });
    }
};
