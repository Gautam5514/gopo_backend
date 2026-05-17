const fs = require("fs");
const Job = require("../models/Job");
const Photo = require("../models/Photo");
const sharp = require("sharp");
const faceService = require("../services/faceService");
const cloudinaryService = require("../services/cloudinaryService");
const { triggerMatchingForEvent } = require("../services/matchService");

// Default to 3 so Cloudinary uploads and disk reads overlap while ONNX
// processes the current photo.  ONNX itself is still serialised (one
// inference at a time via the priority queue in faceService), but with
// three workers in flight the network-bound Cloudinary step runs in
// parallel, cutting total batch time by ~2–3×.
// Override with PHOTO_WORKER_CONCURRENCY=N in .env for tuning.
const CONCURRENCY       = Math.max(1, Number(process.env.PHOTO_WORKER_CONCURRENCY || 3));
const BUSY_POLL_MS      = 500;           // poll quickly while there are jobs
const IDLE_POLL_MS      = 5_000;         // back off when queue is empty
const DB_ERROR_POLL_MS  = 15_000;        // back off longer after a MongoDB error
// MUST be strictly greater than JOB_TIMEOUT_MS.  If STALE_AFTER_MS ≤ JOB_TIMEOUT_MS a
// second worker reclaims the job before withTimeout fires, so two workers process the
// same photo simultaneously.  20 min = 15 min timeout + 5 min safety margin.
const STALE_AFTER_MS    = 20 * 60_000;
// Cloudinary upload is capped at 120 s internally; face detection on a
// 2-core machine takes < 60 s per photo.  5 min is ample and keeps the
// stale-reclaim window comfortable.
const JOB_TIMEOUT_MS    = 15 * 60_000;  // 15 min — generous for first-run ONNX model load + large photos
const MAX_ATTEMPTS      = 3;
const BACKOFF_BASE_MS   = 15_000;        // 15 s → 30 s → 45 s between retries

let running          = false;
let activeJobs       = 0;
let lastStaleCheckAt = 0;
const STALE_CHECK_INTERVAL_MS = 60_000; // run reclaimStaleJobs at most once per minute

// ── Helpers ────────────────────────────────────────────────────────────────────

const unlinkSilent = (p) => { if (p) fs.unlink(p, () => {}); };

const markPhotoFailed = (photoId) =>
    Photo.findByIdAndUpdate(photoId, {
        cloudinaryUrl: "upload_failed",
        detectedFaces: [],
    }).catch(() => {});

// ── Matching trigger ───────────────────────────────────────────────────────────

const checkAndTriggerMatching = async (eventId) => {
    try {
        // resetProcessed: true ensures guests who registered while an earlier
        // photo batch was already matched (processed: true) still get their
        // photos found.  The reset only runs when remainingUploads reaches 0
        // (all photos done), so it does not cause redundant work mid-batch.
        triggerMatchingForEvent(eventId, { resetProcessed: true })
            .then((r) => {
                if (r.skipped) {
                    console.log(
                        `[Worker] Matching deferred for ${eventId}: ${r.reason}` +
                        (r.remainingUploads ? ` (${r.remainingUploads} photo(s) still uploading)` : "")
                    );
                } else {
                    console.log(
                        `[Worker] Matching done for ${eventId}: ` +
                        `${r.matchCount || 0} match(es), ${r.notifiedGuests || 0} guest(s) notified` +
                        (r.processedPhotos ? ` across ${r.processedPhotos} photo(s)` : "")
                    );
                }
            })
            .catch((err) =>
                console.error(`[Worker] Matching failed for ${eventId}:`, err.message)
            );
    } catch (err) {
        console.error(`[Worker] checkAndTriggerMatching error for ${eventId}:`, err.message);
    }
};

// ── Job processor (same logic as before, no Redis dependency) ──────────────────

