const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { submitContact } = require("../controllers/contactController");

const router = express.Router();

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many enquiries submitted. Please wait 15 minutes before trying again." },
});

router.post("/", contactLimiter, submitContact);

module.exports = router;
