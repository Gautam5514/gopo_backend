const { Resend } = require("resend");

const resend   = new Resend(process.env.RESEND_API_KEY);
const APP_NAME = "Gopo";

// ─── Company branding ─────────────────────────────────────────────────────────
// Update COMPANY_LOGO_URL to the publicly accessible path of your logo image.
const COMPANY_URL      = "https://www.hellobj.me";
const COMPANY_LOGO_URL = "https://www.hellobj.me/logo.png";

const blockedSenderDomains = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
]);

// ─── Shared helpers ───────────────────────────────────────────────────────────

const getEnvValue = (key) => String(process.env[key] || "").trim();

const formatFromEmail = (emailAddress) => {
  const fromName = getEnvValue("RESEND_FROM_NAME");
  return fromName ? `${fromName} <${emailAddress}>` : emailAddress;
};

const buildAppUrl = (path = "") => {
  const base = getEnvValue("FRONTEND_URL") || "http://localhost:3000";
  return `${base}${path}`;
};

const buildGuestLoginUrl = (email) => {
  const params = new URLSearchParams({ email: String(email || "").trim() });
  return buildAppUrl(`/login?${params.toString()}`);
};

const getConfiguredFromEmail = () => {
  const from = getEnvValue("RESEND_FROM_EMAIL");
  if (!from) throw new Error("Missing RESEND_FROM_EMAIL in backend .env");

  const match = from.match(/<([^>]+)>$/);
  const emailAddress = (match ? match[1] : from).trim().toLowerCase();
  const domain = emailAddress.split("@")[1];
  if (!domain) throw new Error("RESEND_FROM_EMAIL must be a valid email address");

  if (blockedSenderDomains.has(domain)) {
    throw new Error(
      `RESEND_FROM_EMAIL uses ${domain}, which Resend will reject unless you verify that domain.`
    );
  }
  return formatFromEmail(emailAddress);
};

const validateEmailConfiguration = () => {
  if (!getEnvValue("RESEND_API_KEY")) {
    return { ok: false, message: "Missing RESEND_API_KEY in backend .env" };
  }
  try {
    const from = getConfiguredFromEmail();
    return { ok: true, from, frontendUrl: getEnvValue("FRONTEND_URL") || "http://localhost:3000" };
  } catch (error) {
    return { ok: false, message: error.message };
  }
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ─── Core send ────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, text }) {
  const config = validateEmailConfiguration();
  if (!config.ok) throw new Error(config.message);

  const response = await resend.emails.send({
    from: getConfiguredFromEmail(),
    to,
    subject,
    html,
    text,
  });

  if (response?.error) {
    throw new Error(
      response.error.message || response.error.name || "Email provider rejected the request"
    );
  }
  return response?.data || response;
}

// ─── Shared HTML shell ────────────────────────────────────────────────────────
// Table-based layout ensures compatibility with Gmail, Apple Mail, Outlook.

const emailShell = (bodyHtml, accentColor = "#0a0a0a") => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${APP_NAME}</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:48px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">

          <!-- Header: Logo + Brand -->
          <tr>
            <td style="background:${accentColor};padding:36px 40px 28px;border-radius:18px 18px 0 0;text-align:center;">
              <!-- Company logo — make sure https://www.hellobj.me/logo.png is publicly accessible -->
              <a href="${COMPANY_URL}" target="_blank" style="display:inline-block;margin-bottom:18px;text-decoration:none;">
                <img src="${COMPANY_LOGO_URL}"
                     alt="${APP_NAME}"
                     width="90"
                     style="display:block;margin:0 auto;border:0;outline:none;max-width:90px;"
                     onerror="this.style.display='none'" />
              </a>
              <div style="font-size:26px;font-weight:800;color:#ffffff;letter-spacing:-0.8px;line-height:1;">
                ${APP_NAME}
              </div>
              <div style="font-size:11px;font-weight:500;color:#71717a;letter-spacing:0.18em;text-transform:uppercase;margin-top:6px;">
                Smart Photo Delivery
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:44px 44px 40px;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;padding:28px 44px;border-top:1px solid #ebebeb;border-radius:0 0 18px 18px;text-align:center;">
              <p style="margin:0 0 10px;font-size:13px;color:#374151;font-weight:600;">
                Powered by
                <a href="${COMPANY_URL}" target="_blank"
                   style="color:#0a0a0a;text-decoration:none;border-bottom:1px solid #d1d5db;">
                  www.hellobj.me
                </a>
              </p>
              <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.9;">
                Your selfie and face data are automatically and permanently deleted<br>
                10&nbsp;days after the event — no exceptions.<br>
                You received this because you registered for an event powered by ${APP_NAME}.<br>
                &copy; 2026 Hellobj &nbsp;&middot;&nbsp; ${APP_NAME}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// Gmail-safe CTA button using a table so background colour renders in all clients.
