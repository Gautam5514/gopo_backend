const Job = require("../models/Job");

// Insert one Job document per photo. The polling worker in jobRunner.js
// picks these up automatically — no Redis or BullMQ needed.
//
// ordered:false — MongoDB inserts every valid document and collects errors at
// the end instead of stopping on the first failure.  Without this, a single
// bad document (e.g. corrupted photoId) would silently drop all subsequent
// jobs, leaving those Photo docs with cloudinaryUrl=null and blocking matching.
const enqueuePhotos = async (photos) => {
    const result = await Job.insertMany(
        photos.map(({ photoId, tempPath, eventId }) => ({
            type: "face_detection",
            payload: { photoId, tempPath, eventId },
        })),
        { ordered: false }
    );

    const inserted = result.length ?? 0;
    if (inserted < photos.length) {
        console.error(
            `[Queue] enqueuePhotos: only ${inserted}/${photos.length} jobs inserted — check logs for validation errors`
        );
    }
    return result;
};

module.exports = { enqueuePhotos };
