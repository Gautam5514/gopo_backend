const express = require("express");
const { authenticate, authorize } = require("../middleware/auth");
const { paymentLimiter } = require("../middleware/rateLimiter");
const {
  listPlans,
  getBillingStatus,
  createOrder,
  verifyPayment,
} = require("../controllers/billingController");

const router = express.Router();

router.get("/plans", authenticate, authorize("admin"), listPlans);
router.get("/status", authenticate, authorize("admin"), getBillingStatus);
router.post("/create-order", paymentLimiter, authenticate, authorize("admin"), createOrder);
router.post("/verify-payment", authenticate, authorize("admin"), verifyPayment);

module.exports = router;
