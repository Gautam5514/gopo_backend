
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });


const { Sentry, init: initSentry } = require("./config/sentry");
initSentry();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { startCleanupScheduler } = require("./services/cleanupService");
const { syncDefaultPlans } = require("./services/billingService");
const { validateEmailConfiguration } = require("./services/emailService");
const { globalLimiter } = require("./middleware/rateLimiter");
const { startJobRunner, stopJobRunner } = require("./workers/jobRunner");



const app = express();

// When deployed behind Nginx, Railway, Render, or any reverse proxy, req.ip
// would otherwise reflect the proxy IP instead of the real client IP, making
// every user share the same rate-limit counter. Trust exactly one proxy hop.
app.set("trust proxy", 1);



mongoose.set("bufferCommands", false);



const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools (curl, Postman) and configured web origins.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.use("/api/billing/webhook", express.raw({ type: "application/json" }), require("./routes/billingWebhookRoutes"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const requireDatabaseConnection = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: "Database is not connected. Start MongoDB or check MONGO_URI in backend/.env.",
    });
  }
  return next();
};



app.use("/api", globalLimiter);
// Contact route only needs Resend (no DB), so register before requireDatabaseConnection.
app.use("/api/contact", require("./routes/contactRoutes"));
app.use("/api", requireDatabaseConnection);
app.use("/api/guests", require("./routes/guestRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/billing", require("./routes/billingRoutes"));
app.use("/api/superadmin", require("./routes/superadminRoutes"));



app.get("/", (req, res) => {
  res.send("🚀 API Running");
});



Sentry.setupExpressErrorHandler(app);



app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});



app.use((err, req, res, next) => {
  // Sentry has already captured the error above; just log + respond.
  console.error(err.stack);
  res.status(500).json({ message: "Server error" });
});


const PORT = process.env.PORT || 5000;

let server;

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // Fail fast if the Atlas cluster is unreachable at startup
      serverSelectionTimeoutMS: 10_000,
      // Keep the TCP socket alive so Atlas's monitor connection
      // doesn't get silently dropped after the long ONNX inference pauses.
      socketTimeoutMS:          90_000,
      // Ping the primary every 10 s so we detect failovers quickly.
      heartbeatFrequencyMS:     10_000,
      // Allow Mongoose to retry a failed write once after a transient error.
      retryWrites:              true,
      retryReads:               true,
      // 15 connections covers: job worker (2), matching pipeline (3), and
      // ~10 concurrent HTTP requests (gallery loads, downloads, registrations).
      // Atlas M0 (free) supports up to ~100 simultaneous connections total.
      maxPoolSize:              15,
      minPoolSize:              2,
    });
    console.log("✅ MongoDB Connected");
  } catch (err) {
    console.error("❌ MongoDB Error:", err.message);
    console.error("⚠️ Server will continue running, but database operations will fail until MongoDB is reachable.");
  }

  server = app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
    const emailConfig = validateEmailConfiguration();
    if (emailConfig.ok) {
      console.log(`📧 Email sender configured: ${emailConfig.from}`);
    } else {
      console.warn(`⚠️ Email configuration issue: ${emailConfig.message}`);
    }

    if (mongoose.connection.readyState === 1) {
      startCleanupScheduler();
      startJobRunner().catch((err) => console.error("Job runner failed to start:", err.message));
      syncDefaultPlans().catch((error) => {
        console.error("Failed to sync billing plans:", error.message);
      });
    }
  });
};

const shutdown = async (signal) => {
  console.log(`\n${signal} received — shutting down gracefully`);
  await stopJobRunner();

  // Stop accepting new connections; finish in-flight requests first.
  if (server) {
    server.close(() => {
      mongoose.connection
        .close(false)
        .then(() => {
          console.log("MongoDB connection closed. Exiting.");
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
  } else {
    process.exit(0);
  }

  // Force exit after 15 s if requests are still hanging.
  // unref() prevents this timer from keeping the process alive on its own.
  setTimeout(() => {
    console.error("Graceful shutdown timed out — forcing exit.");
    process.exit(1);
  }, 15_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

startServer();