const ctaButton = (url, label, bg = "#0a0a0a") => `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:36px 0 4px;">
  <tr>
    <td align="center">
      <a href="${url}" target="_blank"
         style="display:inline-block;background:${bg};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:16px 44px;border-radius:10px;letter-spacing:0.3px;line-height:1;">
        ${label}
      </a>
    </td>
  </tr>
</table>`;

// Thin decorative divider
const divider = `<hr style="border:none;border-top:1px solid #f0f0f0;margin:32px 0;">`;

// ─── Email 1 — Guest registration / onboarding ────────────────────────────────

async function sendGuestOnboardingEmail(to, guestName, eventCode, eventName) {
  const displayEvent = esc(eventName || eventCode || "your event");
  const safeGuest    = esc(guestName);
  const galleryUrl   = buildGuestLoginUrl(to);

  const html = emailShell(`
    <!-- Hero headline -->
    <h1 style="margin:0 0 6px;font-size:30px;font-weight:800;color:#0a0a0a;letter-spacing:-0.8px;line-height:1.15;">
      You&rsquo;re in the frame,<br>${safeGuest}.
    </h1>
    <p style="margin:0 0 10px;font-size:16px;color:#6b7280;line-height:1.7;">
      Welcome to <strong style="color:#0a0a0a;">${displayEvent}</strong>. Your seat at the gallery is reserved.
    </p>

    <!-- Event badge -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background:linear-gradient(135deg,#0a0a0a 0%,#27272a 100%);border-radius:12px;padding:22px 28px;">
          <p style="margin:0;font-size:11px;font-weight:600;color:#71717a;letter-spacing:0.14em;text-transform:uppercase;">Event</p>
          <p style="margin:6px 0 0;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.4px;">
            ${displayEvent}
          </p>
        </td>
      </tr>
    </table>

    <!-- Intro copy -->
    <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.8;">
      Great photography deserves a great experience. With <strong>${APP_NAME}</strong>,
      you don&rsquo;t hunt through hundreds of photos. Our AI finds the ones
      <em>you</em> appear in &mdash; and delivers them straight to your inbox.
      No app. No account. Just your email.
    </p>

    ${divider}

    <!-- How it works -->
    <p style="margin:0 0 16px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;">
      How it works
    </p>

    <!-- Step 1 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #0a0a0a;border-radius:0 10px 10px 0;padding:18px 22px;">
          <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;">Step 01</p>
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0a0a0a;">The photographer works the room</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            Every candid, every portrait, every moment &mdash; the photographer captures it all throughout your event.
          </p>
        </td>
      </tr>
    </table>

    <!-- Step 2 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #0a0a0a;border-radius:0 10px 10px 0;padding:18px 22px;">
          <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;">Step 02</p>
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0a0a0a;">Our AI scans every face in every photo</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            Powered by precision face recognition, ${APP_NAME} matches your selfie against the entire collection in seconds &mdash; automatically.
          </p>
        </td>
      </tr>
    </table>

    <!-- Step 3 -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #0a0a0a;border-radius:0 10px 10px 0;padding:18px 22px;">
          <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:0.12em;text-transform:uppercase;">Step 03</p>
          <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0a0a0a;">Your personal gallery lands in your inbox</p>
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            We email you the moment your photos are ready. One click opens your private gallery. Download in full resolution &mdash; free.
          </p>
        </td>
      </tr>
    </table>

    ${divider}

    <!-- Preview CTA -->
    <p style="margin:0 0 4px;text-align:center;font-size:15px;font-weight:600;color:#0a0a0a;">
      Your gallery is waiting
    </p>
    <p style="margin:0;text-align:center;font-size:13px;color:#6b7280;">
      Photos will appear here automatically once the event wraps up.
    </p>

    ${ctaButton(galleryUrl, "Open My Gallery")}

    <p style="text-align:center;font-size:12px;color:#9ca3af;margin:14px 0 0;line-height:1.7;">
      Sign in with your email &nbsp;&middot;&nbsp;
      <strong style="color:#374151;">${esc(to)}</strong>
    </p>

    ${divider}

    <!-- Brand sign-off -->
    <p style="margin:0;text-align:center;font-size:13px;color:#6b7280;line-height:1.8;">
      Questions? Visit us at
      <a href="${COMPANY_URL}" target="_blank" style="color:#0a0a0a;font-weight:600;text-decoration:none;">
        www.hellobj.me
      </a>
    </p>
  `);

  const text = [
    `Hi ${guestName} — you're registered for ${eventName || eventCode || "your event"}.`,
    "",
    "Here's how Gopo works:",
    "1. The photographer captures every moment at the event.",
    "2. Our AI matches your selfie to every photo you appear in.",
    "3. You receive a personal gallery link — no app, just your email.",
    "",
    `Open your gallery: ${galleryUrl}`,
    `Sign in with: ${to}`,
    "",
    "Your face data is permanently deleted 10 days after the event.",
    "",
    `Powered by Hellobj — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `You're registered for ${eventName || eventCode || "the event"} — ${APP_NAME}`,
    html,
    text,
  });
}

