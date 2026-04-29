const Guest = require("../models/Guest");
const Event = require("../models/Event");
const cloudinaryService = require("../services/cloudinaryService");
const faceService = require("../services/faceService");
const emailService = require("../services/emailService");
const Match = require("../models/Match");
const DownloadLog = require("../models/DownloadLog");
const AdmZip = require("adm-zip");

// The version of the privacy/consent notice currently in use.
// Increment this string (e.g. "v2") whenever the privacy policy text changes
// so that historical consent records can be matched to the exact disclosure
// the guest accepted.
const CONSENT_VERSION = "v1";

exports.registerGuest = async (req, res) => {
  try {
    const { name, email, eventId, consentGiven } = req.body;
    const selfieFile = req.file;

    // ── Consent check — must be the very first validation ──────────────────
    // FormData always serialises values as strings, so accept both the
    // string "true" and the boolean true defensively.
    const hasConsent =
      consentGiven === true ||
      (typeof consentGiven === "string" && consentGiven.trim().toLowerCase() === "true");

    if (!hasConsent) {
      return res.status(400).json({
        error: "Your consent is required before we can process your face data.",
      });
    }

    // ── Basic field validation ──────────────────────────────────────────────
    const cleanName    = typeof name    === "string" ? name.trim()              : "";
    const cleanEmail   = typeof email   === "string" ? email.trim().toLowerCase() : "";
    const cleanEventId = typeof eventId === "string" ? eventId.trim()           : "";

    if (!cleanName) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "A valid email address is required." });
    }
    if (!cleanEventId) {
      return res.status(400).json({ error: "Event ID is required." });
    }
    if (!selfieFile) {
      return res.status(400).json({ error: "A selfie photo is required." });
    }

    // ── Validate the event exists ───────────────────────────────────────────
    // Without this check a guest can register for a phantom event code,
    // creating a guest record that will never be matched against any photos.
    const event = await Event.findOne({ code: cleanEventId }).select("name").lean();
    if (!event) {
      return res.status(404).json({
        error: "Event not found. Please scan the correct QR code.",
      });
    }

    // ── Face extraction (expensive — run only after all cheap checks pass) ─
    const descriptor = await faceService.extractFaceDescriptor(selfieFile.buffer);
    if (!descriptor) {
      return res.status(400).json({
        error: "No face detected in your selfie. Please ensure your face is clearly visible and try again.",
      });
    }

    // ── Upload new selfie to Cloudinary ─────────────────────────────────────
    const uploadResult = await cloudinaryService.uploadImage(
      selfieFile.buffer,
      "event_selfies"
    );

    // ── Atomic upsert — handles both fresh registration and re-registration ─
    //
    // new: false returns the document AS IT WAS before the update:
    //   • null  → this is a brand-new registration
    //   • doc   → guest is re-registering (updated their selfie / retook it)
    //
    // Using findOneAndUpdate + upsert is safe under concurrent requests:
    // MongoDB's upsert is atomic, so two simultaneous registrations for the
    // same (email, eventId) pair will result in exactly one document.
    const beforeDoc = await Guest.findOneAndUpdate(
      { email: cleanEmail, eventId: cleanEventId },
      {
        $set: {
          name:           cleanName,
          selfieUrl:      uploadResult.secure_url,
          selfiePublicId: uploadResult.public_id,
          faceDescriptor: descriptor,
          consentGivenAt: new Date(),   // server-side timestamp — tamper-resistant
          consentVersion: CONSENT_VERSION,
        },
      },
      { upsert: true, new: false, setDefaultsOnInsert: true }
    );

    const isReRegistration = beforeDoc !== null;

    if (isReRegistration) {
      // Delete the old selfie image from Cloudinary (fire-and-forget — a
      // failure here is non-critical and must not fail the registration).
      if (beforeDoc.selfiePublicId) {
        cloudinaryService.deleteImage(beforeDoc.selfiePublicId).catch((err) =>
          console.error("Old selfie cleanup failed:", err.message)
        );
      }

      // Stale Match records must be removed synchronously: the matching
      // pipeline could re-run immediately after this response, and it must
      // compare event photos against the NEW descriptor, not the old one.
      await Match.deleteMany({ guestId: beforeDoc._id });
    }

    // Resolve the guest _id for the response.
    // For new registrations findOneAndUpdate returns null (new: false), so
    // we do a lightweight projection-only fetch to get the inserted _id.
    const guestId = isReRegistration
      ? beforeDoc._id
      : (await Guest.findOne({ email: cleanEmail, eventId: cleanEventId }).select("_id").lean())?._id;

    // ── Onboarding email (best-effort, fire-and-forget) ─────────────────────
    emailService
      .sendGuestOnboardingEmail(cleanEmail, cleanName, cleanEventId, event.name || null)
      .catch((emailError) => {
        console.error("Guest onboarding email failed:", emailError.message);
      });

    return res.status(201).json({
      success: true,
      message: isReRegistration
        ? "Registration updated. Your new selfie will be used for matching."
        : "Registration successful. You will be notified when your photos are ready.",
      guest: {
        id:    guestId,
        name:  cleanName,
        email: cleanEmail,
      },
    });
  } catch (error) {
    console.error("Guest registration error:", error);
    return res.status(500).json({
      error: "Registration failed. Please try again.",
    });
  }
};

