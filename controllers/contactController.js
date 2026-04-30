const { sendContactNotification, sendContactConfirmation } = require("../services/emailService");

const REQUIRED = ["name", "email", "message"];

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

async function submitContact(req, res) {
  const { name, email, phone, eventType, expectedGuests, message } = req.body || {};

  // Basic validation
  for (const field of REQUIRED) {
    if (!req.body?.[field] || !String(req.body[field]).trim()) {
      return res.status(400).json({ error: `${field} is required.` });
    }
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }
  if (String(message).trim().length < 10) {
    return res.status(400).json({ error: "Message must be at least 10 characters." });
  }

  const data = {
    name: String(name).trim(),
    email: String(email).trim().toLowerCase(),
    phone: String(phone || "").trim(),
    eventType: String(eventType || "").trim(),
    expectedGuests: String(expectedGuests || "").trim(),
    message: String(message).trim(),
  };

  try {
    // Fire both emails concurrently; don't let a failed confirmation block the notification
    await Promise.allSettled([
      sendContactNotification(data),
      sendContactConfirmation(data),
    ]);
  } catch {
    // Email errors are non-fatal — log server-side but still confirm to user
  }

  return res.status(200).json({ ok: true, message: "Your enquiry has been received. We'll be in touch soon." });
}

module.exports = { submitContact };
