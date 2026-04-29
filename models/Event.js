const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  name: String,
  code: {
    type: String,
    unique: true,   // prevents duplicate event codes; query O(1) instead of O(n)
    index: true,
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Event", eventSchema);
