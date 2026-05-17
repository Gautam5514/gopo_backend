const cloudinary = require("cloudinary").v2;

const firstNonEmpty = (...values) => {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
};

const getCloudinaryConfig = () => ({
    cloud_name: firstNonEmpty(
        process.env.CLOUDINARY_CLOUD_NAME,
        process.env.CLOUDINARY_CLOUD,
        process.env.API_NAME
    ),
    api_key: firstNonEmpty(process.env.CLOUDINARY_API_KEY, process.env.API_KEY),
    api_secret: firstNonEmpty(process.env.CLOUDINARY_API_SECRET, process.env.API_SECRET),
});

const assertCloudinaryConfig = () => {
    const cloudinaryConfig = getCloudinaryConfig();
    if (!cloudinaryConfig.cloud_name || !cloudinaryConfig.api_key || !cloudinaryConfig.api_secret) {
        throw new Error(
            "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (or API_NAME, API_KEY, API_SECRET) in backend/.env"
        );
    }
    cloudinary.config(cloudinaryConfig);
};

// Hard limit so a hung Cloudinary connection never pins a job worker
// for the full 8-minute job timeout.  120 s is generous for even a
// large compressed photo on a slow uplink; failed uploads are retried
// automatically by the job runner (up to 3 attempts).
const UPLOAD_TIMEOUT_MS = 120_000;

exports.uploadImage = async (fileBuffer, folder = "event_photos") => {
    assertCloudinaryConfig();
    return new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`Cloudinary upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`));
        }, UPLOAD_TIMEOUT_MS);

        const stream = cloudinary.uploader.upload_stream(
            { folder, timeout: UPLOAD_TIMEOUT_MS },
            (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) return reject(error);
                resolve(result);
            }
        );

        stream.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });

        stream.end(fileBuffer);
    });
};

// 30 s — matches the upload timeout pattern already used by uploadImage.
// Without a timeout, a Cloudinary partial outage causes deleteImage to hang
// indefinitely, blocking the user-facing DELETE /api/guests/me endpoint and
// the cleanup scheduler.
const DELETE_TIMEOUT_MS = 30_000;

exports.deleteImage = async (publicId) => {
    assertCloudinaryConfig();
    return await Promise.race([
        cloudinary.uploader.destroy(publicId),
        new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error(`Cloudinary delete timed out after ${DELETE_TIMEOUT_MS / 1000}s`)),
                DELETE_TIMEOUT_MS
            )
        ),
    ]);
};

exports.extractPublicIdFromUrl = (url) => {
    if (!url || typeof url !== "string") return null;
    const marker = "/upload/";
    const markerIndex = url.indexOf(marker);
    if (markerIndex === -1) return null;

    const afterUpload = url.slice(markerIndex + marker.length);
    const parts = afterUpload.split("/").filter(Boolean);
    if (!parts.length) return null;

    // Remove version segment like "v1772274083" if present.
    const assetParts = /^v\d+$/.test(parts[0]) ? parts.slice(1) : parts;
    if (!assetParts.length) return null;

    const last = assetParts[assetParts.length - 1];
    const withoutExt = last.replace(/\.[^/.]+$/, "");
    const normalizedParts = [...assetParts.slice(0, -1), withoutExt];
    return normalizedParts.join("/");
};
