const SubscriptionPlan = require("../models/SubscriptionPlan");
const AdminSubscription = require("../models/AdminSubscription");
const AdminUploadUsage = require("../models/AdminUploadUsage");
const Payment = require("../models/Payment");

const DEFAULT_PLANS = [
  {
    code: "basic",
    name: "Starter",
    amount: 99900,        // ₹999/month — minimum viable margin
    currency: "INR",
    billingCycle: "monthly",
    uploadLimit: 1500,
  },
  {
    code: "pro",
    name: "Pro",
    amount: 299900,       // ₹2,999/month
    currency: "INR",
    billingCycle: "monthly",
    uploadLimit: 6000,
  },
  {
    code: "premium",
    name: "Studio",
    amount: 799900,       // ₹7,999/month
    currency: "INR",
    billingCycle: "monthly",
    uploadLimit: 20000,
  },
];

const addBillingPeriod = (startDate, billingCycle) => {
  const endDate = new Date(startDate);
  if (billingCycle === "yearly") {
    endDate.setFullYear(endDate.getFullYear() + 1);
    return endDate;
  }

  endDate.setMonth(endDate.getMonth() + 1);
  return endDate;
};

const syncDefaultPlans = async () => {
  await Promise.all(
    DEFAULT_PLANS.map((plan) =>
      SubscriptionPlan.findOneAndUpdate(
        { code: plan.code },
        { $set: plan, $setOnInsert: { isActive: true } },
        { upsert: true, returnDocument: "after" }
      )
    )
  );
};

const getActivePlans = async () => {
  await syncDefaultPlans();
  return SubscriptionPlan.find({ isActive: true }).sort({ amount: 1 }).lean();
};

const getPlanByCode = async (code) => {
  await syncDefaultPlans();
  return SubscriptionPlan.findOne({ code: String(code || "").trim().toLowerCase(), isActive: true });
};

const expireSubscriptionIfNeeded = async (subscription) => {
  if (!subscription) return null;
  if (subscription.status !== "active") return subscription;

  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd <= new Date()) {
    subscription.status = "expired";
    await subscription.save();
  }

  return subscription;
};

const getCurrentSubscription = async (adminId) => {
  let subscription = await AdminSubscription.findOne({
    adminId,
    status: { $in: ["active", "pending"] },
  })
    .populate("planId")
    .sort({ createdAt: -1 });

  subscription = await expireSubscriptionIfNeeded(subscription);
  if (!subscription || subscription.status !== "active") return null;

  let usage = await AdminUploadUsage.findOne({ subscriptionId: subscription._id });
  if (!usage) {
    usage = await AdminUploadUsage.create({
      adminId,
      subscriptionId: subscription._id,
      usedUploads: 0,
      resetDate: subscription.currentPeriodEnd || null,
    });
  }

  return { subscription, usage };
};

const assertUploadAllowed = async (adminId, uploadCount) => {
  const current = await getCurrentSubscription(adminId);
  if (!current) {
    const error = new Error("Active plan required before uploading photos.");
    error.statusCode = 402;
    throw error;
  }

  const remainingUploads = Math.max(0, current.subscription.uploadLimit - current.usage.usedUploads);
  if (uploadCount > remainingUploads) {
    const error = new Error(`Upload limit exceeded. Remaining uploads: ${remainingUploads}.`);
    error.statusCode = 402;
    throw error;
  }

  return {
    ...current,
    remainingUploads,
  };
};

const incrementUsage = async (adminId, subscriptionId, uploadCount) => {
  if (!uploadCount) return null;

  return AdminUploadUsage.findOneAndUpdate(
    { adminId, subscriptionId },
    {
      $inc: { usedUploads: uploadCount },
      $setOnInsert: { resetDate: null },
    },
    { upsert: true, returnDocument: "after" }
  );
};

const activatePlanForPayment = async ({ adminId, plan, orderId, paymentId, signature, rawWebhookData = null }) => {
  const now = new Date();
  const currentPeriodEnd = addBillingPeriod(now, plan.billingCycle);

  await AdminSubscription.updateMany(
    { adminId, status: { $in: ["active", "pending"] } },
    { $set: { status: "replaced", currentPeriodEnd: now } }
  );

  const subscription = await AdminSubscription.create({
    adminId,
    planId: plan._id,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd,
    uploadLimit: plan.uploadLimit,
  });

  await AdminUploadUsage.findOneAndUpdate(
    { subscriptionId: subscription._id },
    {
      $set: {
        adminId,
        resetDate: currentPeriodEnd,
        usedUploads: 0,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  await Payment.findOneAndUpdate(
    { orderId },
    {
      $set: {
        adminId,
        planId: plan._id,
        subscriptionId: subscription._id,
        paymentId,
        signature,
        amount: plan.amount,
        currency: plan.currency,
        status: "paid",
        rawWebhookData,
      },
    },
    { returnDocument: "after" }
  );

  return subscription.populate("planId");
};

module.exports = {
  DEFAULT_PLANS,
  syncDefaultPlans,
  getActivePlans,
  getPlanByCode,
  getCurrentSubscription,
  assertUploadAllowed,
  incrementUsage,
  activatePlanForPayment,
};
