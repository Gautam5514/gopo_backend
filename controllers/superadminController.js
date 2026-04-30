const AdminSubscription = require("../models/AdminSubscription");
const Payment = require("../models/Payment");
const User = require("../models/User");
const { signToken } = require("../middleware/auth");
const { verifyPassword } = require("../utils/passwordUtils");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const configuredEmail = normalizeEmail(process.env.SUPERADMIN_EMAIL);
    const configuredHash = String(process.env.SUPERADMIN_PASSWORD_HASH || "");

    // Both env vars must be present and non-empty — missing either is a
    // server misconfiguration, not a bad credential from the caller.
    if (!configuredEmail || !configuredHash) {
      return res.status(500).json({ error: "Superadmin credentials are not configured" });
    }

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Evaluate both checks every time so that a correct email with a wrong
    // password takes the same code path as a wrong email — prevents timing
    // enumeration of valid email addresses.
    const emailMatch = email === configuredEmail;
    const passwordMatch = verifyPassword(password, configuredHash);

    if (!emailMatch || !passwordMatch) {
      return res.status(401).json({ error: "Invalid superadmin credentials" });
    }

    const token = signToken({
      userId: "superadmin",
      email: configuredEmail,
      role: "superadmin",
      name: "Super Admin",
    });

    return res.json({
      success: true,
      token,
      user: {
        id: "superadmin",
        name: "Super Admin",
        email: configuredEmail,
        role: "superadmin",
      },
    });
  } catch (error) {
    console.error("Superadmin login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

exports.getDashboard = async (_req, res) => {
  try {
    const [subscriptions, payments, totalAdmins] = await Promise.all([
      AdminSubscription.find()
        .populate("adminId", "name email createdAt")
        .populate("planId", "name code amount currency billingCycle uploadLimit")
        .sort({ createdAt: -1 })
        .lean(),
      Payment.find({ status: "paid" })
        .populate("adminId", "name email")
        .populate("planId", "name code amount currency billingCycle uploadLimit")
        .sort({ createdAt: -1 })
        .lean(),
      User.countDocuments({ role: "admin" }),
    ]);

    const paymentBySubscriptionId = new Map();
    const revenueByAdminId = new Map();

    for (const payment of payments) {
      if (payment.subscriptionId && !paymentBySubscriptionId.has(String(payment.subscriptionId))) {
        paymentBySubscriptionId.set(String(payment.subscriptionId), payment);
      }
      const adminKey = String(payment.adminId?._id || payment.adminId || "");
      revenueByAdminId.set(adminKey, (revenueByAdminId.get(adminKey) || 0) + (payment.amount || 0));
    }

    const subscribers = subscriptions.map((subscription) => {
      const latestPayment = paymentBySubscriptionId.get(String(subscription._id));
      const admin = subscription.adminId || {};
      const plan = subscription.planId || {};
      return {
        id: subscription._id,
        adminId: admin._id || null,
        adminName: admin.name || "Unknown Admin",
        adminEmail: admin.email || "No email",
        planName: plan.name || "Unknown Plan",
        planCode: plan.code || null,
        billingCycle: plan.billingCycle || null,
        uploadLimit: subscription.uploadLimit || plan.uploadLimit || 0,
        status: subscription.status,
        startDate: subscription.currentPeriodStart,
        endDate: subscription.currentPeriodEnd,
        paidAmount: latestPayment?.amount ?? plan.amount ?? 0,
        currency: latestPayment?.currency || plan.currency || "INR",
        paymentId: latestPayment?.paymentId || null,
        orderId: latestPayment?.orderId || subscription.razorpayOrderId || null,
        createdAt: subscription.createdAt,
        lifetimeRevenue: revenueByAdminId.get(String(admin._id || "")) || 0,
      };
    });

    const activeSubscriptions = subscribers.filter((item) => item.status === "active").length;
    const totalRevenue = payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);

    return res.json({
      success: true,
      stats: {
        totalAdmins,
        totalSubscribers: subscribers.length,
        activeSubscriptions,
        totalRevenue,
      },
      subscribers,
      recentPayments: payments.slice(0, 10).map((payment) => ({
        id: payment._id,
        adminName: payment.adminId?.name || "Unknown Admin",
        adminEmail: payment.adminId?.email || "No email",
        planName: payment.planId?.name || "Unknown Plan",
        amount: payment.amount,
        currency: payment.currency,
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        paidAt: payment.updatedAt || payment.createdAt,
      })),
    });
  } catch (error) {
    console.error("Superadmin dashboard error:", error);
    return res.status(500).json({ error: "Failed to load dashboard data." });
  }
};