// ─── Email 2 — Photos matched and ready to download ───────────────────────────

async function sendPhotoReadyEmail(to, guestName, loginUrl, { eventName, matchCount } = {}) {
  const safeGuest    = esc(guestName);
  const displayEvent = esc(eventName || "your event");
  const count        = Number(matchCount) || 0;
  const photoLabel   = count === 1 ? "photo" : "photos";

  const html = emailShell(`
    <!-- Hero -->
    <h1 style="margin:0 0 8px;font-size:30px;font-weight:800;color:#0a0a0a;letter-spacing:-0.8px;line-height:1.2;">
      The lens found you,<br>${safeGuest}.
    </h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.8;">
      Your ${photoLabel} from <strong style="color:#0a0a0a;">${displayEvent}</strong> have
      been matched and are waiting in your private gallery.
    </p>

    <!-- Photo count hero card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="background:#0a0a0a;border-radius:14px;padding:36px 28px;text-align:center;">
          <p style="margin:0;font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;">
            ${count}
          </p>
          <p style="margin:10px 0 0;font-size:13px;font-weight:600;color:#71717a;letter-spacing:0.14em;text-transform:uppercase;">
            ${photoLabel} matched to your face
          </p>
          <p style="margin:16px auto 0;font-size:13px;color:#52525b;max-width:320px;line-height:1.7;">
            Every one of them is a moment from <strong style="color:#a1a1aa;">${displayEvent}</strong>
            — captured, found, and curated just for you.
          </p>
        </td>
      </tr>
    </table>

    <!-- Emotional copy -->
    <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.8;">
      Great photographers don&rsquo;t just take pictures &mdash; they preserve the feeling
      of a moment forever. <strong>${APP_NAME}</strong> makes sure those moments reach the
      right person. That person is you.
    </p>

    <!-- CTA -->
    ${ctaButton(loginUrl, `View My ${count === 1 ? "Photo" : `${count} Photos`} &rarr;`)}

    <p style="text-align:center;font-size:12px;color:#9ca3af;margin:14px 0 28px;line-height:1.8;">
      Sign in with your email &nbsp;&middot;&nbsp;
      <strong style="color:#374151;">${esc(to)}</strong>
    </p>

    ${divider}

    <!-- Urgency notice -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="background:#fff8f0;border:1px solid #fed7aa;border-radius:10px;padding:18px 22px;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#9a3412;margin-bottom:4px;">
            &#9203; Download before they&rsquo;re gone
          </p>
          <p style="margin:0;font-size:13px;color:#c2410c;line-height:1.7;">
            Your photos and face data are permanently and automatically deleted
            <strong>10&nbsp;days after the event</strong>.
            Save your favourites to your device today.
          </p>
        </td>
      </tr>
    </table>

    <!-- What you can do -->
    <p style="margin:0 0 14px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;">
      In your gallery you can
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="33%" style="text-align:center;padding:16px 8px;background:#fafafa;border:1px solid #f0f0f0;border-radius:10px;">
          <p style="margin:0;font-size:20px;">&#128444;</p>
          <p style="margin:6px 0 0;font-size:12px;font-weight:600;color:#374151;">View all photos</p>
        </td>
        <td width="4%"></td>
        <td width="33%" style="text-align:center;padding:16px 8px;background:#fafafa;border:1px solid #f0f0f0;border-radius:10px;">
          <p style="margin:0;font-size:20px;">&#11015;</p>
          <p style="margin:6px 0 0;font-size:12px;font-weight:600;color:#374151;">Download full-res</p>
        </td>
        <td width="4%"></td>
        <td width="33%" style="text-align:center;padding:16px 8px;background:#fafafa;border:1px solid #f0f0f0;border-radius:10px;">
          <p style="margin:0;font-size:20px;">&#128230;</p>
          <p style="margin:6px 0 0;font-size:12px;font-weight:600;color:#374151;">Download as ZIP</p>
        </td>
      </tr>
    </table>

    ${divider}

    <p style="margin:0;text-align:center;font-size:13px;color:#6b7280;line-height:1.8;">
      Powered by
      <a href="${COMPANY_URL}" target="_blank" style="color:#0a0a0a;font-weight:700;text-decoration:none;">
        Hellobj
      </a>
      &nbsp;&middot;&nbsp; Questions? Visit
      <a href="${COMPANY_URL}" target="_blank" style="color:#0a0a0a;font-weight:600;text-decoration:none;">
        www.hellobj.me
      </a>
    </p>
  `);

  const text = [
    `Hi ${guestName} — the lens found you.`,
    "",
    `${count} ${photoLabel} from ${eventName || "your event"} have been matched to your face.`,
    "",
    `View and download your gallery: ${loginUrl}`,
    `Sign in with: ${to}`,
    "",
    "⚠️  Download soon — your photos are permanently deleted 10 days after the event.",
    "",
    `Powered by Hellobj — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `${count} ${photoLabel} from ${eventName || "your event"} — ready for you`,
    html,
    text,
  });
}

// ─── Email 3 — Photos uploaded, matching in progress ─────────────────────────

async function sendPhotosUploadedEmail(to, guestName, eventCode, eventName) {
  const safeGuest    = esc(guestName);
  const displayEvent = esc(eventName || eventCode || "your event");
  const galleryUrl   = buildGuestLoginUrl(to);

  const html = emailShell(`
    <!-- Hero -->
    <h1 style="margin:0 0 8px;font-size:30px;font-weight:800;color:#0a0a0a;letter-spacing:-0.8px;line-height:1.2;">
      The shutter clicked.<br>Now the magic begins.
    </h1>
    <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.8;">
      Hi <strong style="color:#0a0a0a;">${safeGuest}</strong> &mdash; fresh photos from
      <strong style="color:#0a0a0a;">${displayEvent}</strong> have just been uploaded.
      Our AI is scanning every frame right now.
    </p>

    <!-- Status card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="background:#0a0a0a;border-radius:14px;padding:28px;text-align:center;">
          <p style="margin:0;font-size:32px;line-height:1;">&#128247;</p>
          <p style="margin:14px 0 6px;font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
            Face matching in progress
          </p>
          <p style="margin:0;font-size:13px;color:#71717a;line-height:1.7;max-width:300px;margin:8px auto 0;">
            Our AI is scanning every photo from ${displayEvent} and finding the ones you appear in. This usually takes just a few minutes.
          </p>
        </td>
      </tr>
    </table>

    <!-- What happens next -->
    <p style="margin:0 0 14px;font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#9ca3af;">
      What happens next
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #22c55e;border-radius:0 10px 10px 0;padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            <strong style="color:#0a0a0a;">&#10003; Photos uploaded.</strong>
            The photographer&rsquo;s work is in the system.
          </p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #f59e0b;border-radius:0 10px 10px 0;padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            <strong style="color:#0a0a0a;">&#8987; AI is matching faces now.</strong>
            We&rsquo;re finding every photo you appear in, automatically.
          </p>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="background:#fafafa;border:1px solid #f0f0f0;border-left:3px solid #d1d5db;border-radius:0 10px 10px 0;padding:16px 20px;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
            <strong style="color:#9ca3af;">&#9993; Your gallery email is on its way.</strong>
            We&rsquo;ll notify you the moment your photos are ready to view and download.
          </p>
        </td>
      </tr>
    </table>

    ${ctaButton(galleryUrl, "Open Gallery Login")}

    <p style="text-align:center;font-size:12px;color:#9ca3af;margin:14px 0 28px;line-height:1.7;">
      Sign in with &nbsp;&middot;&nbsp;
      <strong style="color:#374151;">${esc(to)}</strong>
    </p>

    ${divider}

    <p style="margin:0;text-align:center;font-size:13px;color:#6b7280;line-height:1.8;">
      Questions? Visit
      <a href="${COMPANY_URL}" target="_blank" style="color:#0a0a0a;font-weight:700;text-decoration:none;">
        www.hellobj.me
      </a>
    </p>
  `);

  const text = [
    `Hi ${guestName} — photos from ${displayEvent} have just been uploaded.`,
    "",
    "Our AI is scanning every photo and matching faces right now.",
    "We'll email you the moment your personal gallery is ready.",
    "",
    `Gallery login: ${galleryUrl}`,
    `Sign in with: ${to}`,
    "",
    `Powered by Hellobj — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `Your photos from ${eventName || eventCode || "the event"} are being matched — ${APP_NAME}`,
    html,
    text,
  });
}