const processJob = async (job) => {
    const { photoId, tempPath, eventId } = job.payload;
    console.log(`[Worker] ▶ Starting photo ${photoId} for event ${eventId} (attempt ${job.attempts})`);

    // Idempotency: if a previous attempt already uploaded successfully, skip.
    const existing = await Photo.findById(photoId).select("cloudinaryUrl").lean();
    if (existing?.cloudinaryUrl && existing.cloudinaryUrl !== "upload_failed") {
        unlinkSilent(tempPath);
        await checkAndTriggerMatching(eventId);
        return;
    }

    let buffer;
    try {
        buffer = await fs.promises.readFile(tempPath);
    } catch (readErr) {
        if (readErr.code === "ENOENT") {
            console.warn(`[Worker] Temp file missing for job ${job._id}: ${tempPath}`);
            await markPhotoFailed(photoId);
            await checkAndTriggerMatching(eventId);
            return;
        }
        throw readErr;
    }

    const t0 = Date.now();

    // Resize to at most 1920 px on the long edge before any further processing.
    // Benefits:
    //   • Cloudinary upload: a 1920-px JPEG is ~300–600 KB vs 5–10 MB for a raw
    //     camera JPEG — 5–10× faster network transfer.
    //   • Face alignment: sharp extracts the face crop from this smaller buffer,
    //     using far less memory per face.
    //   • Face detection accuracy is unchanged — RetinaFace already resizes to
    //     640×640 internally, so the detector sees the same pixels either way.
    // withoutEnlargement: true ensures small images are never upscaled.
    const resized = await sharp(buffer)
        .rotate()                                             // apply EXIF orientation once
        .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: false })
        .toBuffer();
    console.log(`[Worker] Resize done in ${Date.now() - t0}ms (${(resized.length / 1024).toFixed(0)} KB) — photo ${photoId}`);

    // Face detection first — it is the slow, CPU-bound step and the most likely
    // to hit the job timeout.  Running it before the Cloudinary upload means:
    //   • A timeout leaves no orphaned image in Cloudinary.
    //   • markPhotoFailed (last attempt) fires only when detection truly gave up —
    //     there is no background task that could later overwrite the failed state
    //     with a half-processed result.
    const detectedFaces = await faceService.detectAllFaces(resized);
    console.log(`[Worker] Face detection done in ${Date.now() - t0}ms — ${detectedFaces.length} face(s) — photo ${photoId}`);

    const uploadResult = await cloudinaryService.uploadImage(resized, "event_photos");
    console.log(`[Worker] Cloudinary upload done in ${Date.now() - t0}ms — photo ${photoId}`);

    await Photo.findByIdAndUpdate(photoId, {
        cloudinaryUrl: uploadResult.secure_url,
        publicId:      uploadResult.public_id,
        detectedFaces,
    });

    unlinkSilent(tempPath);
    await checkAndTriggerMatching(eventId);
};

// ── Job state transitions ──────────────────────────────────────────────────────

const completeJob = (id) =>
    Job.findByIdAndUpdate(id, {
        $set: { status: "done", processingStartedAt: null },
    }).catch(() => {});

const failJob = async (job, err) => {
    const isLastAttempt = job.attempts >= MAX_ATTEMPTS;
    console.error(
        `[Worker] Job ${job._id} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}):`,
        err.message
    );
    await Job.findByIdAndUpdate(job._id, {
        $set: {
            status:              isLastAttempt ? "failed" : "pending",
            error:               err.message,
            processingStartedAt: null,
            nextRetryAt:         isLastAttempt
                                     ? null
                                     : new Date(Date.now() + job.attempts * BACKOFF_BASE_MS),
        },
    }).catch(() => {});

    if (isLastAttempt) {
        const { photoId, eventId } = job.payload;
        if (photoId && eventId) {
            await markPhotoFailed(photoId);
            await checkAndTriggerMatching(eventId);
        }
    }
};

// ── Polling helpers ────────────────────────────────────────────────────────────

