const crypto = require("crypto");
const Payment = require("../models/Payment");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const {
  getActivePlans,
  getPlanByCode,
  getCurrentSubscription,
  activatePlanForPayment,
} = require("../services/billingService");
const { createRazorpayOrder, getRazorpayConfig } = require("../config/razorpay");

const buildRazorpaySignature = ({ orderId, paymentId, secret }) =>
  crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

const buildReceipt = (adminId) => {
  const compactAdminId = String(adminId || "").slice(-8);
  const compactTime = Date.now().toString(36);
  return `adm_${compactAdminId}_${compactTime}`.slice(0, 40);
};

const sendBillingError = (res, error) => {
  // Known application errors (subscription expired, quota exceeded, gateway issues)
  // carry a statusCode and a safe user-facing message set by the service layer.
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      error: error.message,
      ...(error.gatewayStatus ? { gatewayStatus: error.gatewayStatus } : {}),
    });
  }
  console.error("Unexpected billing error:", error);
  return res.status(500).json({ error: "Billing request failed. Please try again." });
};

exports.listPlans = async (req, res) => {
  try {
    const plans = await getActivePlans();
    return res.json({
      success: true,
      plans: plans.map((plan) => ({
        id: plan._id,
        code: plan.code,
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        billingCycle: plan.billingCycle,
        uploadLimit: plan.uploadLimit,
      })),
    });
  } catch (error) {
    return sendBillingError(res, error);
  }
};

exports.getBillingStatus = async (req, res) => {
  try {
    const current = await getCurrentSubscription(req.user.userId);
    if (!current) {
      return res.json({
        success: true,
        subscription: null,
        usage: null,
      });
    }

    return res.json({
      success: true,
      subscription: {
        id: current.subscription._id,
        status: current.subscription.status,
        currentPeriodStart: current.subscription.currentPeriodStart,
        currentPeriodEnd: current.subscription.currentPeriodEnd,
        uploadLimit: current.subscription.uploadLimit,
        plan: current.subscription.planId
          ? {
              id: current.subscription.planId._id,
              code: current.subscription.planId.code,
              name: current.subscription.planId.name,
              amount: current.subscription.planId.amount,
              currency: current.subscription.planId.currency,
              billingCycle: current.subscription.planId.billingCycle,
            }
          : null,
      },
      usage: {
        usedUploads: current.usage.usedUploads,
        remainingUploads: Math.max(0, current.subscription.uploadLimit - current.usage.usedUploads),
        resetDate: current.usage.resetDate,
      },
    });
  } catch (error) {
    return sendBillingError(res, error);
  }
};

exports.createOrder = async (req, res) => {
  try {
    const plan = await getPlanByCode(req.body.planCode);
    if (!plan) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    const order = await createRazorpayOrder({
      amount: plan.amount,
      currency: plan.currency,
      receipt: buildReceipt(req.user.userId),
      notes: {
        adminId: String(req.user.userId),
        planCode: plan.code,
      },
    });

    await Payment.findOneAndUpdate(
      { orderId: order.id },
      {
        $set: {
          adminId: req.user.userId,
          planId: plan._id,
          orderId: order.id,
          amount: plan.amount,
          currency: plan.currency,
          status: "created",
          notes: order.notes || {},
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      plan: {
        code: plan.code,
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        uploadLimit: plan.uploadLimit,
        billingCycle: plan.billingCycle,
      },
      razorpayKeyId: getRazorpayConfig().keyId,
    });
  } catch (error) {
    return sendBillingError(res, error);
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ error: "Order id, payment id, and signature are required" });
    }

    const { keySecret } = getRazorpayConfig();
    const expectedSignature = buildRazorpaySignature({ orderId, paymentId, secret: keySecret });
    if (expectedSignature !== signature) {
      await Payment.findOneAndUpdate(
        { orderId },
        { $set: { paymentId, signature, status: "failed" } }
      );
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    const paymentRecord = await Payment.findOne({ orderId, adminId: req.user.userId }).populate("planId");
    if (!paymentRecord || !paymentRecord.planId) {
      return res.status(404).json({ error: "Payment record not found" });
    }

    const subscription = await activatePlanForPayment({
      adminId: req.user.userId,
      plan: paymentRecord.planId,
      orderId,
      paymentId,
      signature,
    });

    return res.json({
      success: true,
      message: "Payment verified and plan activated",
      subscription: {
        id: subscription._id,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        uploadLimit: subscription.uploadLimit,
        plan: subscription.planId
          ? {
              code: subscription.planId.code,
              name: subscription.planId.name,
              amount: subscription.planId.amount,
              currency: subscription.planId.currency,
              billingCycle: subscription.planId.billingCycle,
            }
          : null,
      },
    });
  } catch (error) {
    return sendBillingError(res, error);
  }
};

exports.handleWebhook = async (req, res) => {
  try {
    const payloadBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const payloadText = payloadBuffer.toString("utf8");
    const signature = req.headers["x-razorpay-signature"];
    const { webhookSecret } = getRazorpayConfig();

    if (!webhookSecret) {
      return res.status(500).json({ error: "RAZORPAY_WEBHOOK_SECRET is not configured" });
    }

    const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(payloadText).digest("hex");
    if (expectedSignature !== signature) {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const event = JSON.parse(payloadText);
    const eventName = event?.event;
    const paymentEntity = event?.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;

    if (eventName === "payment.captured" && orderId && paymentId) {
      const paymentRecord = await Payment.findOne({ orderId }).populate("planId");
      if (paymentRecord && paymentRecord.planId && paymentRecord.status !== "paid") {
        await activatePlanForPayment({
          adminId: paymentRecord.adminId,
          plan: paymentRecord.planId,
          orderId,
          paymentId,
          signature: null,
          rawWebhookData: event,
        });
      } else if (paymentRecord) {
        await Payment.findOneAndUpdate(
          { orderId },
          { $set: { rawWebhookData: event, paymentId, status: paymentRecord.status } }
        );
      }
    } else if (orderId) {
      await Payment.findOneAndUpdate({ orderId }, { $set: { rawWebhookData: event } });
    }

    return res.json({ success: true });
  } catch (error) {
    return sendBillingError(res, error);
  }
};
