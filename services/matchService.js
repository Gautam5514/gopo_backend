const Guest = require("../models/Guest");
const Photo = require("../models/Photo");
const Match = require("../models/Match");
const Event = require("../models/Event");
const faceService = require("./faceService");
const emailService = require("./emailService");

exports.runMatchingForEvent = async (eventId, { requireGuests = false } = {}) => {
    const guests = await Guest.find({ eventId });
    if (guests.length === 0) {
        if (requireGuests) {
            const error = new Error("No guests registered for this event");
            error.statusCode = 400;
            throw error;
        }
        return { matchCount: 0, notifiedGuests: 0, processedPhotos: 0 };
    }

    const eventDoc = await Event.findOne({ code: eventId }).select("name").lean();
    const eventName = eventDoc?.name || eventId;

    const faceMatcher = faceService.computeFaceMatcher(guests);
    const photos = await Photo.find({ eventId, processed: false });

    // O(1) lookup by string _id — avoids O(n*m) linear scan in the email loop.
    const guestById = new Map(guests.map((g) => [g._id.toString(), g]));

    let matchCount = 0;
    const notifiedGuests = new Set();
    const matchCountByGuest = new Map();
    const processedPhotoIds = [];

    for (const photo of photos) {
        if (!photo.detectedFaces || photo.detectedFaces.length === 0) {
            processedPhotoIds.push(photo._id);
            continue;
        }

        for (const face of photo.detectedFaces) {
            const bestMatch = faceMatcher.findBestMatch(new Float32Array(face.descriptor));
            if (bestMatch.label !== "unknown") {
                // Upsert prevents E11000 if runMatchingForEvent is called more than
                // once — only genuinely new matches increment the counters.
                const result = await Match.updateOne(
                    { photoId: photo._id, guestId: bestMatch.label },
                    {
                        $setOnInsert: {
                            photoId:    photo._id,
                            guestId:    bestMatch.label,
                            confidence: 1 - bestMatch.distance,
                        },
                    },
                    { upsert: true }
                );
                if (result.upsertedCount > 0) {
                    matchCount++;
                    notifiedGuests.add(bestMatch.label);
                    matchCountByGuest.set(
                        bestMatch.label,
                        (matchCountByGuest.get(bestMatch.label) || 0) + 1
                    );
                }
            }
        }
        processedPhotoIds.push(photo._id);
    }

    // Single bulk write instead of N sequential photo.save() calls.
    if (processedPhotoIds.length > 0) {
        await Photo.updateMany(
            { _id: { $in: processedPhotoIds } },
            { $set: { processed: true } }
        );
    }

    const emailFailures = [];

    // Send all notification emails concurrently — they are independent I/O.
    const emailResults = await Promise.allSettled(
        [...notifiedGuests].map(async (guestId) => {
            const guest = guestById.get(guestId);
            if (!guest) return;
            const loginUrl = emailService.buildGuestLoginUrl(guest.email);
            await emailService.sendPhotoReadyEmail(guest.email, guest.name, loginUrl, {
                eventName,
                matchCount: matchCountByGuest.get(guestId) || 0,
            });
        })
    );

    let notifiedCount = 0;
    emailResults.forEach((result, i) => {
        if (result.status === "fulfilled") {
            notifiedCount++;
        } else {
            const guestId = [...notifiedGuests][i];
            const guest   = guestById.get(guestId);
            emailFailures.push({ email: guest?.email, reason: result.reason?.message });
            console.error(`Photo ready email failed for ${guest?.email}:`, result.reason?.message);
        }
    });

    return {
        matchCount,
        notifiedGuests: notifiedCount,
        processedPhotos: photos.length,
        emailFailures,
    };
};
