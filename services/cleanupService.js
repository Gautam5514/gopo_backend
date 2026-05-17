const Guest = require("../models/Guest");
const Photo = require("../models/Photo");
const Match = require("../models/Match");
const DownloadLog = require("../models/DownloadLog");
const Job = require("../models/Job");
const cloudinaryService = require("./cloudinaryService");

// 30 days gives real events (weddings, conferences) enough time to upload
// photos, run matching, and let guests download before cleanup begins.
// The 10-day default was too aggressive: it wiped guest face descriptors
// mid-event, causing matching to return 0 results even for recent uploads.
// Override with IMAGE_RETENTION_DAYS in .env if needed.
const retentionDays = Number(process.env.IMAGE_RETENTION_DAYS || 30);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_HOURS || 24) * 60 * 60 * 1000;

// Prevents two cleanup runs from overlapping when runCleanup takes longer than
// cleanupIntervalMs (possible with tens-of-thousands of photos + slow Cloudinary).
// Overlapping runs cause duplicate Cloudinary deletions (404 errors) and can race
// on the same MongoDB documents.
let cleanupRunning = false;

const getCutoffDate = () => new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

const safeDeleteCloudinaryByPublicId = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinaryService.deleteImage(publicId);
  } catch (error) {
    console.error(`Cleanup cloudinary delete failed for ${publicId}:`, error.message);
  }
};

const runCleanup = async () => {
  if (cleanupRunning) {
    console.warn("[cleanup] Previous run still in progress — skipping this tick");
    return;
  }
  cleanupRunning = true;
  const cutoff = getCutoffDate();
  console.log(`[cleanup] Running cleanup for assets older than ${cutoff.toISOString()}`);

  // 1) Delete uploaded event photos (Cloudinary + matches + photo docs + logs)
  const oldPhotos = await Photo.find({ createdAt: { $lt: cutoff } }).select("_id publicId cloudinaryUrl");
  if (oldPhotos.length) {
    for (const photo of oldPhotos) {
      const derivedPublicId = photo.publicId || cloudinaryService.extractPublicIdFromUrl(photo.cloudinaryUrl);
      await safeDeleteCloudinaryByPublicId(derivedPublicId);
    }
    const oldPhotoIds = oldPhotos.map((p) => p._id);
    await Match.deleteMany({ photoId: { $in: oldPhotoIds } });
    await DownloadLog.deleteMany({ photoId: { $in: oldPhotoIds } });
    await Photo.deleteMany({ _id: { $in: oldPhotoIds } });
  }

  // 2) Delete guest selfie images and descriptors older than cutoff
  const oldGuests = await Guest.find({ createdAt: { $lt: cutoff } }).select("_id selfiePublicId selfieUrl");
  for (const guest of oldGuests) {
    const derivedPublicId = guest.selfiePublicId || cloudinaryService.extractPublicIdFromUrl(guest.selfieUrl);
    await safeDeleteCloudinaryByPublicId(derivedPublicId);
  }
  if (oldGuests.length) {
    await Guest.updateMany(
      { _id: { $in: oldGuests.map((g) => g._id) } },
      { $set: { selfieUrl: null, selfiePublicId: null, faceDescriptor: [] } }
    );
  }

  // 3) Delete stale download logs
  await DownloadLog.deleteMany({ downloadedAt: { $lt: cutoff } });

  // 4) Delete completed/failed Job documents older than the retention window.
  //    Without this the jobs collection grows indefinitely.
  const { deletedCount: deletedJobs } = await Job.deleteMany({
    status: { $in: ["done", "failed"] },
    updatedAt: { $lt: cutoff },
  });

  console.log(
    `[cleanup] Done. photos=${oldPhotos.length}, guests=${oldGuests.length}, jobs=${deletedJobs}, retentionDays=${retentionDays}`
  );
  cleanupRunning = false;
};

const safeRunCleanup = async (label) => {
  try {
    await runCleanup();
  } catch (error) {
    cleanupRunning = false; // always release the lock so the next tick can run
    console.error(`[cleanup] ${label} failed:`, error.message);
  }
};

const startCleanupScheduler = () => {
  safeRunCleanup("Initial cleanup run");
  setInterval(() => safeRunCleanup("Scheduled cleanup"), cleanupIntervalMs);
};

module.exports = {
  runCleanup,
  startCleanupScheduler,
};
