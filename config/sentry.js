const Sentry = require("@sentry/node");

// Sentry is optional. When SENTRY_DSN is absent the app behaves exactly as
// before — no performance hit, no startup error.  Set the variable to your
// project DSN (found in Sentry → Project Settings → Client Keys) to enable
// real-time error tracking, performance traces, and MongoDB query spans.
const init = () => {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    console.warn("⚠️  SENTRY_DSN not set — error tracking disabled (set it to enable Sentry)");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",

    // Capture 100 % of transactions in dev so you see every trace.
    // Drop to 10–20 % in production to stay within free-tier limits.
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Automatically create spans for every Mongoose query so slow DB calls
    // appear in Sentry performance traces with their full query details.
    integrations: [Sentry.mongooseIntegration()],
  });

  console.log("✅ Sentry error tracking initialised");
};

module.exports = { Sentry, init };
