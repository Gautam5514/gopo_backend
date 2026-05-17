# Scalability Audit — 1000-User Scenario

Assumes: one active wedding/corporate event, 1000 guests, 500 event photos uploaded
by the photographer, all guests on the same venue WiFi.

---

## 1 · Selfie registration blocks for 37+ minutes (CRITICAL)

**Files:** `services/faceService.js`, `routes/guestRoutes.js`

### What happens
Every guest selfie runs ONNX inference (`extractFaceDescriptor`) synchronously
inside the HTTP request handler before a response is sent.  The ONNX queue
serialises all inference — photo batch jobs and selfie jobs share a single queue.

```
Photo 1  ──── 45 s ──────────────────────────────────────┐
Photo 2                   ──── 45 s ───────────────────────┤
...                                                        │
Photo 500                                 ──── 45 s ───────┤
Guest 1's selfie — waits 500 × 45 s = 6.25 hours ←───────┘
```

At a 500-photo event, the 1st guest who scans the QR code after photo upload
starts would wait **over 6 hours** for their registration to respond.  The browser
HTTP timeout is typically 30–120 s, so the request fails.  The guest sees an error,
re-scans, and re-queues — making the backlog worse.

### Fix
Replace the single promise-chain ONNX queue with a **priority queue**.
Selfie inference (`"high"` priority) always jumps ahead of queued photo batch
jobs (`"low"` priority).  A guest selfie only waits for the **single currently-
running** photo inference (≤ 45 s), not for all 499 remaining ones.

---

## 2 · Matching pipeline: 2500 sequential DB writes (HIGH)

**File:** `services/matchService.js`

### What happens
For 500 photos × 5 faces each = 2500 potential face comparisons.  If every face
matches a guest, the code executes 2500 `Match.updateOne(upsert)` calls
**sequentially** (each `await` blocks until MongoDB responds):

```js
for (const photo of photos) {
    for (const face of photo.detectedFaces) {
        await Match.updateOne(..., { upsert: true });   // ← one network round-trip each
    }
}
```

On Atlas M0 (shared, ~20 ms avg latency): 2500 × 20 ms = **50 seconds** of pure
DB latency, blocking the Node.js event loop from accepting any other requests
during that window.

### Fix
Collect all upsert operations into an array, then execute one `Match.bulkWrite`
call.  MongoDB processes all operations in a single server round-trip, then returns
which document indices were genuinely new inserts (via `result.upsertedIds`).
2500 ops → **one network round-trip**.

---

## 3 · 1000 simultaneous email sends → Resend rate limit (HIGH)

**File:** `services/matchService.js`

### What happens
After matching, all notification emails are fired at the same time:

```js
const emailResults = await Promise.allSettled(
    [...notifiedGuests].map(guestId => emailService.sendPhotoReadyEmail(...))
);
```

1000 guests = 1000 simultaneous Resend API requests in < 1 second.  Resend's
free tier allows 100 emails/day; paid tiers have rate limits (requests/second).
A burst of 1000 requests causes:
- HTTP 429 (Too Many Requests) for most requests
- Guest never receives their "photos ready" email
- `emailFailures` array fills up silently and the error is lost

### Fix
Send emails in **batches of 10** with a 200 ms pause between batches.
Throughput: 10 emails / 200 ms = 50 emails/s, well within Resend limits.
1000 guests: total email time ≈ 20 s (acceptable — guests don't need instant
notification; a 20-second delay after matching is invisible).

---

## 4 · Missing index causes slow trigger-check queries (HIGH)

**File:** `models/Photo.js`

### What happens
`triggerMatchingForEvent` runs after every job completion:

```js
const remainingUploads = await Photo.countDocuments({ eventId, cloudinaryUrl: null });
```

