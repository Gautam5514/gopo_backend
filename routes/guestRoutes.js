const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  registerGuest,
  getMatches,
  getMyMatches,
  downloadPhoto,
  downloadAllPhotosZip,
  deleteMyData,
} = require("../controllers/guestController");
const { authenticate, authorize } = require("../middleware/auth");
const { guestRegistrationLimiter } = require("../middleware/rateLimiter");

const upload = multer({ storage: multer.memoryStorage() });

// Limiter runs before multer so excess requests are rejected without parsing
// the multipart body or buffering the selfie image into memory.
router.post("/register", guestRegistrationLimiter, upload.single("selfie"), registerGuest);
router.get("/matches", authenticate, authorize("admin"), getMatches);
router.get("/matches/me", authenticate, getMyMatches);
router.post("/photos/:photoId/download", authenticate, authorize("user"), downloadPhoto);
router.get("/photos/download-all", authenticate, authorize("user"), downloadAllPhotosZip);

// GDPR / DPDP — right to erasure.
// Any authenticated user may delete all personal data Gopo holds about them.
router.delete("/me", authenticate, authorize("user"), deleteMyData);

module.exports = router;
