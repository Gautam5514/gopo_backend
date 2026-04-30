const { rateLimit } = require("express-rate-limit");

// Matches the { error: "..." } shape used by every controller in this codebase.
const msg = (text) => ({ error: text });

// ─── Tier 1 — Global baseline ─────────────────────────────────────────────────
// Applied to all /api/* routes in index.js.
// 300 req / 15 min per IP is generous enough for normal admin + guest usage
// (page loads, gallery scrolling, file metadata fetches) while blocking crawlers
// and scripted enumeration attacks.
// The Razorpay webhook path is explicitly skipped — Razorpay does not retry on
// 429 responses, so rate-limiting it would silently drop payment confirmations.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith("/api/billing/webhook"),
  message: msg("Too many requests. Please slow down and try again later."),
});

// ─── Tier 2 — Authentication ──────────────────────────────────────────────────
// Applied to every endpoint where a credential or invite code is submitted:
// admin login, admin signup, guest login, and superadmin login.
// 10 attempts / 15 min stops brute-force and credential-stuffing attacks while
// giving a genuine user who forgot their password enough retries to recover.
// The counter is shared across all auth endpoints for the same IP — 10 login
// attempts + 10 signup attempts does not give 20 total, just 10 combined.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: msg(
    "Too many authentication attempts. Please wait 15 minutes before trying again."
  ),
});

// ─── Tier 3 — Photo upload / heavy compute ────────────────────────────────────
// Applied to POST /api/admin/upload-photos.
// Each request can carry up to 50 images; every image runs TensorFlow face
// detection + descriptor extraction on the CPU. A single IP flooding this
// endpoint would pin the server and make it unresponsive for all real users.
// 10 upload batches per minute per IP is ample for any legitimate admin session.
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: msg(
    "Upload rate limit exceeded. Please wait a moment before uploading more photos."
  ),
});

// ─── Tier 4 — Payment order creation ─────────────────────────────────────────
// Applied to POST /api/billing/create-order.
// Each call hits the Razorpay API and creates a live order record in MongoDB.
// Flooding this endpoint would exhaust the Razorpay API quota and could trigger
// Razorpay's merchant fraud detection. 5 order attempts per minute per IP
// covers every realistic billing flow while blocking automated abuse.
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: msg(
    "Too many payment requests. Please wait before creating another order."
  ),
});

// ─── Tier 5 — Guest registration ─────────────────────────────────────────────
// Applied to POST /api/guests/register.
// Each registration: uploads a selfie to Cloudinary, runs face extraction, writes
// a DB record, and sends a Resend onboarding email — all billable operations.
// Limit is set high (50 / 15 min) to accommodate event venues where hundreds of
// real guests may share the same NAT / Wi-Fi IP. Still blocks automated bulk
// registration scripts that would exhaust email quotas and storage.
const guestRegistrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: msg(
    "Too many registration attempts from this network. Please try again in 15 minutes."
  ),
});

module.exports = {
  globalLimiter,
  authLimiter,
  uploadLimiter,
  paymentLimiter,
  guestRegistrationLimiter,
};
