const crypto = require("crypto");

// Produces a "saltHex:hashHex" string using scrypt (deliberately slow to
// resist offline brute-force attacks). When saltHex is supplied the same salt
// is reused — this is the verify path; when omitted a fresh random salt is
// generated — this is the hash path.
const hashPassword = (password, saltHex) => {
  const pass = String(password ?? "");
  const salt = saltHex ? Buffer.from(saltHex, "hex") : crypto.randomBytes(16);
  const hash = crypto.scryptSync(pass, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
};

// Constant-time comparison — always takes the same amount of time whether the
// password matches or not, eliminating timing-based side-channel attacks.
// Returns false for any malformed storedHash or nullish password instead of
// throwing — callers should not need to guard against exceptions.
const verifyPassword = (password, storedHash) => {
  if (password === null || password === undefined) return false;
  const [saltHex, hashHex] = String(storedHash || "").split(":");
  if (!saltHex || !hashHex) return false;
  const actual = Buffer.from(hashHex, "hex");
  const expected = Buffer.from(hashPassword(String(password), saltHex).split(":")[1], "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

module.exports = { hashPassword, verifyPassword };