exports.getMatches = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // A guest may be registered across multiple events — use find, not findOne,
    // so we return photos from every event they attended.
    const guests = await Guest.find({ email }).select("_id name").lean();
    if (!guests.length) return res.status(404).json({ error: "Guest not found" });

    const guestIds = guests.map((g) => g._id);
    const matches  = await Match.find({ guestId: { $in: guestIds } })
      .populate("photoId")
      .sort("-createdAt")
      .lean();

    res.json({
      success: true,
      guestName: guests[0].name,
      photos: matches
        .filter((m) => m.photoId?.cloudinaryUrl)
        .map((m) => ({
          id:         m.photoId._id,
          url:        m.photoId.cloudinaryUrl,
          confidence: m.confidence,
        })),
    });
  } catch (error) {
    console.error("Get matches error:", error);
    res.status(500).json({ error: "Failed to fetch matches." });
  }
};

exports.getMyMatches = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) return res.status(401).json({ error: "Authentication required" });

    // A person may have registered for multiple events — each registration
    // creates a separate Guest document with the same email but a different
    // eventId.  We need ALL of them to return the full photo history.
    const guests = await Guest.find({ email: userEmail }).select("_id name selfieUrl").lean();
    if (!guests.length) {
      return res.status(404).json({ error: "Guest profile not found for this account" });
    }

    const guestIds  = guests.map((g) => g._id);
    const guestName = guests[0].name;
    // Use the most recent registration's selfie as the profile photo.
    // selfieUrl is a Cloudinary URL set at registration time.
    const selfieUrl = guests[0].selfieUrl || null;

    // Fetch every match across all events this person attended
    const matches = await Match.find({ guestId: { $in: guestIds } })
      .populate({ path: "photoId", select: "cloudinaryUrl eventId createdAt" })
      .sort("-createdAt")
      .lean();

    const validMatches = matches.filter((m) => m.photoId?.cloudinaryUrl);

    if (!validMatches.length) {
      return res.json({
        success: true,
        guestName,
        selfieUrl,
        totalPhotos: 0,
        events: [],
      });
    }

    // Collect the unique event codes referenced by the matched photos
    const eventIds = [...new Set(validMatches.map((m) => m.photoId.eventId).filter(Boolean))];

    // Batch-load event metadata (name + creation date) for all relevant events
    const eventDocs = await Event.find({ code: { $in: eventIds } })
      .select("name code createdAt")
      .lean();
    const eventMap = new Map(eventDocs.map((e) => [e.code, e]));

    // Group photos by event while preserving sort order (newest first)
    const groups = new Map();
    for (const match of validMatches) {
      const eid = match.photoId.eventId;
      if (!eid) continue;
      if (!groups.has(eid)) {
        const evt = eventMap.get(eid);
        groups.set(eid, {
          eventId:   eid,
          eventName: evt?.name || eid,
          eventDate: evt?.createdAt || null,
          photos:    [],
        });
      }
      groups.get(eid).photos.push({
        id:         match.photoId._id,
        url:        match.photoId.cloudinaryUrl,
        confidence: match.confidence,
      });
    }

    return res.json({
      success: true,
      guestName,
      selfieUrl,
      totalPhotos: validMatches.length,
      events: Array.from(groups.values()),
    });
  } catch (error) {
    console.error("Get my matches error:", error);
    res.status(500).json({ error: "Failed to load your gallery." });
  }
};

exports.downloadPhoto = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) return res.status(401).json({ error: "Authentication required" });

    const { photoId } = req.params;
    if (!photoId) return res.status(400).json({ error: "photoId is required" });

    // A guest may be registered across multiple events — check all guest IDs
    const guests = await Guest.find({ email: userEmail }).select("_id").lean();
    if (!guests.length) return res.status(404).json({ error: "Guest profile not found for this account" });

    const guestIds = guests.map((g) => g._id);
    const matched = await Match.findOne({ guestId: { $in: guestIds }, photoId }).populate("photoId");
    if (!matched?.photoId) {
      return res.status(403).json({ error: "You do not have access to this photo" });
    }

    await DownloadLog.create({
      eventId:      matched.photoId.eventId,
      photoId:      matched.photoId._id,
      guestId:      matched.guestId,
      downloadedAt: new Date(),
    });

    return res.json({
      success: true,
      url: matched.photoId.cloudinaryUrl,
    });
  } catch (error) {
    console.error("Download photo error:", error);
    return res.status(500).json({ error: "Failed to prepare photo download." });
  }
};

