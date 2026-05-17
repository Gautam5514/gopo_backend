# Backend Robustness Audit

Each section below names one weak area, explains **exactly why it is fragile**,
describes **the failure mode** (what goes wrong and when), and states **the fix applied**.

---

## 1 · `jobRunner.js` — STALE_AFTER_MS < JOB_TIMEOUT_MS (duplicate processing)

**File:** `workers/jobRunner.js`  
**Severity:** Critical — data duplication, wasted compute, race conditions

### Why it is weak
`STALE_AFTER_MS` (how long a job can sit in `"processing"` before being reclaimed)
was **10 min**, while `JOB_TIMEOUT_MS` (how long `withTimeout` waits before
rejecting) was **15 min**.

```
T = 0 min  → job claimed, status = "processing"
T = 10 min → reclaimStaleJobs fires → status reset to "pending"
             → a SECOND worker claims the same job
T = 15 min → withTimeout rejects the FIRST worker's processJob
```

Both workers now run `faceService.detectAllFaces` and `cloudinaryService.uploadImage`
on the same photo simultaneously.  Two ONNX inference runs compete for CPU; two
`Photo.findByIdAndUpdate` writes race each other; two `checkAndTriggerMatching`
calls fire — one of them may trigger matching before the other has saved face data.

### Fix
`STALE_AFTER_MS` must always be strictly greater than `JOB_TIMEOUT_MS`.
Set to **20 min** (`JOB_TIMEOUT_MS` = 15 min + 5 min safety margin).

---

## 2 · `guestRoutes.js` — Selfie multer has no file-size limit (memory bomb)

**File:** `routes/guestRoutes.js`  
**Severity:** Critical — server OOM, denial of service

### Why it is weak
```js
const upload = multer({ storage: multer.memoryStorage() });
```
No `limits` option is passed.  Multer defaults to **no limit**.  An attacker (or
accidentally large iOS HEIC selfie) can POST a 100 MB file; it is buffered entirely
in RAM.  Under concurrent registrations (a wedding venue with 300 guests all
scanning the QR code simultaneously) this multiplies to gigabytes.

### Fix
Add `limits: { fileSize: 10 * 1024 * 1024 }` (10 MB).  Multer rejects oversized
uploads before any application code runs.

---

## 3 · `adminController.js` — Orphaned Photo documents on partial `Promise.all` failure

**File:** `controllers/adminController.js` → `uploadPhotos`  
**Severity:** High — photos stuck with `cloudinaryUrl: null` block matching forever

### Why it is weak
```js
const photos = await Promise.all(
    files.map(() => Photo.create({ cloudinaryUrl: null, ... }))
);
await enqueuePhotos(photos.map(...));
```
If `Photo.create` succeeds for 295 of 300 files and then MongoDB throws (write
concern timeout, atlas rate-limit, etc.), the 295 successfully created documents
have `cloudinaryUrl: null`.  `triggerMatchingForEvent` counts `cloudinaryUrl: null`
as "still processing", so **matching is blocked for the entire event indefinitely**.
Even after subsequent successful uploads, the orphaned docs remain and the block
never clears without manual DB intervention.

The same problem occurs if `enqueuePhotos` throws after all `Photo.create` calls
succeed — 300 Photo docs exist but zero jobs, so the worker never processes them.

### Fix
Wrap the create + enqueue in a try/catch.  On failure, delete any Photo documents
that were successfully created (`Photo.deleteMany({ _id: { $in: createdIds } })`),
then return the error to the caller.  This keeps the DB clean and allows the admin
to retry the upload immediately.

---

## 4 · `faceService.js` — RetinaFace outputs accessed by positional index

**File:** `services/faceService.js` → `detectFaces`  
**Severity:** High — silent wrong results if model outputs reorder

### Why it is weak
```js
const outs = _detSession.outputNames.map(n => results[n]);
// stride loop:
const scores = toScores(outs[s]);        // assumes index 0-2 = score outputs
const boxD   = outs[s + 3].data;         // assumes index 3-5 = box outputs
const kpsD   = outs[s + 6].data;         // assumes index 6-8 = kps outputs
```
ONNX Runtime does not guarantee output ordering across model versions, runtime
versions, or platforms.  If the model is re-exported or a new version of
`onnxruntime-node` changes how it enumerates outputs, `outs[s + 3]` silently reads
the wrong tensor.  There is no assertion or log that catches this mismatch —
detection simply produces garbage boxes and zero faces without any error.

### Fix
At model-load time, log the full list of output names and assert that exactly
9 outputs are present.  In `detectFaces`, add a one-time guard that validates the
names contain the expected score/box/kps keywords so any future reordering is
caught immediately at startup rather than silently producing wrong detections.

---

## 5 · `guestController.js` — `downloadAllPhotosZip` hangs with no fetch timeout

**File:** `controllers/guestController.js` → `downloadAllPhotosZip`  
**Severity:** High — user request can hang indefinitely; potential gigabyte responses

### Why it is weak
```js
const response = await fetch(photo.cloudinaryUrl);   // no AbortController, no timeout
const buffer   = Buffer.from(await response.arrayBuffer());
zip.addFile(`event-photo-${n}.${ext}`, buffer);      // entire ZIP in RAM
```

Two problems:
1. **No timeout**: if Cloudinary is slow or a TCP connection hangs, the request
   never resolves.  Node.js HTTP keep-alive sockets have no default read timeout.
   The guest's browser waits, the connection slot is held, and memory accumulates.