// ─── Contact form ─────────────────────────────────────────────────────────────

async function sendContactNotification({ name, email, phone, eventType, expectedGuests, message }) {
  const notifyTo = process.env.CONTACT_NOTIFICATION_EMAIL || process.env.RESEND_FROM_EMAIL;
  if (!notifyTo) return;

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;width:140px;font-size:13px;font-weight:600;color:#6b7280;vertical-align:top;">${esc(label)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111827;vertical-align:top;">${esc(value || "—")}</td>
    </tr>`;

  const bodyHtml = `
    <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">New Contact Enquiry</h2>
    <p style="margin:0 0 28px;font-size:14px;color:#6b7280;">Someone filled the contact form on the Gopo website.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row("Name", name)}
      ${row("Email", email)}
      ${row("Phone", phone)}
      ${row("Event Type", eventType)}
      ${row("Expected Guests", expectedGuests)}
      ${row("Message", message)}
    </table>
    <p style="margin:28px 0 0;font-size:13px;color:#9ca3af;">Reply directly to ${esc(email)} to get in touch.</p>`;

  const text = [
    "New Contact Enquiry — Gopo",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || "—"}`,
    `Event Type: ${eventType || "—"}`,
    `Expected Guests: ${expectedGuests || "—"}`,
    `Message: ${message}`,
  ].join("\n");

  return sendEmail({ to: notifyTo, subject: `New Enquiry from ${name} — Gopo Contact`, html: emailShell(bodyHtml), text });
}

