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

exports.uploadImage = async (fileBuffer, folder = "event_photos") => {
    assertCloudinaryConfig();
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
            { folder },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        ).end(fileBuffer);
    });
};

exports.deleteImage = async (publicId) => {
    assertCloudinaryConfig();
    return await cloudinary.uploader.destroy(publicId);
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