2. **No photo count cap**: a guest matched against 2000 photos gets a ZIP built
   entirely in RAM.  10 photos × 5 MB average = 50 MB; 500 photos = 2.5 GB.
   The server OOMs before it can send the response.

### Fix
Wrap each `fetch` with an `AbortController` timeout (30 s per photo).
Cap the ZIP at a safe maximum (e.g. 200 photos); return a clear error if the
guest has more matches than the cap so they can download in batches.

---

## 6 · `cleanupService.js` — `setInterval` overlap when cleanup takes > 24 h

**File:** `services/cleanupService.js`  
**Severity:** Medium — duplicate Cloudinary deletions, double-delete errors

### Why it is weak
```js
setInterval(() => {
    runCleanup().catch(...);
}, cleanupIntervalMs);   // 24 h by default
```
`setInterval` fires unconditionally.  If an event has 50 000 photos and
`runCleanup` takes more than 24 hours (sequential Cloudinary deletions with
network latency), the *second* interval fires before the *first* finishes.
Both runs attempt to `deleteImage` the same Cloudinary assets simultaneously,
producing 404 errors from Cloudinary and potential double-delete in MongoDB
(`deleteMany` is idempotent but concurrent runs can cause Mongoose write conflicts
with certain MongoDB write concern settings).

### Fix
Track a boolean `cleanupRunning` flag.  If a run is already in progress, skip the
interval tick and log a warning.  This is the same pattern the job runner uses for
`activeJobs`.

---

## 7 · `photoQueue.js` — `insertMany` fails entire batch on one bad document

**File:** `queues/photoQueue.js`  
**Severity:** Medium — all jobs lost on a single validation error

### Why it is weak
```js
Job.insertMany(photos.map(...))   // default: ordered: true
```
With `ordered: true` (MongoDB default), if document N fails validation, MongoDB
stops and **does not insert documents N+1 through end**.  If an admin uploads 100
photos and photo 3's `photoId` somehow becomes invalid (ObjectId truncation,
serialisation bug), only 2 jobs are created.  Photos 3-100 have `cloudinaryUrl: null`
forever and block matching.  No error is surfaced to the caller in this scenario
because the caught error in `uploadPhotos` only results in a 500 response after the
Photo documents already exist.

### Fix
Pass `{ ordered: false }` so MongoDB inserts every valid document and collects
errors at the end.  The caller can then inspect `insertMany`'s result and log any
failed inserts without losing the whole batch.

---

## 8 · `cloudinaryService.js` — `deleteImage` has no timeout

**File:** `services/cloudinaryService.js`  
**Severity:** Medium — user-facing `DELETE /api/guests/me` hangs on Cloudinary outage

### Why it is weak
```js
exports.deleteImage = async (publicId) => {
    assertCloudinaryConfig();
    return await cloudinary.uploader.destroy(publicId);   // no timeout
};
```
`cloudinary.uploader.destroy` uses the Cloudinary SDK's default HTTP agent which
has **no socket timeout**.  During a Cloudinary partial outage (their CDN is up
but the upload API is slow), every `deleteImage` call hangs indefinitely.  This
blocks:
- `guestController.deleteMyData` — the user's GDPR erasure request hangs
- `cleanupService.safeDeleteCloudinaryByPublicId` — cleanup never completes
- `guestController.registerGuest` re-registration path — old selfie deletion hangs
  (fire-and-forget here, so it doesn't block the response, but it leaks a Promise)

### Fix
Wrap `cloudinary.uploader.destroy` in a `Promise.race` against a 30-second timeout
rejection, matching the pattern already used in `uploadImage`.

---

## 9 · `faceService.js` — `alignFace` decodes the full original image into RAM

**File:** `services/faceService.js` → `alignFace`  
**Severity:** Medium — RAM spike for high-resolution event photos

### Why it is weak
```js
const { data, info } = await sharp(imageBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
```
`sharp.raw()` decodes the entire JPEG/PNG into uncompressed RGB pixels.  A 20 MP
photo (5000 × 4000) = **60 MB** of raw pixels per call.  `alignFace` is called
once per detected face, so a group photo with 10 faces calls this 10 times — but
because the calls are sequential (ONNX queue), only one raw buffer exists at a time.
Even so, 60 MB per photo is significant on a 512 MB cloud instance.

### Fix
Crop a bounding-box region (with padding) from the original image using
`sharp().extract()` before calling `.raw()`.  This reduces the raw buffer from
the full image to a small face region (typically 200-400 × 200-400 px = 0.5 MB),
giving the same alignment quality at a fraction of the RAM.

---

## Summary Table

| # | File | Issue | Severity | Fixed |
|---|------|-------|----------|-------|
| 1 | `jobRunner.js` | STALE_AFTER_MS < JOB_TIMEOUT_MS → duplicate jobs | Critical | ✓ |
| 2 | `guestRoutes.js` | Selfie multer has no file-size limit | Critical | ✓ |
| 3 | `adminController.js` | Partial Photo.create failure → orphaned docs | High | ✓ |
| 4 | `faceService.js` | RetinaFace output tensors by position index | High | ✓ |
| 5 | `guestController.js` | ZIP download: no fetch timeout, no photo cap | High | ✓ |
| 6 | `cleanupService.js` | setInterval overlap if run > 24 h | Medium | ✓ |
| 7 | `photoQueue.js` | insertMany ordered:true drops whole batch | Medium | ✓ |
| 8 | `cloudinaryService.js` | deleteImage has no timeout | Medium | ✓ |
| 9 | `faceService.js` | alignFace decodes full image into RAM | Medium | ✓ |
