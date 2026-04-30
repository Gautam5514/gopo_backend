const crypto = require("crypto");
const User = require("../models/User");
const Guest = require("../models/Guest");
const cloudinaryService = require("../services/cloudinaryService");
const { signToken } = require("../middleware/auth");
const { hashPassword, verifyPassword } = require("../utils/passwordUtils");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const buildAuthResponse = (user) => {
  const token = signToken({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
    name: user.name,
  });
  return {
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImageUrl: user.profileImageUrl || "",
    },
  };
};

exports.signup = async (req, res) => {
  try {
    const { name, email, password, inviteCode } = req.body;
    const normalizedEmail = normalizeEmail(email);
    if (!name || !normalizedEmail || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Role is never accepted from the client — determined solely by invite code
    let requestedRole = "user";
    const rawInviteCode = String(inviteCode || "").trim();

    if (rawInviteCode.length > 200) {
      return res.status(400).json({ error: "Invalid invite code" });
    }

    if (rawInviteCode) {
      const validCodes = (process.env.ADMIN_INVITE_CODE || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      // Treat missing env config the same as a wrong code — no information leak
      if (!validCodes.length || !validCodes.includes(rawInviteCode)) {
        return res.status(403).json({ error: "Invalid invite code" });
      }

      requestedRole = "admin";
    }

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: "User already exists with this email" });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      role: requestedRole,
    });

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      ...buildAuthResponse(user),
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Failed to create account" });
  }
};

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await User.findOne({ email });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    return res.json({
      success: true,
      message: "Login successful",
      ...buildAuthResponse(user),
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Failed to login" });
  }
};

exports.guestLogin = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const guest = await Guest.findOne({ email });
    if (!guest) {
      return res.status(404).json({ error: "Guest not found. Please register first." });
    }

    let user = await User.findOne({ email });
    if (user && user.role !== "user") {
      return res.status(403).json({ error: "Use admin login for this account" });
    }

    if (!user) {
      user = await User.create({
        name: guest.name || "Guest",
        email,
        passwordHash: hashPassword(crypto.randomBytes(24).toString("hex")),
        role: "user",
      });
    }

    return res.json({
      success: true,
      message: "Guest login successful",
      ...buildAuthResponse(user),
    });
  } catch (error) {
    console.error("Guest login error:", error);
    return res.status(500).json({ error: "Failed to login guest" });
  }
};

exports.me = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("_id name email role profileImageUrl");
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch user profile" });
  }
};

exports.updateMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const nextName = String(req.body.name || "").trim();
    if (!nextName) {
      return res.status(400).json({ error: "Name is required" });
    }

    user.name = nextName;

    if (req.file) {
      if (!req.file.mimetype?.startsWith("image/")) {
        return res.status(400).json({ error: "Profile image must be an image file" });
      }

      const previousPublicId = user.profileImagePublicId;
      const uploadResult = await cloudinaryService.uploadImage(req.file.buffer, "admin_profiles");
      user.profileImageUrl = uploadResult.secure_url;
      user.profileImagePublicId = uploadResult.public_id;

      if (previousPublicId) {
        cloudinaryService.deleteImage(previousPublicId).catch((error) => {
          console.error("Profile image cleanup failed:", error.message);
        });
      }
    }

    await user.save();

    return res.json({
      success: true,
      message: "Profile updated successfully",
      ...buildAuthResponse(user),
    });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ error: "Failed to update profile" });
  }
};
