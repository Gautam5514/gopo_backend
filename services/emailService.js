const { Resend } = require("resend");

const resend   = new Resend(process.env.RESEND_API_KEY);
const APP_NAME = "Gopo";
const COMPANY_URL      = "https://www.hellobj.me";
const COMPANY_LOGO_URL = "https://www.hellobj.me/logo.png";

const blockedSenderDomains = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
]);

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

async function sendEmail({ to, subject, html, text, replyTo }) {
  const config = validateEmailConfiguration();
  if (!config.ok) throw new Error(config.message);

  const payload = {
    from: getConfiguredFromEmail(),
    to,
    subject,
    html,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;

  const response = await resend.emails.send(payload);

  if (response?.error) {
    throw new Error(
      response.error.message || response.error.name || "Email provider rejected the request"
    );
  }
  return response?.data || response;
}

// ─── Premium email shell ──────────────────────────────────────────────────────
// Hidden preheader trick: renders as inbox snippet in Gmail / Apple Mail.
const preheaderSpan = (text) =>
  `<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(text)}&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;</span>`;

const emailShell = (bodyHtml, preheader = "") => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${APP_NAME}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

  ${preheader ? preheaderSpan(preheader) : ""}

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:40px 16px 48px;">

        <!-- Card container -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

          <!-- ── Header ── -->
          <tr>
            <td style="background:#09090b;padding:32px 40px;border-radius:16px 16px 0 0;text-align:center;border-bottom:1px solid #27272a;">

              <!-- Logo mark -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;">
                <tr>
                  <td style="width:52px;height:52px;background:#ffffff;border-radius:14px;text-align:center;vertical-align:middle;">
                    <a href="${COMPANY_URL}" target="_blank" style="text-decoration:none;display:block;line-height:52px;">
                      <img src="${COMPANY_LOGO_URL}"
                           alt="${APP_NAME}"
                           width="36"
                           style="display:inline-block;border:0;vertical-align:middle;max-width:36px;"
                           onerror="this.parentElement.innerHTML='<span style=&quot;font-size:22px;font-weight:900;color:#09090b;line-height:52px;&quot;>G</span>'" />
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Brand name -->
              <p style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;line-height:1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
                ${APP_NAME}
              </p>
              <p style="margin:6px 0 0;font-size:11px;font-weight:500;color:#52525b;letter-spacing:0.2em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
                AI&#8202;&#183;&#8202;Photo&#8202;&#183;&#8202;Delivery
              </p>
            </td>
          </tr>

          <!-- ── Body ── -->
          <tr>
            <td style="background:#ffffff;padding:48px 48px 44px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- ── Footer ── -->
          <tr>
            <td style="background:#f8fafc;padding:28px 48px 32px;border-top:1px solid #e2e8f0;border-radius:0 0 16px 16px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

              <!-- Footer links -->
              <p style="margin:0 0 10px;font-size:12px;color:#94a3b8;">
                <a href="${COMPANY_URL}" target="_blank" style="color:#64748b;text-decoration:none;font-weight:600;">${APP_NAME}</a>
                &nbsp;&nbsp;&#183;&nbsp;&nbsp;
                <a href="${COMPANY_URL}/privacy" target="_blank" style="color:#94a3b8;text-decoration:none;">Privacy</a>
                &nbsp;&nbsp;&#183;&nbsp;&nbsp;
                <a href="${COMPANY_URL}" target="_blank" style="color:#94a3b8;text-decoration:none;">Help</a>
              </p>

              <!-- Data deletion notice -->
              <p style="margin:0 0 10px;font-size:11px;color:#94a3b8;line-height:1.8;">
                Your selfie and face data are permanently deleted 10&nbsp;days after the event.
              </p>

              <!-- Copyright -->
              <p style="margin:0;font-size:11px;color:#cbd5e1;">
                &copy; 2026 Hellobj Technologies &nbsp;&#183;&nbsp; facedeliver.shop
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// ─── Shared components ────────────────────────────────────────────────────────

const ctaButton = (url, label) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:36px 0 0;">
  <tr>
    <td align="center">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
        href="${url}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="15%" fillcolor="#09090b">
        <w:anchorlock/>
        <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:700;">${label}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="${url}" target="_blank"
         style="display:inline-block;background:#09090b;color:#ffffff;font-size:15px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;text-decoration:none;padding:16px 40px;border-radius:10px;letter-spacing:0.01em;line-height:1;min-width:200px;text-align:center;">
        ${label}
      </a>
      <!--<![endif]-->
    </td>
  </tr>
</table>`;

const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:36px 0;">
  <tr><td style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>`;

const sectionLabel = (text) =>
  `<p style="margin:0 0 14px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.15em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">${text}</p>`;

const infoCard = (content, borderColor = "#09090b", bg = "#f8fafc") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;">
    <tr>
      <td style="background:${bg};border:1px solid #e2e8f0;border-left:3px solid ${borderColor};border-radius:0 8px 8px 0;padding:16px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
        ${content}
      </td>
    </tr>
  </table>`;

const eventBadge = (eventName) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.12em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Event</p>
        <p style="margin:0;font-size:18px;font-weight:700;color:#09090b;letter-spacing:-0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
          ${eventName}
        </p>
      </td>
    </tr>
  </table>`;

// ─── Email 1 — Guest registration / onboarding ────────────────────────────────

async function sendGuestOnboardingEmail(to, guestName, eventCode, eventName) {
  const displayEvent = esc(eventName || eventCode || "your event");
  const safeGuest    = esc(guestName);
  const galleryUrl   = buildGuestLoginUrl(to);

  const html = emailShell(`
    <!-- Greeting -->
    <p style="margin:0 0 6px;font-size:14px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Hi ${safeGuest},
    </p>

    <!-- Hero headline -->
    <h1 style="margin:0 0 20px;font-size:32px;font-weight:800;color:#09090b;letter-spacing:-1px;line-height:1.15;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      You&rsquo;re officially<br>in the frame.
    </h1>

    <!-- Intro copy -->
    <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Welcome to <strong style="color:#09090b;">${displayEvent}</strong>. Your personal photo gallery
      has been reserved. Once the event wraps up, our AI will find every photo that has your face
      in it &mdash; and send them directly to your inbox.
    </p>
    <p style="margin:0 0 4px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      No app. No sign-up. Just your email.
    </p>

    ${eventBadge(displayEvent)}

    ${divider}

    ${sectionLabel("How it works")}

    ${infoCard(`
      <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.1em;text-transform:uppercase;">01 &nbsp;— &nbsp;Capture</p>
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#09090b;">The photographer works the entire event</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.65;">Every candid, every portrait, every moment — captured throughout the event without you needing to do a thing.</p>
    `, "#09090b")}

    ${infoCard(`
      <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.1em;text-transform:uppercase;">02 &nbsp;— &nbsp;Match</p>
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#09090b;">Our AI scans every face in every photo</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.65;">Powered by precision face recognition, ${APP_NAME} cross-references your selfie against the entire event gallery in seconds.</p>
    `, "#09090b")}

    ${infoCard(`
      <p style="margin:0 0 3px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.1em;text-transform:uppercase;">03 &nbsp;— &nbsp;Deliver</p>
      <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#09090b;">Your gallery arrives in this inbox</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.65;">One click opens your private gallery. Download every photo in full resolution — completely free.</p>
    `, "#09090b")}

    ${divider}

    <!-- CTA section -->
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#09090b;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Your gallery is reserved
    </p>
    <p style="margin:0 0 4px;font-size:13px;color:#64748b;text-align:center;line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Photos will appear automatically once the event wraps up.
    </p>

    ${ctaButton(galleryUrl, "Open My Gallery &rarr;")}

    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Signed in as &nbsp;<strong style="color:#475569;">${esc(to)}</strong>
    </p>

    ${divider}

    <!-- Trust signal -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
          <p style="margin:0;font-size:13px;color:#15803d;line-height:1.7;">
            <strong>&#128274; Your privacy is protected.</strong>
            Your selfie and face data are permanently and automatically deleted
            10&nbsp;days after the event — no exceptions, no archives.
          </p>
        </td>
      </tr>
    </table>
  `, `Welcome to ${eventName || eventCode || "your event"} — your Gopo gallery is reserved.`);

  const text = [
    `Hi ${guestName},`,
    "",
    `You're registered for ${eventName || eventCode || "your event"} — welcome to Gopo.`,
    "",
    "Here's how it works:",
    "  01. The photographer captures every moment at the event.",
    "  02. Our AI matches your selfie to every photo you appear in.",
    "  03. You receive a personal gallery link — no app, just your email.",
    "",
    `Open your gallery: ${galleryUrl}`,
    `Signed in as: ${to}`,
    "",
    "Your selfie and face data are permanently deleted 10 days after the event.",
    "",
    `Gopo — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `You're in — ${eventName || eventCode || "your event"} gallery is reserved`,
    html,
    text,
  });
}

