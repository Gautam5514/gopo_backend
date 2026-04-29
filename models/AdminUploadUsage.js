const mongoose = require("mongoose");

const adminUploadUsageSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminSubscription",
      required: true,
      unique: true,
    },
    usedUploads: {
      type: Number,
      default: 0,
      min: 0,
    },
    resetDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminUploadUsage", adminUploadUsageSchema);
