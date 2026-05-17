const Guest = require("../models/Guest");
const Photo = require("../models/Photo");
const Match = require("../models/Match");
const Event = require("../models/Event");
const Lock = require("../models/Lock");
const faceService = require("./faceService");
const emailService = require("./emailService");

const MATCHING_LOCK_MS = 10 * 60_000;

const acquireMatchingLock = async (eventId) => {
    const key = `matching:${eventId}`;
    const owner = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const now = new Date();

    await Lock.deleteOne({ key, expireAt: { $lte: now } });
    try {
        await Lock.create({
            key,
            owner,
            expireAt: new Date(now.getTime() + MATCHING_LOCK_MS),
        });
        return { key, owner };
    } catch (err) {
        if (err.code === 11000) return null;
        throw err;
    }
};

const releaseMatchingLock = ({ key, owner }) =>
    Lock.deleteOne({ key, owner }).catch(() => {});

const runMatchingForEvent = async (eventId, { requireGuests = false } = {}) => {
    // Only include guests whose biometric data hasn't been cleaned up yet.
    // cleanupService zeroes faceDescriptor to [] — face-api throws on empty descriptors.
    const guests = await Guest.find({ eventId, "faceDescriptor.0": { $exists: true } });
    if (guests.length === 0) {
        if (requireGuests) {
            const error = new Error("No guests with valid face data found for this event");
            error.statusCode = 400;
            throw error;
        }
        return { matchCount: 0, notifiedGuests: 0, processedPhotos: 0 };
    }

    const eventDoc = await Event.findOne({ code: eventId }).select("name").lean();
    const eventName = eventDoc?.name || eventId;

    const faceMatcher = faceService.computeFaceMatcher(guests);
    const photos = await Photo.find({ eventId, processed: false });
    console.log(`[Match] ${eventId}: ${guests.length} guest(s), ${photos.length} unprocessed photo(s)`);

    // O(1) lookup by string _id — avoids O(n*m) linear scan in the email loop.
    const guestById = new Map(guests.map((g) => [g._id.toString(), g]));

    let matchCount = 0;
    const notifiedGuests = new Set();
    const matchCountByGuest = new Map();
    const processedPhotoIds = [];

    // Collect all upsert operations in memory (CPU-only — no DB calls yet).
    // opMeta[i] records the guestId for bulkOps[i] so we can identify which
    // operations were genuine new inserts from result.upsertedIds afterward.
    const bulkOps = [];
    const opMeta  = [];

    for (const photo of photos) {
        if (!photo.detectedFaces || photo.detectedFaces.length === 0) {
            console.log(`[Match] photo ${photo._id}: no detected faces — skipping`);
            processedPhotoIds.push(photo._id);
            continue;
        }

        for (const face of photo.detectedFaces) {
            const bestMatch = faceMatcher.findBestMatch(new Float32Array(face.descriptor));
            const sim       = (1 - bestMatch.distance).toFixed(3);
            console.log(
                `[Match] photo ${photo._id}: best=${bestMatch.label} cosine=${sim} ` +
                (bestMatch.label === "unknown" ? "→ BELOW THRESHOLD" : "→ MATCHED")
            );
            if (bestMatch.label !== "unknown") {
                bulkOps.push({
                    updateOne: {
                        filter: { photoId: photo._id, guestId: bestMatch.label },
                        update: {
                            $setOnInsert: {
                                photoId:    photo._id,
                                guestId:    bestMatch.label,
                                confidence: 1 - bestMatch.distance,
                            },
                        },
                        upsert: true,
                    },
                });
                opMeta.push(bestMatch.label); // guestId string, parallel to bulkOps
            }
        }
        processedPhotoIds.push(photo._id);
    }

    // One network round-trip for all match upserts instead of N sequential
    // awaits.  ordered:false lets MongoDB continue past individual E11000 errors
    // (duplicate match from a concurrent run) without aborting the whole batch.
    // result.upsertedIds maps operation index → new ObjectId for genuine inserts.
    if (bulkOps.length > 0) {
        const bwResult = await Match.bulkWrite(bulkOps, { ordered: false });
        for (const idxStr of Object.keys(bwResult.upsertedIds || {})) {
            const guestId = opMeta[Number(idxStr)];
            matchCount++;
            notifiedGuests.add(guestId);
            matchCountByGuest.set(guestId, (matchCountByGuest.get(guestId) || 0) + 1);
        }
    }
    console.log(`[Match] ${eventId}: ${bulkOps.length} face comparisons → ${matchCount} new match(es)`);

    // Single bulk write instead of N sequential photo.save() calls.
    if (processedPhotoIds.length > 0) {
        await Photo.updateMany(
            { _id: { $in: processedPhotoIds } },
            { $set: { processed: true } }
        );
    }

    const emailFailures = [];
    let notifiedCount = 0;

    // Send notification emails in batches of 10 with a 200 ms cooldown between
    // batches.  Firing 1000 simultaneous Resend API calls risks hitting their
    // per-second rate limit and getting requests rejected or the sender domain
    // flagged.  10 emails / 200 ms = 50 emails/s — comfortably within limits.
    // 1000 guests ≈ 20 s total email time; invisible to guests who are not
    // waiting synchronously for this response.
    const EMAIL_BATCH    = 10;
    const EMAIL_DELAY_MS = 200;
    const guestIdList    = [...notifiedGuests];

    for (let i = 0; i < guestIdList.length; i += EMAIL_BATCH) {
        const batch   = guestIdList.slice(i, i + EMAIL_BATCH);
        const results = await Promise.allSettled(
            batch.map(async (guestId) => {
                const guest = guestById.get(guestId);
                if (!guest) return;
                const loginUrl = emailService.buildGuestLoginUrl(guest.email);
                await emailService.sendPhotoReadyEmail(guest.email, guest.name, loginUrl, {
                    eventName,
                    matchCount: matchCountByGuest.get(guestId) || 0,
                });
            })
        );
        results.forEach((result, j) => {
            if (result.status === "fulfilled") {
                notifiedCount++;
            } else {
                const guest = guestById.get(batch[j]);
                emailFailures.push({ email: guest?.email, reason: result.reason?.message });
                console.error(`Photo ready email failed for ${guest?.email}:`, result.reason?.message);
            }
        });
        // Cooldown between batches (skip pause after the final batch)
        if (i + EMAIL_BATCH < guestIdList.length) {
            await new Promise((r) => setTimeout(r, EMAIL_DELAY_MS));
        }
    }

    return {
        matchCount,
        notifiedGuests: notifiedCount,
        processedPhotos: photos.length,
        emailFailures,
    };
};

const triggerMatchingForEvent = async (
    eventId,
    { requireGuests = false, resetProcessed = false } = {}
) => {
    const remainingUploads = await Photo.countDocuments({ eventId, cloudinaryUrl: null });
    if (remainingUploads > 0) {
        return {
            skipped: true,
            reason: "photos_still_processing",
            remainingUploads,
        };
    }

    const lock = await acquireMatchingLock(eventId);
    if (!lock) {
        return { skipped: true, reason: "matching_already_running" };
    }

    try {
        // A newly registered or re-registered guest must be compared against
        // photos that may have been matched earlier, before this descriptor
        // existed. Existing Match upserts prevent duplicate matches/emails.
        if (resetProcessed) {
            const resetResult = await Photo.updateMany(
                { eventId, cloudinaryUrl: { $ne: null } },
                { $set: { processed: false } }
            );
            console.log(`[Match] ${eventId}: reset ${resetResult.modifiedCount} photo(s) to unprocessed`);
        }
        const result = await runMatchingForEvent(eventId, { requireGuests });
        return { skipped: false, ...result };
    } finally {
        await releaseMatchingLock(lock);
    }
};

module.exports = {
    runMatchingForEvent,
    triggerMatchingForEvent,
};
