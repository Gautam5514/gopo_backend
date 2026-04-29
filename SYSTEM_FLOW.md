# Gopo System Flow

## Product Flow Summary

The product has four main operational flows:

1. Guest onboarding
2. Admin event and upload operations
3. Photo matching and delivery
4. Billing and platform oversight

## 1. Guest Onboarding Flow

### Entry point

- Admin creates an event.
- Admin shares a QR code that points to:

```text
/register?eventId=EVENT_CODE
```

### Detailed flow

```text
Admin creates event
-> frontend generates QR link from Event.code
-> guest opens registration page
-> guest enters name + email + selfie
-> frontend sends multipart form data to /api/guests/register
-> backend extracts face descriptor from selfie
-> backend uploads selfie to Cloudinary
-> backend stores Guest record
-> backend sends onboarding email
-> guest is now eligible for matching
```

### Key files

- `frontend/app/register/page.js`
- `backend/controllers/guestController.js`
- `backend/services/faceService.js`
- `backend/services/cloudinaryService.js`
- `backend/services/emailService.js`

## 2. Admin Event Management Flow

### Event creation

```text
Admin logs in
-> opens /admin/weddings
-> creates event with name + code
-> backend stores Event with ownerId = current admin
-> frontend displays QR code and registration link
```

### Event detail operations

```text
Admin opens /admin/weddings/:id
-> frontend fetches event details
-> frontend fetches billing status
-> frontend fetches download stats
-> admin sees guests, counts, QR, and upload panel
```

### Key files

- `frontend/app/admin/weddings/page.js`
- `frontend/app/admin/weddings/[id]/page.js`
- `backend/controllers/adminController.js`

## 3. Photo Upload and Matching Flow

### Current implementation

This is synchronous and happens inside the upload API call.

### Detailed flow

```text
Admin selects event photos
-> frontend sends files to /api/admin/upload-photos
-> backend validates admin role and event ownership
-> backend validates active billing and remaining quota
-> for each photo:
   -> detect all faces
   -> upload image to Cloudinary
   -> store Photo with descriptors
-> if autoMatch = true:
   -> load event guests
   -> build FaceMatcher from guest descriptors
   -> compare every detected face against guests
   -> create Match records
   -> mark photos processed
   -> email matched guests
-> increment subscription usage
-> return upload and match summary
```

### Matching logic

```text
Guest selfie descriptor
vs
Detected face descriptor from event photo
-> FaceMatcher threshold 0.6
-> if matched:
   -> create Match(photoId, guestId, confidence)
```

### Output artifacts

- `Photo` documents
- `Match` documents
- photo-ready emails
- increased `AdminUploadUsage.usedUploads`

### Key files

- `backend/controllers/adminController.js`
- `backend/services/faceService.js`
- `backend/services/billingService.js`

## 4. Guest Gallery and Delivery Flow

### Login flow

```text
Guest opens /login
-> selects guest mode
-> enters email
-> frontend calls /api/auth/guest-login
-> backend finds Guest by email
-> backend creates or reuses User(role=user)
-> backend returns auth token
-> frontend stores session
-> redirect to /gallery
```

### Gallery fetch flow

```text
Frontend calls /api/guests/matches/me
-> backend resolves authenticated email
-> backend finds Guest
-> backend loads Match records and Photo references
-> frontend renders personal gallery
```

### Download flow

Single photo:

```text
Guest requests photo
-> backend validates photo belongs to guest through Match
-> backend logs DownloadLog
-> backend returns Cloudinary URL
```

ZIP download:

```text
Guest requests all photos
-> backend loads matched photos
-> backend fetches Cloudinary image binaries
-> backend creates ZIP
-> backend logs DownloadLog entries
-> ZIP returned to browser
```

### Key files

- `frontend/app/login/page.js`
- `frontend/app/gallery/page.js`
- `backend/controllers/authController.js`
- `backend/controllers/guestController.js`

## 5. Billing Flow

### Plan discovery

```text
Admin opens billing page
-> frontend calls /api/billing/plans
-> frontend calls /api/billing/status
-> backend returns plans and current subscription state
```

### Checkout flow

```text
Admin selects plan
-> frontend calls /api/billing/create-order
-> backend creates Razorpay order
-> backend creates or updates Payment(status=created)
-> frontend launches Razorpay Checkout
-> on success frontend calls /api/billing/verify-payment
-> backend verifies signature
-> backend activates AdminSubscription
-> backend creates or resets AdminUploadUsage
-> backend marks Payment(status=paid)
```

### Webhook flow

```text
Razorpay webhook arrives
-> backend validates webhook signature
-> if payment captured:
   -> activate plan if not already activated
   -> or attach raw webhook data
```

### Enforcement point

Photo uploads are blocked here:

```text
assertUploadAllowed(adminId, uploadCount)
```

So billing is not cosmetic; it is operationally enforced in the upload path.

## 6. Superadmin Oversight Flow

### Login

```text
Superadmin logs in with env-configured credentials
-> backend returns superadmin token
-> frontend stores superadmin session
```

### Dashboard

```text
Frontend calls /api/superadmin/dashboard
-> backend loads subscriptions
-> backend loads paid payments
-> backend computes:
   -> total admins
   -> total subscribers
   -> active subscriptions
   -> total revenue
-> frontend renders revenue and subscription ledger
```

### Key files

- `frontend/app/superadmin/login/page.js`
- `frontend/app/superadmin/(secure)/dashboard/page.js`
- `frontend/app/superadmin/(secure)/subscriptions/page.js`
- `backend/controllers/superadminController.js`

## 7. Cleanup and Retention Flow

The backend starts a scheduler during server boot.

### Detailed flow

```text
Server starts
-> cleanup scheduler starts
-> old photos older than retention cutoff:
   -> delete from Cloudinary
   -> delete Match records
   -> delete DownloadLog records
   -> delete Photo docs
-> old guests older than cutoff:
   -> delete selfie image from Cloudinary
   -> scrub selfieUrl, selfiePublicId, faceDescriptor
-> delete stale DownloadLog records
```

### Key files

- `backend/services/cleanupService.js`

## Current System Mind

Use this mental model before future changes:

- Public identity for an event is `Event.code`.
- Admin billing gates uploads across all admin-owned events.
- Guest registration is identity capture for later matching.
- Matching is the center of the product, not a side feature.
- Delivery analytics come from `DownloadLog`, not just gallery views.
- Media lives outside MongoDB.
- The current system is operationally monolithic but domain-separable.

## Recommended Future Flow

The best future flow is:

```text
Upload accepted
-> create Job
-> background worker detects faces
-> background worker uploads/processes/matches
-> job status updates visible in admin UI
-> notifications triggered after job completion
```

That would remove the current synchronous bottleneck from admin uploads.
