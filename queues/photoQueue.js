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

const { Queue } = require("bullmq");
const { createRedisConnection } = require("../config/redis");

const QUEUE_NAME = "photo-processing";

let _queue = null;

// Lazily initialised singleton — avoids creating a Redis connection at
// require-time (before dotenv has loaded REDIS_URL).
const getPhotoQueue = () => {
    if (_queue) return _queue;

    _queue = new Queue(QUEUE_NAME, {
        connection: createRedisConnection(),
        defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 }, // 5s → 10s → 20s
            removeOnComplete: { count: 100 }, // keep last 100 completed for debugging
            removeOnFail: { count: 50 },
        },
    });

    _queue.on("error", (err) =>
        console.error("[PhotoQueue] Queue error:", err.message)
    );

    return _queue;
};

module.exports = { getPhotoQueue, QUEUE_NAME };
