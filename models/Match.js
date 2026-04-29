const mongoose = require("mongoose");

const matchSchema = new mongoose.Schema({
    photoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Photo",
    },
    guestId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Guest",
    },
    confidence: Number,
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// guestId index: gallery page loads ("find all matches for this guest") go from
// O(n) full scan to O(log n). Most-used read path in the whole app.
matchSchema.index({ guestId: 1 });

// Compound unique index prevents the matching pipeline from creating duplicate
// (photo, guest) pairs if runMatchingForEvent is called more than once.
matchSchema.index({ photoId: 1, guestId: 1 }, { unique: true });

module.exports = mongoose.model("Match", matchSchema);
