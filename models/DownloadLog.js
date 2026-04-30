const mongoose = require("mongoose");

const downloadLogSchema = new mongoose.Schema({
  eventId: {
    type: String,
    index: true,
  },
  photoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Photo",
    index: true,
  },
  guestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Guest",
    index: true,
  },
  downloadedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model("DownloadLog", downloadLogSchema);