const getFileExtension = (url) => {
  try {
    const { pathname } = new URL(url);
    const ext = pathname.split(".").pop();
    if (!ext || ext.includes("/")) return "jpg";
    return ext.toLowerCase();
  } catch {
    return "jpg";
  }
};

exports.downloadAllPhotosZip = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) return res.status(401).json({ error: "Authentication required" });

    // Cover multi-event registrations: find every Guest record for this email
    const guests = await Guest.find({ email: userEmail }).select("_id name").lean();
    if (!guests.length) return res.status(404).json({ error: "Guest profile not found for this account" });

    const guestIds = guests.map((g) => g._id);
    const guestName = guests[0].name;

    const matches = await Match.find({ guestId: { $in: guestIds } }).populate("photoId").lean();
    const accessiblePhotos = matches
      .map((m) => m.photoId)
      .filter((p) => p && p.cloudinaryUrl);

    if (!accessiblePhotos.length) {
      return res.status(404).json({ error: "No matched photos found for download" });
    }

    // Deduplicate by photo _id (same photo can appear in multiple matches across guests)
    const uniqueByPhotoId = new Map();
    for (const photo of accessiblePhotos) {
      uniqueByPhotoId.set(photo._id.toString(), photo);
    }
    const uniquePhotos = Array.from(uniqueByPhotoId.values());

    const zip = new AdmZip();

    // Fetch photos 10 at a time to avoid saturating Cloudinary's connection
    // pool and hitting rate limits when an event has hundreds of photos.
    const FETCH_CONCURRENCY = 10;
    for (let i = 0; i < uniquePhotos.length; i += FETCH_CONCURRENCY) {
      const batch = uniquePhotos.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(
        batch.map(async (photo, batchIdx) => {
          const response = await fetch(photo.cloudinaryUrl);
          if (!response.ok) throw new Error(`Failed to fetch photo ${photo._id}`);
          const buffer    = Buffer.from(await response.arrayBuffer());
          const extension = getFileExtension(photo.cloudinaryUrl);
          zip.addFile(`event-photo-${i + batchIdx + 1}.${extension}`, buffer);
        })
      );
    }

    // Log downloads against the guestId that owns the match for accurate analytics.
    // photoId is already confirmed accessible above so _id is always defined.
    const matchMap = new Map(matches.map((m) => [m.photoId._id.toString(), m.guestId]));
    await DownloadLog.insertMany(
      uniquePhotos.map((photo) => ({
        eventId:      photo.eventId,
        photoId:      photo._id,
        guestId:      matchMap.get(photo._id.toString()) || guestIds[0],
        downloadedAt: new Date(),
      }))
    );

    const zipBuffer = zip.toBuffer();
    const slug = (guestName || "guest").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-event-photos.zip"`);
    return res.send(zipBuffer);
  } catch (error) {
    console.error("Download ZIP error:", error);
    return res.status(500).json({ error: "Failed to prepare your photo archive." });
  }
};

// ── GDPR / DPDP: right to erasure  (DELETE /api/guests/me) ──────────────────
// Deletes every piece of personal data Gopo holds for the authenticated guest:
//   • All selfie images from Cloudinary (every event they registered for)
//   • All face-match records
//   • All download-log records
//   • All guest documents
//
// Cloudinary deletions use Promise.allSettled so that one failed deletion does
// not prevent the rest of the data from being removed. Failures are logged for
// manual follow-up. MongoDB records are always deleted regardless.
exports.deleteMyData = async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: "Authentication required." });
    }

    // Fetch ALL guest records for this email (they may have registered for
    // multiple events) so every piece of biometric data is erased.
    const guests = await Guest.find({ email: userEmail }).select("_id selfiePublicId");

    if (!guests.length) {
      // Auto-cleanup may have already removed the data — treat as success
      // so the response is idempotent.
      return res.json({
        success: true,
        message: "No data found for your account. Nothing to delete.",
      });
    }

    const guestIds = guests.map((g) => g._id);

    // Step 1 — Remove selfies from Cloudinary.
    // Each deletion has its own .catch so a single failure never stops the rest.
    await Promise.all(
      guests
        .filter((g) => g.selfiePublicId)
        .map((g) =>
          cloudinaryService.deleteImage(g.selfiePublicId).catch((err) => {
            console.error(
              `Cloudinary deletion failed for selfiePublicId ${g.selfiePublicId}:`,
              err.message
            );
          })
        )
    );

    // Step 2 — Remove all related MongoDB records in parallel.
    await Promise.all([
      Match.deleteMany({ guestId: { $in: guestIds } }),
      DownloadLog.deleteMany({ guestId: { $in: guestIds } }),
    ]);

    // Step 3 — Remove the guest documents themselves.
    await Guest.deleteMany({ _id: { $in: guestIds } });

    return res.json({
      success: true,
      message: "All your personal data has been permanently deleted.",
    });
  } catch (error) {
    console.error("Delete my data error:", error);
    return res.status(500).json({
      error: "Failed to delete your data. Please try again later.",
    });
  }
};
