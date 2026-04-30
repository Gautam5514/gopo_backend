const Guest = require("../models/Guest");
const Photo = require("../models/Photo");
const Match = require("../models/Match");
const DownloadLog = require("../models/DownloadLog");
const cloudinaryService = require("./cloudinaryService");

const retentionDays = Number(process.env.IMAGE_RETENTION_DAYS || 10);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_HOURS || 24) * 60 * 60 * 1000;

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

  console.log(
    `[cleanup] Done. photos=${oldPhotos.length}, guests=${oldGuests.length}, retentionDays=${retentionDays}`
  );
};

const startCleanupScheduler = () => {
  runCleanup().catch((error) => {
    console.error("[cleanup] Initial cleanup run failed:", error.message);
  });

  setInterval(() => {
    runCleanup().catch((error) => {
      console.error("[cleanup] Scheduled cleanup failed:", error.message);
    });
  }, cleanupIntervalMs);
};

module.exports = {
  runCleanup,
  startCleanupScheduler,
};