The existing index `{ eventId: 1, processed: 1 }` covers `eventId` but NOT
`cloudinaryUrl`.  MongoDB uses the eventId part to narrow down the collection
slice, then scans all photos for that event comparing `cloudinaryUrl`.  For an
event with 5000 photos, this is a 5000-document in-memory filter — called
once per job completion (once per photo upload).  500 photos = 500 × 5000 =
**2.5 million document comparisons** just for the trigger checks.

Also affects `getEventById` which runs two similar queries for `pendingProcessing`
and `failedPhotos`.

### Fix
Add compound index `{ eventId: 1, cloudinaryUrl: 1 }`.  MongoDB uses it to
count in O(log n) instead of O(n) per query.

---

## 5 · MongoDB connection pool too small for concurrent load (MEDIUM)

**File:** `index.js`

### What happens
`maxPoolSize: 5` means at most 5 simultaneous MongoDB operations.  At peak:

| Operation | Connections held |
|-----------|-----------------|
| Job worker (CONCURRENCY=1) | 1–2 |
| Matching pipeline (updateMany, bulkWrite) | 1–2 |
| Concurrent HTTP requests (gallery, download, register) | N |

With 50 concurrent guests viewing their gallery, 5 connections quickly saturate.
New operations queue inside the driver, adding 50–200 ms of queuing latency per
request on top of the real DB latency.

### Fix
Increase `maxPoolSize` from **5 to 15**.  15 is conservative; Atlas M10 handles
500+ connections.  On Atlas M0 (free), keep it at 10 max to stay within shared
limits.

---

## 6 · Guest registration rate limit too low for shared venue WiFi (MEDIUM)

**File:** `middleware/rateLimiter.js`

### What happens
`guestRegistrationLimiter` allows **50 registrations / 15 min per IP**.  At a
wedding venue, all 1000 guests connect to the same WiFi access point and share
the same public IP (NAT).  The 51st guest who tries to register from that WiFi
gets a 429 response — even though they have never registered before.

Express-rate-limit's default `MemoryStore` also means the counter resets on
server restart and is not shared across multiple instances.

### Fix
Raise the limit to **300 / 15 min**.  This is still enough to block automated
bulk-registration scripts (which would be the actual attack scenario) while
letting real venue guests register freely.  The selfie face detection itself
is a natural throttle — a single CPU can only process ~2 selfies/minute.

---

## 7 · Matching loads entire photo collection into RAM (LOW at typical scale)

**File:** `services/matchService.js`

### What happens
```js
const photos = await Photo.find({ eventId, processed: false });
```

For 5000 photos × 5 faces × 512-dim descriptor × 8 bytes = **20 MB** loaded
into a JS array at once.  This is fine for typical events (100–500 photos) but
grows linearly.  On a 512 MB cloud instance running with Node.js overhead and
ONNX models already loaded (~400 MB), a 5000-photo event could trigger OOM.

### Fix (implemented via index; full cursor approach is future work)
The `{ eventId, cloudinaryUrl }` index (Fix 4) reduces the query's working set.
For events > 2000 photos, consider switching to a cursor-based batch loop that
processes 200 photos at a time.  Not implemented here as it requires rearchitecting
the `processedPhotoIds` collection and bulk-write logic — document for future sprint.

---

## Summary Table

| # | File | Issue | Users impacted | Fixed |
|---|------|-------|---------------|-------|
| 1 | `faceService.js` | Selfie queues behind 500 photo jobs → 6 h wait | Every guest | ✓ |
| 2 | `matchService.js` | 2500 sequential DB writes block event loop 50 s | Every event | ✓ |
| 3 | `matchService.js` | 1000 concurrent emails → Resend rate-limit | Every guest | ✓ |
| 4 | `models/Photo.js` | Missing index → slow trigger checks | Every upload | ✓ |
| 5 | `index.js` | Pool size 5 → connection starvation under load | Concurrent users | ✓ |
| 6 | `rateLimiter.js` | 50/15min per IP blocks venue WiFi users | Guest registration | ✓ |
| 7 | `matchService.js` | All photos loaded into RAM at once | Events > 2000 photos | — (future) |
