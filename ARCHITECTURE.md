# Gopo Architecture

## Overview

Gopo is an event-photo delivery platform built as two applications:

- `frontend`: Next.js 16 app-router application for marketing pages, guest registration, guest gallery, admin operations, billing, and superadmin views.
- `backend`: Express + MongoDB API for auth, events, guests, photos, face matching, billing, email, and cleanup.

At runtime, the system connects these services:

- Next.js frontend
- Express API
- MongoDB
- Cloudinary
- Razorpay
- Resend
- `@vladmandic/face-api` with TensorFlow node runtime

## High-Level Topology

```text
Browser
  |
  v
Next.js frontend
  |
  v
Express API
  |
  +--> MongoDB
  +--> Cloudinary
  +--> Razorpay
  +--> Resend
  +--> Face recognition models / TensorFlow
```

## Frontend Architecture

Base location: `frontend/`

### Main areas

- Public marketing pages: `app/page.js`, `components/landing/*`
- Guest auth and access: `app/login/page.js`, `app/register/page.js`, `app/gallery/page.js`
- Admin workspace: `app/admin/*`
- Superadmin workspace: `app/superadmin/*`
- API/session utilities: `app/utils/api.js`, `app/utils/razorpay.js`

### Frontend responsibilities

- Render landing and static pages
- Collect guest registration input and selfie uploads
- Store auth tokens in `localStorage`
- Call backend APIs for guest/admin/superadmin flows
- Launch Razorpay checkout
- Present upload, quota, gallery, and analytics UI

### Session model

The frontend stores tokens in `localStorage`:

- `authToken`, `authUser`
- `superadminToken`, `superadminUser`

This is simple and works for the current architecture, but it is not hardened like an HTTP-only cookie flow.

## Backend Architecture

Base location: `backend/`

### Layering

- `index.js`: app bootstrap, middleware, route registration, startup tasks
- `routes/`: HTTP route definitions
- `controllers/`: request handling and orchestration
- `models/`: MongoDB schemas via Mongoose
- `services/`: integrations and domain services
- `middleware/`: auth middleware
- `weights/`: face model files

### Registered API domains

- `/api/auth`
- `/api/guests`
- `/api/admin`
- `/api/billing`
- `/api/billing/webhook`
- `/api/superadmin`

## Core Domain Modules

### 1. Auth

Files:

- `backend/controllers/authController.js`
- `backend/middleware/auth.js`

Responsibilities:

- Admin signup and login
- Guest email-based login bootstrap
- Token signing and verification
- Role enforcement

Auth uses a custom HMAC-signed token format, not a JWT library.

### 2. Events

Files:

- `backend/controllers/adminController.js`
- `backend/models/Event.js`

Responsibilities:

- Create admin-owned events
- List events
- Load event details
- Use `Event.code` as the public-facing event identifier

### 3. Guests

Files:

- `backend/controllers/guestController.js`
- `backend/models/Guest.js`

Responsibilities:

- Guest registration by selfie upload
- Face descriptor extraction
- Guest gallery lookup
- Single and ZIP download delivery

### 4. Photos and Matching

Files:

- `backend/models/Photo.js`
- `backend/models/Match.js`
- `backend/services/faceService.js`
- `backend/controllers/adminController.js`

Responsibilities:

- Detect faces in uploaded event photos
- Store photo metadata and face descriptors
- Match photo faces against registered guest descriptors
- Create `Match` documents
- Notify guests when photos are ready

Current implementation note:

- Matching is synchronous inside the upload request path.
- Placeholder job-related files exist, but async job execution is not implemented yet.

### 5. Billing

Files:

- `backend/controllers/billingController.js`
- `backend/services/billingService.js`
- `backend/models/SubscriptionPlan.js`
- `backend/models/AdminSubscription.js`
- `backend/models/AdminUploadUsage.js`
- `backend/models/Payment.js`

Responsibilities:

- Sync default plans
- Create Razorpay orders
- Verify payments
- Activate admin subscriptions
- Enforce upload quota before photo upload

Important scope rule:

- Billing is admin-scoped, not event-scoped.
- One admin subscription controls upload allowance across all events owned by that admin.

### 6. Notifications

Files:

- `backend/services/emailService.js`

Responsibilities:

- Guest onboarding emails
- Photos uploaded notifications
- Photos ready notifications

### 7. Storage Cleanup

Files:

- `backend/services/cleanupService.js`

Responsibilities:

- Delete old event photos from Cloudinary and MongoDB references
- Scrub old guest selfie data
- Remove stale download logs

## Request Flow Summary

### Guest registration

```text
Guest scans QR
-> frontend /register?eventId=EVENT_CODE
-> POST /api/guests/register
-> extract face descriptor
-> upload selfie to Cloudinary
-> store Guest
-> send onboarding email
```

### Admin upload and matching

```text
Admin selects event
-> uploads event photos
-> backend checks active billing + remaining quota
-> detect faces
-> upload images to Cloudinary
-> store Photo docs
-> match against Guest descriptors
-> create Match docs
-> email matched guests
-> increment quota usage
```

### Guest gallery delivery

```text
Guest logs in with email
-> backend resolves Guest by email
-> GET matched photos
-> frontend renders personal gallery
-> guest downloads photo(s)
-> backend records DownloadLog
```

### Billing activation

```text
Admin opens billing page
-> backend returns plans and current status
-> frontend opens Razorpay Checkout
-> backend verifies signature or webhook
-> activate AdminSubscription
-> initialize AdminUploadUsage
```

## Architectural Constraints

- `Event.code` is the public event key used by guest flows.
- Admin pages often use event document `_id` for internal routing.
- Actual media is stored in Cloudinary, not MongoDB.
- MongoDB stores references, descriptors, matches, analytics, and billing state.
- Matching depends on face model weights under `backend/weights/`.

## Known Weaknesses

- Synchronous matching will not scale well for large uploads.
- Job infrastructure is not yet implemented, despite placeholder files.
- Guest registration does not strongly validate event existence before insert.
- There are no automated tests.
- Duplicate match creation risk exists if uploads or matching are repeated.
- Frontend default API port and backend default server port must be aligned through environment variables.

## Recommended Next Evolution

1. Introduce proper async job processing for upload, matching, email, and cleanup-heavy tasks.
2. Add schema constraints and indexes for deduplication and integrity.
3. Add explicit validation for all API inputs.
4. Add event lifecycle states such as `draft`, `active`, `matching`, `delivery_live`, `archived`.
5. Add observability for upload jobs, email failures, and matching metrics.
