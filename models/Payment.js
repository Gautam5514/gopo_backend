const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminSubscription",
      default: null,
    },
    paymentGateway: {
      type: String,
      enum: ["razorpay"],
      default: "razorpay",
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    paymentId: {
      type: String,
      default: null,
      trim: true,
    },
    signature: {
      type: String,
      default: null,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["created", "paid", "failed"],
      default: "created",
      index: true,
    },
    notes: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    rawWebhookData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
