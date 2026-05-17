const mongoose = require("mongoose");

const lockSchema = new mongoose.Schema({
    key:      { type: String, required: true, unique: true },
    owner:    { type: String, required: true },
    expireAt: { type: Date,   required: true },
});

// MongoDB TTL index: automatically deletes expired lock documents
lockSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Lock", lockSchema);
