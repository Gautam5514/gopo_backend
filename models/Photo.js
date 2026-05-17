const mongoose = require("mongoose");

const photoSchema = new mongoose.Schema({
    cloudinaryUrl: String,
    publicId: String,
    eventId: String,
    detectedFaces: [
        {
            descriptor: [Number],
            box: {
                x: Number,
                y: Number,
                width: Number,
                height: Number
            }
        }
    ],
    processed: {
        type: Boolean,
        default: false,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Matching pipeline query: "find all unprocessed photos for this event".
// Without this index every matching run scans the entire photos collection.
photoSchema.index({ eventId: 1, processed: 1 });

// triggerMatchingForEvent checks countDocuments({ eventId, cloudinaryUrl: null })
// after every job completion.  With 500 uploads this runs 500 times; without an
// index it scans all photos for the event on every check (O(n) per call → O(n²)
// total).  Also covers getEventById's pendingProcessing / failedPhotos counts.
photoSchema.index({ eventId: 1, cloudinaryUrl: 1 });

module.exports = mongoose.model("Photo", photoSchema);
