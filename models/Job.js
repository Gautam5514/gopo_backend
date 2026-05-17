const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ["face_detection"],
            required: true,
        },
        status: {
            type: String,
            enum: ["pending", "processing", "done", "failed"],
            default: "pending",
        },
        payload: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        error: String,
        attempts: { type: Number, default: 0 },
        processingStartedAt: Date, // set when claimed; used to detect stale jobs after a crash
        nextRetryAt: Date,         // set on failure; null/absent means "ready now"
    },
    { timestamps: true }
);

// Poll query: oldest ready-to-run pending job first
jobSchema.index({ status: 1, nextRetryAt: 1, createdAt: 1 });
// Count remaining jobs per event after each job completes
jobSchema.index({ "payload.eventId": 1, status: 1 });

module.exports = mongoose.model("Job", jobSchema);