// Atomically claim the oldest pending job that is ready to run.
const claimNextJob = () =>
    Job.findOneAndUpdate(
        {
            status:   "pending",
            attempts: { $lt: MAX_ATTEMPTS },
            $or: [
                { nextRetryAt: { $exists: false } },
                { nextRetryAt: null },
                { nextRetryAt: { $lte: new Date() } },
            ],
        },
        {
            $set: { status: "processing", processingStartedAt: new Date() },
            $inc: { attempts: 1 },
        },
        { sort: { createdAt: 1 }, returnDocument: "after" }
    );

// Reset jobs that were claimed but never finished (e.g. server crashed mid-job).
const reclaimStaleJobs = () =>
    Job.updateMany(
        {
            status:              "processing",
            processingStartedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
        },
        { $set: { status: "pending", processingStartedAt: null } }
    );

// Wrap a job in a hard timeout so a hanging job never blocks the worker forever.
const withTimeout = (promise, ms) =>
    Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Job timed out after ${ms / 1000}s`)), ms)
        ),
    ]);

// ── Main poll tick ─────────────────────────────────────────────────────────────

const poll = async () => {
    const now = Date.now();
    if (now - lastStaleCheckAt >= STALE_CHECK_INTERVAL_MS) {
        await reclaimStaleJobs();
        lastStaleCheckAt = now;
    }

    let claimed = 0;
    while (activeJobs < CONCURRENCY) {
        const job = await claimNextJob();
        if (!job) break;

        claimed++;
        activeJobs++;
        withTimeout(processJob(job), JOB_TIMEOUT_MS)
            .then(() => completeJob(job._id))
            .catch((err) => failJob(job, err))
            .finally(() => { activeJobs--; });
    }
    return claimed; // > 0 means "stay busy, poll again soon"
};

// ── Lifecycle ──────────────────────────────────────────────────────────────────

// Detect transient MongoDB connection errors so we back off longer before
// retrying — the driver reconnects automatically but needs a few seconds.
const isDbError = (err) =>
    err.name === "MongoNetworkError" ||
    err.name === "MongoServerSelectionError" ||
    /interrupted|timed out|ECONNRESET|ENOTFOUND/i.test(err.message);

// Recursive async loop — each tick schedules the next one only after finishing,
// so polls never pile up even if one takes longer than the interval.
const schedulePoll = async (delayMs) => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (!running) return;

    let nextDelay = IDLE_POLL_MS;
    const found = await poll().catch((err) => {
        if (isDbError(err)) {
            console.warn(`[Worker] MongoDB connection error — backing off ${DB_ERROR_POLL_MS / 1000}s:`, err.message);
            nextDelay = DB_ERROR_POLL_MS;
        } else {
            console.error("[Worker] Poll error:", err.message);
        }
        return 0;
    });

    if (found > 0) nextDelay = BUSY_POLL_MS;
    schedulePoll(nextDelay);
};

exports.startJobRunner = async () => {
    running = true;
    schedulePoll(0); // start immediately, no await — runs in background
    console.log(`✅ Job runner started (concurrency: ${CONCURRENCY}, no Redis required)`);
};

exports.stopJobRunner = async () => {
    running = false;

    // Release any jobs currently marked "processing" back to "pending"
    // BEFORE the HTTP server and MongoDB connection close.  This is the
    // critical step: if we don't do it here, the jobs stay in "processing"
    // and the new process has to wait up to STALE_AFTER_MS (10 min) before
    // reclaiming them.  Doing it here means the very first poll on the new
    // server picks them up immediately.
    try {
        const { modifiedCount } = await Job.updateMany(
            { status: "processing" },
            { $set: { status: "pending", processingStartedAt: null } }
        );
        if (modifiedCount > 0) {
            console.log(`[Worker] Released ${modifiedCount} in-progress job(s) back to queue for next startup`);
        }
    } catch (err) {
        // MongoDB may already be closing — stale reclaim on the new server
        // will handle it after STALE_AFTER_MS.
        console.warn("[Worker] Could not release in-progress jobs on shutdown:", err.message);
    }

    if (activeJobs > 0) {
        console.warn(`[Worker] Shutdown with ${activeJobs} job(s) will be retried on next startup`);
    }
};
