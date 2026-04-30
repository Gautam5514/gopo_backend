const express = require("express");
const router = express.Router();
const os = require("os");
const path = require("path");
const multer = require("multer");
const { uploadPhotos, startMatching, getDownloadStats, getDashboardStats, getEvents, createEvent, getEventById } = require("../controllers/adminController");
const { authenticate, authorize } = require("../middleware/auth");
const { uploadLimiter } = require("../middleware/rateLimiter");

// Write incoming files directly to disk so Node never holds hundreds of MB of
// photo buffers in memory at the same time. The job runner reads each temp
// file from disk, processes it, and deletes it when done.
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, os.tmpdir()),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || ".jpg";
            cb(null, `gopo-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        },
    }),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB — enough for a 1600 px compressed photo
        files: 300,
    },
});

router.post("/upload-photos", uploadLimiter, authenticate, authorize("admin"), upload.array("photos", 300), uploadPhotos);
router.post("/start-matching", authenticate, authorize("admin"), startMatching);
router.get("/download-stats", authenticate, authorize("admin"), getDownloadStats);

router.get("/dashboard-stats", authenticate, authorize("admin"), getDashboardStats);
router.get("/events", authenticate, authorize("admin"), getEvents);
router.post("/events", authenticate, authorize("admin"), createEvent);
router.get("/events/:id", authenticate, authorize("admin"), getEventById);

module.exports = router;
