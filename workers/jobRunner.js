const fs = require("fs");
const { Worker } = require("bullmq");
const { Redis } = require("ioredis");
const { createRedisConnection } = require("../config/redis");
const { QUEUE_NAME } = require("../queues/photoQueue");
const Photo = require("../models/Photo");
const faceService = require("../services/faceService");
const cloudinaryService = require("../services/cloudinaryService");
const { runMatchingForEvent } = require("../services/matchService");

const WORKER_CONCURRENCY = 2;

let worker   = null;
let lockRedis = null; // Dedicated connection for Redis NX lock — must not be shared with the Worker

// ── Shared helpers ─────────────────────────────────────────────────────────────

// Fire-and-forget temp-file deletion. Errors are silently ignored because the
// file may have already been removed by a previous attempt.
const unlinkSilent = (p) => { if (p) fs.unlink(p, () => {}); };

// Marks a Photo as permanently failed so it never blocks event matching.
const markPhotoFailed = (photoId) =>
    Photo.findByIdAndUpdate(photoId, {
        cloudinaryUrl: "upload_failed",
        detectedFaces: [],
    }).catch(() => {});

// ── Distributed matching lock ──────────────────────────────────────────────────
// When multiple workers finish photos for the same event simultaneously, both
// may see remaining === 0 at the same instant. A Redis NX lock ensures only one
// of them fires runMatchingForEvent.

const acquireMatchingLock = async (eventId) => {
    if (!lockRedis) return false;
    try {
        const result = await lockRedis.set(
            `gopo:matching-lock:${eventId}`,
            "1",
            "EX", 300, // 5-minute TTL covers worst-case matching duration
            "NX"       // set only if Not eXists
        );
        return result === "OK";
    } catch {
        return false;
    }
};

// Called after every photo is finalised (success or permanent failure).
// cloudinaryUrl === null means still pending; anything else is done.
const checkAndTriggerMatching = async (eventId) => {
    try {
        const remaining = await Photo.countDocuments({ eventId, cloudinaryUrl: null });
        if (remaining > 0) return;

        const locked = await acquireMatchingLock(eventId);
        if (!locked) return; // Another worker already claimed this run

        // Fire-and-forget: matching may take seconds to minutes.
        runMatchingForEvent(eventId)
            .then((r) =>
                console.log(
                    `[Worker] Matching done for ${eventId}: ` +
                    `${r.matchCount} matches, ${r.notifiedGuests} guests notified`
                )
            )
            .catch((err) =>
                console.error(`[Worker] Matching failed for ${eventId}:`, err.message)
            );
    } catch (err) {
        console.error(`[Worker] checkAndTriggerMatching error for ${eventId}:`, err.message);
    }
};

// ── Job processor ──────────────────────────────────────────────────────────────

const processJob = async (job) => {
    const { photoId, tempPath, eventId } = job.data;

    // Idempotency guard: BullMQ may retry after a crash that happened after a
    // successful Cloudinary upload but before the ack reached the broker.
    const existingPhoto = await Photo.findById(photoId).select("cloudinaryUrl").lean();
    if (existingPhoto?.cloudinaryUrl && existingPhoto.cloudinaryUrl !== "upload_failed") {
        unlinkSilent(tempPath);
        await checkAndTriggerMatching(eventId);
        return;
    }

    // Read the buffer first. Wrapping in try/catch atomically handles the case
    // where the server restarted and the temp file is gone (no TOCTOU race).
    let buffer;
    try {
        buffer = await fs.promises.readFile(tempPath);
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            console.warn(`[Worker] Temp file missing for job ${job.id}: ${tempPath}`);
            await markPhotoFailed(photoId);
            await checkAndTriggerMatching(eventId);
            return;
        }
        throw readErr; // Unexpected error — let BullMQ retry
    }

    const [detectedFaces, uploadResult] = await Promise.all([
        faceService.detectAllFaces(buffer),
        cloudinaryService.uploadImage(buffer, "event_photos"),
    ]);

    await Photo.findByIdAndUpdate(photoId, {
        cloudinaryUrl: uploadResult.secure_url,
        publicId:      uploadResult.public_id,
        detectedFaces,
    });

    // Delete only after the DB write — BullMQ retries need the file to exist.
    unlinkSilent(tempPath);

    await checkAndTriggerMatching(eventId);
};

// ── Permanent failure handler ──────────────────────────────────────────────────
// BullMQ fires "failed" on every attempt including intermediate ones where a
// retry is still pending. Act only on the final failure.

const handleFailedJob = async (job, err) => {
    if (!job?.data) return;

    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // More retries remain

    console.error(
        `[Worker] Job ${job.id} permanently failed after ${job.attemptsMade} attempt(s):`,
        err.message
    );

    const { photoId, tempPath, eventId } = job.data;
    unlinkSilent(tempPath);

    if (photoId && eventId) {
        await markPhotoFailed(photoId);
        await checkAndTriggerMatching(eventId);
    }
};

// ── Lifecycle ──────────────────────────────────────────────────────────────────

exports.startJobRunner = async () => {
    if (!process.env.REDIS_URL) {
        console.warn(
            "⚠️  REDIS_URL not set — BullMQ worker disabled. " +
            "Photos will not be processed until REDIS_URL is configured."
        );
        return;
    }

    lockRedis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: false,
    });
    lockRedis.on("error", (err) => console.error("[Worker] Lock Redis error:", err.message));

    worker = new Worker(QUEUE_NAME, processJob, {
        connection: createRedisConnection(),
        concurrency: WORKER_CONCURRENCY,
    });

    worker.on("completed", (job) => console.log(`[Worker] Job ${job.id} completed`));
    // Wrap in .catch so an async failure in handleFailedJob never crashes the worker process.
    worker.on("failed", (job, err) => handleFailedJob(job, err).catch(() => {}));
    worker.on("error",  (err) => console.error("[Worker] Worker error:", err.message));

    console.log(`✅ BullMQ worker started (concurrency: ${WORKER_CONCURRENCY})`);
};

exports.stopJobRunner = async () => {
    const tasks = [];
    if (worker)    { tasks.push(worker.close());              worker    = null; }
    if (lockRedis) { tasks.push(lockRedis.quit().catch(() => {})); lockRedis = null; }
    await Promise.all(tasks);
};
