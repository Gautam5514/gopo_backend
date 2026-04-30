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