async function sendContactConfirmation({ name, email }) {
  const bodyHtml = `
    <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;">We got your message, ${esc(name)}.</h2>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.8;color:#374151;">
      Thank you for reaching out to Gopo. Our team will review your enquiry and
      get back to you personally — usually within 24 hours.
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.8;color:#374151;">
      While you wait, you can explore how Gopo delivers AI-powered photo experiences
      for weddings, corporate events, college fests, and more.
    </p>
    ${ctaButton(buildAppUrl("/how-it-works"), "See How It Works")}
    <p style="margin:32px 0 0;font-size:13px;color:#9ca3af;">
      If your enquiry is urgent, reply directly to this email and we'll prioritise it.
    </p>`;

  const text = [
    `Hi ${name},`,
    "",
    "We received your message — thank you for reaching out to Gopo.",
    "Our team will review your enquiry and get back to you within 24 hours.",
    "",
    `Visit: ${buildAppUrl("/how-it-works")}`,
    "",
    `Powered by Gopo — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({ to: email, subject: `We received your message — ${APP_NAME}`, html: emailShell(bodyHtml), text });
}

module.exports = {
  buildAppUrl,
  buildGuestLoginUrl,
  sendEmail,
  sendGuestOnboardingEmail,
  sendPhotosUploadedEmail,
  sendPhotoReadyEmail,
  sendContactNotification,
  sendContactConfirmation,
  validateEmailConfiguration,
};