// ─── Email 2 — Photos matched and ready ──────────────────────────────────────

async function sendPhotoReadyEmail(to, guestName, loginUrl, { eventName, matchCount } = {}) {
  const safeGuest    = esc(guestName);
  const displayEvent = esc(eventName || "your event");
  const count        = Number(matchCount) || 0;
  const photoLabel   = count === 1 ? "photo" : "photos";
  const photoWord    = count === 1 ? "Photo" : "Photos";

  const html = emailShell(`
    <!-- Greeting -->
    <p style="margin:0 0 6px;font-size:14px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Hi ${safeGuest},
    </p>

    <!-- Hero headline -->
    <h1 style="margin:0 0 16px;font-size:32px;font-weight:800;color:#09090b;letter-spacing:-1px;line-height:1.15;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Your ${photoLabel}<br>are ready.
    </h1>

    <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      We found every photo from <strong style="color:#09090b;">${displayEvent}</strong> that you appear in.
      Your private gallery is ready to view and download.
    </p>

    <!-- Photo count card -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
      <tr>
        <td style="background:#09090b;border-radius:14px;padding:40px 28px 36px;text-align:center;">
          <p style="margin:0;font-size:72px;font-weight:900;color:#ffffff;letter-spacing:-4px;line-height:1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
            ${count}
          </p>
          <p style="margin:10px 0 0;font-size:13px;font-weight:600;color:#52525b;letter-spacing:0.15em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
            ${photoLabel} matched to your face
          </p>
          <p style="margin:16px auto 0;font-size:13px;color:#3f3f46;max-width:300px;line-height:1.75;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
            Every one of them is a real moment from <strong style="color:#a1a1aa;">${displayEvent}</strong>, found and curated just for you.
          </p>
        </td>
      </tr>
    </table>

    ${ctaButton(loginUrl, `View My ${photoWord} &rarr;`)}

    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Signed in as &nbsp;<strong style="color:#475569;">${esc(to)}</strong>
    </p>

    ${divider}

    <!-- Urgency notice -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#c2410c;">&#9203; Download before they&rsquo;re gone</p>
          <p style="margin:0;font-size:13px;color:#ea580c;line-height:1.7;">
            Your photos and face data are permanently deleted
            <strong>10&nbsp;days after the event</strong>. Save your favourites to your device now.
          </p>
        </td>
      </tr>
    </table>

    ${sectionLabel("In your gallery")}

    <!-- Feature row -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="31%" style="text-align:center;padding:20px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;vertical-align:top;">
          <p style="margin:0;font-size:22px;line-height:1;">&#128444;&#65039;</p>
          <p style="margin:8px 0 0;font-size:12px;font-weight:600;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">View all photos</p>
          <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Private, just for you</p>
        </td>
        <td width="4%"></td>
        <td width="31%" style="text-align:center;padding:20px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;vertical-align:top;">
          <p style="margin:0;font-size:22px;line-height:1;">&#11015;&#65039;</p>
          <p style="margin:8px 0 0;font-size:12px;font-weight:600;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Full resolution</p>
          <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Print-quality files</p>
        </td>
        <td width="4%"></td>
        <td width="31%" style="text-align:center;padding:20px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;vertical-align:top;">
          <p style="margin:0;font-size:22px;line-height:1;">&#128230;</p>
          <p style="margin:8px 0 0;font-size:12px;font-weight:600;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Download as ZIP</p>
          <p style="margin:4px 0 0;font-size:11px;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">All at once, free</p>
        </td>
      </tr>
    </table>

  `, `${count} ${photoLabel} from ${eventName || "your event"} are ready to view and download.`);

  const text = [
    `Hi ${guestName},`,
    "",
    `${count} ${photoLabel} from ${eventName || "your event"} have been matched to your face.`,
    "",
    `View and download: ${loginUrl}`,
    `Signed in as: ${to}`,
    "",
    "Download soon — photos are permanently deleted 10 days after the event.",
    "",
    `Gopo — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `${count} ${photoLabel} found — your ${eventName || "event"} gallery is ready`,
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
    <!-- Greeting -->
    <p style="margin:0 0 6px;font-size:14px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Hi ${safeGuest},
    </p>

    <!-- Hero headline -->
    <h1 style="margin:0 0 16px;font-size:32px;font-weight:800;color:#09090b;letter-spacing:-1px;line-height:1.15;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Photos uploaded.<br>AI is on it.
    </h1>

    <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Fresh photos from <strong style="color:#09090b;">${displayEvent}</strong> have just been uploaded.
      Our face-recognition engine is scanning every frame right now to find the photos you appear in.
    </p>

    <!-- Status card -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
      <tr>
        <td style="background:#09090b;border-radius:14px;padding:32px 28px;text-align:center;">
          <p style="margin:0 0 12px;font-size:28px;line-height:1;">&#128247;</p>
          <p style="margin:0 0 8px;font-size:16px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
            Face matching in progress
          </p>
          <p style="margin:0 auto;font-size:13px;color:#52525b;max-width:300px;line-height:1.75;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
            Scanning every photo from ${displayEvent} and cross-referencing against your face. This usually completes in a few minutes.
          </p>
        </td>
      </tr>
    </table>

    ${sectionLabel("Current status")}

    ${infoCard(`
      <p style="margin:0;font-size:13px;color:#475569;line-height:1.65;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
        <strong style="color:#15803d;">&#10003; Photos uploaded.</strong>
        The full photo set from the event is in our system.
      </p>
    `, "#16a34a", "#f0fdf4")}

    ${infoCard(`
      <p style="margin:0;font-size:13px;color:#475569;line-height:1.65;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
        <strong style="color:#b45309;">&#8987; AI matching in progress.</strong>
        Finding every photo you appear in, automatically.
      </p>
    `, "#d97706", "#fffbeb")}

    ${infoCard(`
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.65;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
        <strong style="color:#94a3b8;">&#9993; Gallery email coming soon.</strong>
        We&rsquo;ll notify you the moment your photos are ready.
      </p>
    `, "#cbd5e1")}

    ${divider}

    <p style="margin:0 0 6px;font-size:14px;color:#475569;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Check your gallery anytime:
    </p>

    ${ctaButton(galleryUrl, "Open Gallery &rarr;")}

    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Signed in as &nbsp;<strong style="color:#475569;">${esc(to)}</strong>
    </p>

  `, `Photos from ${eventName || eventCode || "your event"} have been uploaded — face matching is running now.`);

  const text = [
    `Hi ${guestName},`,
    "",
    `Photos from ${displayEvent} have just been uploaded.`,
    "",
    "Current status:",
    "  ✓  Photos uploaded — the full event set is in our system.",
    "  ⏳  AI matching in progress — finding every photo you appear in.",
    "  ✉️  Gallery email coming — we'll notify you the moment it's ready.",
    "",
    `Gallery login: ${galleryUrl}`,
    `Signed in as: ${to}`,
    "",
    `Gopo — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to,
    subject: `Photos from ${eventName || eventCode || "your event"} are being matched now`,
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
      <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;width:160px;font-size:12px;font-weight:600;color:#94a3b8;vertical-align:top;letter-spacing:0.05em;text-transform:uppercase;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">${esc(label)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#09090b;vertical-align:top;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">${esc(value || "—")}</td>
    </tr>`;

  const bodyHtml = `
    <h2 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#09090b;letter-spacing:-0.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">New Enquiry</h2>
    <p style="margin:0 0 32px;font-size:14px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">Someone submitted the contact form on the Gopo website.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row("Name", name)}
      ${row("Email", email)}
      ${row("Phone", phone)}
      ${row("Event type", eventType)}
      ${row("Expected guests", expectedGuests)}
      ${row("Message", message)}
    </table>
    <p style="margin:28px 0 0;font-size:13px;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Reply directly to <a href="mailto:${esc(email)}" style="color:#09090b;font-weight:600;">${esc(email)}</a> to respond.
    </p>`;

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

  return sendEmail({
    to: notifyTo,
    replyTo: email,
    subject: `New enquiry from ${name}`,
    html: emailShell(bodyHtml, `${name} sent an enquiry via the Gopo contact form.`),
    text,
  });
}

async function sendContactConfirmation({ name, email }) {
  const bodyHtml = `
    <!-- Greeting -->
    <p style="margin:0 0 6px;font-size:14px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Hi ${esc(name)},
    </p>

    <h2 style="margin:0 0 16px;font-size:28px;font-weight:800;color:#09090b;letter-spacing:-0.8px;line-height:1.2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      We&rsquo;ve got your message.
    </h2>

    <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      Thank you for reaching out to Gopo. Our team will review your enquiry and get back to you
      personally — usually within 24 hours.
    </p>

    <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      In the meantime, feel free to explore how Gopo delivers AI-powered photo experiences for
      weddings, corporate events, college fests, and more.
    </p>

    ${ctaButton(buildAppUrl("/how-it-works"), "See How It Works &rarr;")}

    ${divider}

    <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
      If your enquiry is urgent, simply reply to this email and we&rsquo;ll prioritise it.
    </p>`;

  const text = [
    `Hi ${name},`,
    "",
    "We received your message — thank you for reaching out to Gopo.",
    "Our team will review your enquiry and get back to you within 24 hours.",
    "",
    `Learn more: ${buildAppUrl("/how-it-works")}`,
    "",
    `Gopo — ${COMPANY_URL}`,
  ].join("\n");

  return sendEmail({
    to: email,
    subject: `We received your message, ${name}`,
    html: emailShell(bodyHtml, `Thanks for reaching out, ${name}. We'll be in touch within 24 hours.`),
    text,
  });
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
