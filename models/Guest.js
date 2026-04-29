const mongoose = require("mongoose");

const guestSchema = new mongoose.Schema({
  name: String,
  email: String,
  selfieUrl: String,
  selfiePublicId: String,
  faceDescriptor: [Number],
  eventId: String,

  // GDPR / DPDP compliance — biometric consent audit trail.
  // consentGivenAt: exact server-side timestamp when the guest accepted the
  //   privacy disclosure. Server time is used (not client-supplied) so it is
  //   tamper-resistant and valid as an audit record.
  // consentVersion: version string of the privacy notice the guest accepted.
  //   Increment (v2, v3…) whenever the privacy policy text changes so you can
  //   tell exactly which disclosure each guest agreed to.
  consentGivenAt: {
    type: Date,
    default: null,
  },
  consentVersion: {
    type: String,
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Unique compound index: one registration per (email, event) pair.
// Prevents duplicate face descriptors that would corrupt matching results.
// The controller uses findOneAndUpdate + upsert so re-registrations update
// the existing record instead of hitting E11000.
guestSchema.index({ email: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model("Guest", guestSchema);
