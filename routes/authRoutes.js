const express = require("express");
const multer = require("multer");
const { signup, login, guestLogin, me, updateMe } = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/guest-login", authLimiter, guestLogin);
router.get("/me", authenticate, me);
router.put("/me", authenticate, upload.single("profileImage"), updateMe);

module.exports = router;
