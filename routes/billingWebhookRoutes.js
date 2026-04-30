const express = require("express");
const { handleWebhook } = require("../controllers/billingController");

const router = express.Router();

router.post("/", handleWebhook);

module.exports = router;
