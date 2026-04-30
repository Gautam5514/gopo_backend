const express = require("express");
const { login, getDashboard } = require("../controllers/superadminController");
const { authenticate, authorize } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

router.post("/login", authLimiter, login);
router.get("/dashboard", authenticate, authorize("superadmin"), getDashboard);

module.exports = router;
