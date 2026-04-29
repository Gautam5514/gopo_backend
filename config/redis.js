const { Redis } = require("ioredis");

// BullMQ requires every Queue / Worker instance to have its own dedicated
// ioredis connection — connections cannot be shared between them because
// BullMQ uses blocking Redis commands internally (XREAD, BRPOPLPUSH).
// Call this factory once per Queue/Worker construction.
const createRedisConnection = () => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set in environment");

    return new Redis(url, {
        maxRetriesPerRequest: null, // BullMQ hard requirement — do not change
        enableReadyCheck: false,    // Upstash: skip the PING-on-connect check
    });
};

module.exports = { createRedisConnection };
