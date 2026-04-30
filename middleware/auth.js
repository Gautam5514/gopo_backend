const crypto = require("crypto");

const base64UrlEncode = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const base64UrlDecode = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
};

const getAuthSecret = () => process.env.AUTH_SECRET || "dev_auth_secret_change_me";

const signToken = (payload, expiresInSeconds = 7 * 24 * 60 * 60) => {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(tokenPayload));
  const signature = crypto
    .createHmac("sha256", getAuthSecret())
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${encodedPayload}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || !token.includes(".")) {
    throw new Error("Invalid auth token");
  }
  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", getAuthSecret())
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const actualSig = Buffer.from(signature || "");
  const expectedSig = Buffer.from(expectedSignature);
  if (
    actualSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(actualSig, expectedSig)
  ) {
    throw new Error("Invalid auth signature");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    throw new Error("Auth token expired");
  }
  return payload;
};

const authenticate = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return res.status(401).json({ error: error.message || "Invalid token" });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: "Forbidden: insufficient permissions" });
  }
  return next();
};

module.exports = {
  authenticate,
  authorize,
  signToken,
  verifyToken,
};
