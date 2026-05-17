"use strict";

/**
 * Face recognition using InsightFace buffalo_l models via ONNX Runtime:
 *   • det_10g.onnx  — RetinaFace detector (much better multi-face detection)
 *   • w600k_r50.onnx — ArcFace R50 recogniser (512-dim embeddings, ~4× more
 *                      discriminative than the previous FaceNet 128-dim)
 *
 * Run `node backend/scripts/downloadModels.js` once to fetch the models.
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");
const ort  = require("onnxruntime-node");
const sharp = require("sharp");

// ── Constants ──────────────────────────────────────────────────────────────────

const MODELS_DIR   = path.join(__dirname, "../models/buffalo_l");
const DET_PATH     = path.join(MODELS_DIR, "det_10g.onnx");
const REC_PATH     = path.join(MODELS_DIR, "w600k_r50.onnx");

const DET_SIZE     = 640;    // RetinaFace input (square)
const FACE_SIZE    = 112;    // ArcFace input (square)
// Lower threshold (0.40 vs the original 0.45) picks up faces that are slightly
// angled, partially lit, or a bit farther from the camera — common in group shots
// of 7–8+ people where not everyone is front-facing and well-lit.
const DET_THRESH   = 0.40;
// Faces narrower than this many pixels (in the ORIGINAL image coordinate space)
// produce unreliable ArcFace embeddings because the 112×112 warp is badly
// under-sampled.  Skipping them reduces false positive matches without missing
// any guest who would actually be identifiable.
const MIN_FACE_PX  = 30;
// Safety cap: if more faces pass the threshold than this, only embed the top N
// by confidence score.  Without a cap, a corrupted image or preprocessing bug
// can produce 8 000+ phantom detections.  Each one needs an ArcFace inference
// (~0.4 s on CPU), so 8 546 "faces" = 63 minutes — jobs never complete.
// 100 real faces is already an unusually large group photo; 200 is the hard wall.
const MAX_FACES_PER_PHOTO = 200;
const NMS_THRESH   = 0.4;    // NMS IoU threshold
const FPN_STRIDES  = [8, 16, 32];
const NUM_ANCHORS  = 2;      // anchors per cell per stride

// ArcFace standard 5-point landmark reference (112×112 normalised space)
const REF_LANDMARKS = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

// Cosine similarity threshold for a positive match.
// ArcFace embeddings are L2-normalised → dot-product equals cosine similarity.
//   Same person, similar conditions:    0.50 – 0.95
//   Same person, different conditions:  0.25 – 0.60  ← group photos live here
//   Different people:                   0.00 – 0.25
// 0.25 catches the "same person in group photo" range without meaningfully
// increasing false positives — ArcFace R50 is discriminative enough that
// unrelated faces almost never reach 0.25 against a registered selfie.
const MATCH_THRESHOLD = 0.25;

// ── ONNX sessions (lazy, singleton) ──────────────────────────────────────────

let _detSession = null;
let _recSession = null;
let _modelsPromise = null;

// ── Priority-aware ONNX serializer ────────────────────────────────────────────
// ONNX InferenceSession.run() is NOT reentrant — concurrent calls on the same
// session produce incorrect results or crashes.  All calls are serialised here.
//
// Two priority levels solve the "500 photo batch blocks selfie registration"
// problem at scale:
//   "high" — selfie extraction (user is waiting for HTTP response)
//   "low"  — batch event-photo detection (background job worker)
//
// A "high"-priority task jumps ahead of all queued "low"-priority tasks but
// still waits for any currently running task to finish (max one photo's worth
// of inference time, typically 15–45 s).  Without priorities, the 1st guest
// who scans the QR code after a 500-photo upload would wait > 6 hours.
let _onnxBusy = false;
const _onnxWaiters = []; // {priority, fn, resolve, reject}

const _drainOnnxQueue = () => {
    if (_onnxBusy || _onnxWaiters.length === 0) return;
    // Always prefer a high-priority waiter; fall back to the oldest low-priority one.
    const hi   = _onnxWaiters.findIndex((t) => t.priority === "high");
    const task = _onnxWaiters.splice(hi !== -1 ? hi : 0, 1)[0];
    _onnxBusy = true;
    task.fn()
        .then(task.resolve, task.reject)
        .finally(() => {
            _onnxBusy = false;
            _drainOnnxQueue();
        });
};

const runOnnxQueued = (session, feeds, priority = "low") =>
    new Promise((resolve, reject) => {
        _onnxWaiters.push({ priority, fn: () => session.run(feeds), resolve, reject });
        _drainOnnxQueue();
    });

const loadModels = async () => {
    if (!fs.existsSync(DET_PATH) || !fs.existsSync(REC_PATH)) {
        throw new Error(
            `buffalo_l ONNX models not found in ${MODELS_DIR}.\n` +
            `Run:  node backend/scripts/downloadModels.js`
        );
    }
    // Default to half the logical CPUs (min 1, max 4) so inference is
    // faster on multi-core machines without starving other Node.js work.
    // Override with ONNX_INTRA_OP_THREADS / ONNX_INTER_OP_THREADS in .env.
    const defaultThreads = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
    const opts = {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        intraOpNumThreads: Number(process.env.ONNX_INTRA_OP_THREADS || defaultThreads),
        interOpNumThreads: Number(process.env.ONNX_INTER_OP_THREADS || defaultThreads),
    };
    if (!_detSession) {
        _detSession = await ort.InferenceSession.create(DET_PATH, opts);
        // det_10g must expose exactly 9 outputs in the order:
        //   [score_8, score_16, score_32,  box_8, box_16, box_32,  kps_8, kps_16, kps_32]
        // detectFaces() uses outs[s], outs[s+3], outs[s+6] — positional access.
        // If the model re-export or onnxruntime changes the order, detections
        // will silently read the wrong tensors.  Log the names so any mismatch
        // is immediately visible in the startup log.
        const names = _detSession.outputNames;
        if (names.length !== 9) {
            throw new Error(
                `det_10g.onnx: expected 9 outputs, got ${names.length}.\n` +
                `Outputs: ${names.join(", ")}\n` +
                `Re-run node backend/scripts/downloadModels.js to refresh the model.`
            );
        }
        console.log("Face-detection model loaded  (RetinaFace  det_10g)");
        console.log(`  outputs: ${names.join(" | ")}`);
    }
    if (!_recSession) {
        _recSession = await ort.InferenceSession.create(REC_PATH, opts);
        console.log("Face-recognition model loaded (ArcFace R50 w600k_r50)");
    }
};

const ensureModels = async () => {
    if (!_modelsPromise) {
        _modelsPromise = loadModels().catch((err) => {
            _modelsPromise = null;
            throw err;
        });
    }
    return _modelsPromise;
};

// ── Maths helpers ─────────────────────────────────────────────────────────────

/** L2-normalise an array in-place and return it. */
const l2norm = (v) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-10) return v;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
};

/** Cosine similarity of two L2-normalised arrays. */
const cosine = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Intersection-over-union for two [x1,y1,x2,y2] boxes. */
const iou = (a, b) => {
    const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    const areaB = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (areaA + areaB - inter + 1e-6);
};

// ── 6×6 Gaussian elimination (for affine estimation) ─────────────────────────

const gaussElim = (A, b) => {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++)
            if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
        const piv = M[col][col];
        if (Math.abs(piv) < 1e-10) continue;
        for (let row = col + 1; row < n; row++) {
            const f = M[row][col] / piv;
            for (let k = col; k <= n; k++) M[row][k] -= f * M[col][k];
        }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = M[i][n];
        for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
        x[i] /= M[i][i];
    }
    return x;
};

/**
 * Least-squares 2×3 affine matrix from 5-point correspondences.
 * Returns [a, b, tx, c, d, ty] such that:
 *   x' = a·x + b·y + tx
 *   y' = c·x + d·y + ty
 */
const estimateAffine = (src, dst) => {
    const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const Atb = new Array(6).fill(0);
    for (let i = 0; i < src.length; i++) {
        const [x, y]   = src[i];
        const [xp, yp] = dst[i];
        const r1 = [x, y, 1, 0, 0, 0];
        const r2 = [0, 0, 0, x, y, 1];
        for (let j = 0; j < 6; j++) {
            Atb[j] += r1[j] * xp + r2[j] * yp;
            for (let k = 0; k < 6; k++)
                AtA[j][k] += r1[j] * r1[k] + r2[j] * r2[k];
        }
    }
    return gaussElim(AtA, Atb);
};

/** Bilinear sample of raw RGB buffer at fractional (x, y). */
const bilinear = (data, W, H, x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const dx = x - x0, dy = y - y0;
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const idx = (xi, yi) => (clamp(yi, 0, H - 1) * W + clamp(xi, 0, W - 1)) * 3;
    return [0, 1, 2].map(c =>
        (1 - dx) * (1 - dy) * data[idx(x0,     y0)     + c] +
        dx       * (1 - dy) * data[idx(x0 + 1, y0)     + c] +
        (1 - dx) * dy       * data[idx(x0,     y0 + 1) + c] +
        dx       * dy       * data[idx(x0 + 1, y0 + 1) + c]
    );
};

// ── Face alignment ────────────────────────────────────────────────────────────

/**
 * Crops and aligns a face to 112×112 using the 5 RetinaFace landmarks.
 *
 * When `box` is supplied (always preferred) we extract only the face bounding
 * box region — plus 40 % padding on each side — before decoding raw pixels.
 * This keeps peak RAM at ~0.5 MB per face instead of the full image (~60 MB
 * for a 20 MP photo).  The landmarks are shifted to the cropped coordinate
 * frame before computing the affine transform.
 *
 * estimateAffine(REF, localLandmarks) gives T that maps reference (112×112)
 * coords → crop coords, so we apply T directly in the backward warp (no
 * matrix inversion required).
 */
const alignFace = async (imageBuffer, landmarks, box = null) => {
    let sharpPipeline;
    let offsetX = 0;
    let offsetY = 0;

    if (box) {
        // metadata() reads only the JPEG/PNG header (<1 ms, no pixel decode).
        // We need the full image dimensions to clamp the crop to valid bounds.
        const { width: fullW, height: fullH } = await sharp(imageBuffer).metadata();
        const [x1, y1, x2, y2] = box;
        const faceW = Math.max(1, x2 - x1);
        const faceH = Math.max(1, y2 - y1);
        const pad   = Math.ceil(Math.max(faceW, faceH) * 0.4);

        const left   = Math.max(0, Math.floor(x1) - pad);
        const top    = Math.max(0, Math.floor(y1) - pad);
        const right  = Math.min(fullW, Math.ceil(x2)  + pad);
        const bottom = Math.min(fullH, Math.ceil(y2)  + pad);

        sharpPipeline = sharp(imageBuffer).extract({
            left, top, width: right - left, height: bottom - top,
        });
        offsetX = left;
        offsetY = top;
    } else {
        sharpPipeline = sharp(imageBuffer);
    }

    // Guarantee 3-channel RGB output for the same reason as prepareDetInput:
    // RGBA inputs would make bilinear() read the wrong byte offsets.
    const { data, info } = await sharpPipeline
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .toColorspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { width: W, height: H } = info;

    // Shift landmarks into the cropped frame before estimating the affine.
    const localLandmarks = landmarks.map(([lx, ly]) => [lx - offsetX, ly - offsetY]);
    const [a, b, tx, c, d, ty] = estimateAffine(REF_LANDMARKS, localLandmarks);

    const aligned = new Uint8Array(FACE_SIZE * FACE_SIZE * 3);
    for (let yp = 0; yp < FACE_SIZE; yp++) {
        for (let xp = 0; xp < FACE_SIZE; xp++) {
            const srcX = a * xp + b * yp + tx;
            const srcY = c * xp + d * yp + ty;
            const [r, g, bl] = bilinear(data, W, H, srcX, srcY);
            const out = (yp * FACE_SIZE + xp) * 3;
            aligned[out]     = Math.round(r);
            aligned[out + 1] = Math.round(g);
            aligned[out + 2] = Math.round(bl);
        }
    }
    return Buffer.from(aligned.buffer);
};

// ── RetinaFace ────────────────────────────────────────────────────────────────

/** Resize image and convert to float32 CHW tensor for RetinaFace (BGR, −127.5 /128). */
const prepareDetInput = async (imageBuffer) => {
    // Force exactly 3-channel sRGB output.
    // Without this, RGBA images (PNGs with transparency) produce a 4-byte-per-pixel
    // raw buffer.  The loop below reads with stride 3, so every fourth byte (alpha)
    // shifts all subsequent channel reads by one, giving completely wrong model input.
    // Garbage input → near-zero logits → ~50% of all 16 800 anchors score ≈ 0.5
    // → all pass the 0.45 threshold → 8 000+ "faces" detected → 63-minute hang.
    const { data, info } = await sharp(imageBuffer)
        .resize(DET_SIZE, DET_SIZE, { fit: "fill" })
        .flatten({ background: { r: 0, g: 0, b: 0 } })   // merge alpha onto black
        .toColorspace("srgb")                              // ensure exactly 3 channels
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (info.channels !== 3) {
        throw new Error(`prepareDetInput: expected 3-channel image, got ${info.channels}`);
    }

    const sz = DET_SIZE * DET_SIZE;
    const t  = new Float32Array(3 * sz);
    for (let i = 0; i < sz; i++) {
        t[i]          = (data[i * 3 + 2] - 127.5) / 128.0; // B
        t[sz + i]     = (data[i * 3 + 1] - 127.5) / 128.0; // G
        t[2 * sz + i] = (data[i * 3 + 0] - 127.5) / 128.0; // R
    }
    return new ort.Tensor("float32", t, [1, 3, DET_SIZE, DET_SIZE]);
};

/** Anchor centres for one FPN stride (2 anchors per cell). */
const anchorCenters = (stride) => {
    const h = Math.ceil(DET_SIZE / stride);
    const w = Math.ceil(DET_SIZE / stride);
    const out = [];
    for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++)
            for (let a = 0; a < NUM_ANCHORS; a++)
                out.push([(c + 0.5) * stride, (r + 0.5) * stride]);
    return out;
};

/**
 * Convert a score tensor to a flat Float32Array of per-anchor probabilities.
 *
 * det_10g outputs scores in two formats depending on the export:
 *   [N, 2]  — raw logits for [background, face]; apply softmax → face probability.
 *   [N, 1]  — already a face probability in [0, 1]; use directly.
 *
 * THE CRITICAL BUG THIS FIXES:
 * The [N, 1] branch previously applied sigmoid again on top of the already-computed
 * probability.  sigmoid(0.004) ≈ 0.501 which is above any threshold, so ALL 16 800
 * anchors appeared as "faces", producing 8 000+ phantom detections and 63-minute hangs.
 * The model already applies its own sigmoid internally — never apply it a second time.
 */
const toScores = (tensor) => {
    const data = tensor.data;
    const last = tensor.dims[tensor.dims.length - 1];
    if (last === 2) {
        // [N, 2] raw logits → softmax to get face-class probability
        const n = data.length / 2;
        const s = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const s0 = data[i * 2], s1 = data[i * 2 + 1];
            const em = Math.max(s0, s1);
            s[i] = Math.exp(s1 - em) / (Math.exp(s0 - em) + Math.exp(s1 - em));
        }
        return s;
    }
    // [N, 1] or [N] — values are already probabilities output by the model's
    // internal sigmoid; return them verbatim.
    return new Float32Array(data);
};

/** Non-maximum suppression. Returns kept detections sorted by score desc. */
const nms = (dets) => {
    dets.sort((a, b) => b.score - a.score);
    const kept = [];
    const sup  = new Set();
    for (let i = 0; i < dets.length; i++) {
        if (sup.has(i)) continue;
        kept.push(dets[i]);
        for (let j = i + 1; j < dets.length; j++)
            if (!sup.has(j) && iou(dets[i].box, dets[j].box) > NMS_THRESH)
                sup.add(j);
    }
    return kept;
};

/** Run RetinaFace and return all detected faces with landmarks. */
const detectFaces = async (imageBuffer, priority = "low") => {
    await ensureModels();

    const { width: origW, height: origH } = await sharp(imageBuffer).metadata();
    const scaleX = origW / DET_SIZE, scaleY = origH / DET_SIZE;

    const input   = await prepareDetInput(imageBuffer);
    const inName  = _detSession.inputNames[0];
    const results = await runOnnxQueued(_detSession, { [inName]: input }, priority);
    // outputNames order: [score_8, score_16, score_32, box_8, …, kps_8, …]
    const outs = _detSession.outputNames.map(n => results[n]);

    const all = [];
    for (let s = 0; s < FPN_STRIDES.length; s++) {
        const stride  = FPN_STRIDES[s];
        const centers = anchorCenters(stride);
        const scores  = toScores(outs[s]);
        const boxD    = outs[s + 3].data;   // [N, 4]
        const kpsD    = outs[s + 6].data;   // [N, 10]

        for (let i = 0; i < centers.length; i++) {
            if (scores[i] < DET_THRESH) continue;
            const [cx, cy] = centers[i];

            // Decode box (distance from anchor centre × stride)
            const x1 = (cx - boxD[i * 4 + 0] * stride) * scaleX;
            const y1 = (cy - boxD[i * 4 + 1] * stride) * scaleY;
            const x2 = (cx + boxD[i * 4 + 2] * stride) * scaleX;
            const y2 = (cy + boxD[i * 4 + 3] * stride) * scaleY;

            // Decode 5 landmarks
            const lms = [];
            for (let k = 0; k < 5; k++) {
                lms.push([
                    (cx + kpsD[i * 10 + k * 2]     * stride) * scaleX,
                    (cy + kpsD[i * 10 + k * 2 + 1] * stride) * scaleY,
                ]);
            }
            all.push({ score: scores[i], box: [x1, y1, x2, y2], landmarks: lms });
        }
    }
    return nms(all);
};

// ── ArcFace ───────────────────────────────────────────────────────────────────

/** Convert aligned RGB Buffer → float32 CHW tensor normalised to [−1, 1]. */
const prepareRecInput = (buf) => {
    const sz = FACE_SIZE * FACE_SIZE;
    const t  = new Float32Array(3 * sz);
    for (let i = 0; i < sz; i++) {
        t[i]          = (buf[i * 3]     - 127.5) / 128.0; // R  (InsightFace: (x-127.5)/128)
        t[sz + i]     = (buf[i * 3 + 1] - 127.5) / 128.0; // G
        t[2 * sz + i] = (buf[i * 3 + 2] - 127.5) / 128.0; // B
    }
    return new ort.Tensor("float32", t, [1, 3, FACE_SIZE, FACE_SIZE]);
};

/** Return L2-normalised 512-dim ArcFace embedding for an aligned 112×112 face. */
const getEmbedding = async (alignedRgbBuf, priority = "low") => {
    const input   = prepareRecInput(alignedRgbBuf);
    const inName  = _recSession.inputNames[0];
    const result  = await runOnnxQueued(_recSession, { [inName]: input }, priority);
    const outName = _recSession.outputNames[0];
    return l2norm(Array.from(result[outName].data));
};

// ── Public API  (drop-in replacement — same interface as old faceService) ─────

/**
 * Normalise image orientation using EXIF metadata.
 *
 * Mobile cameras embed an orientation tag in the JPEG EXIF header instead of
 * rotating the raw pixels.  Without this step, a portrait photo shot on an
 * iPhone is stored as landscape with EXIF rotation=90°.  Sharp (and browsers)
 * auto-rotate for display, but our ONNX pipeline reads raw pixels — so the
 * face would appear sideways to the detector.
 *
 * Because both extractFaceDescriptor (selfie) and detectAllFaces (event photo)
 * call this helper, the orientation fix is applied consistently.  The same
 * image will always produce the same aligned pixels regardless of whether it
 * was uploaded from a browser (which may strip EXIF) or from the file system
 * (which preserves it), giving deterministic embeddings and reliable matching.
 */
const normalizeOrientation = (imageBuffer) =>
    sharp(imageBuffer).rotate().toBuffer();

/**
 * Extract a face descriptor from a guest selfie.
 * Returns a 512-dim Float32 embedding (as plain Array), or null if no face found.
 */
// "high" priority — the guest is waiting for an HTTP response.
// This causes the inference to jump ahead of any queued batch photo jobs so
// registration responds within one photo's worth of inference time (≤ 45 s),
// not the full queue length (potentially hours during a large upload batch).
exports.extractFaceDescriptor = async (imageBuffer) => {
    const buf   = await normalizeOrientation(imageBuffer);
    const faces = await detectFaces(buf, "high");
    if (!faces.length) return null;

    // Use the highest-confidence detection (NMS already sorted by score)
    const { landmarks, box } = faces[0];
    const aligned = await alignFace(buf, landmarks, box);
    return getEmbedding(aligned, "high");
};

/**
 * Detect every face in an event photo and return embeddings + bounding boxes.
 * This is called by the job worker for uploaded photos.
 */
exports.detectAllFaces = async (imageBuffer) => {
    const buf   = await normalizeOrientation(imageBuffer);
    const faces = await detectFaces(buf);
    if (!faces.length) return [];

    // NMS already sorted faces by confidence score (highest first).

    // Drop faces whose bounding box is narrower or shorter than MIN_FACE_PX.
    // Such faces are too small to warp reliably to 112×112 — the upsampling
    // introduces blocking artefacts that degrade ArcFace embeddings and cause
    // random false-positive or false-negative matches.  For group shots the
    // distant faces below this size are usually not the registered selfie anyway.
    const sizable = faces.filter(({ box: [x1, y1, x2, y2] }) =>
        (x2 - x1) >= MIN_FACE_PX && (y2 - y1) >= MIN_FACE_PX
    );

    // Cap at MAX_FACES_PER_PHOTO before running ArcFace: a corrupted image or
    // preprocessing bug can produce thousands of phantom detections, each
    // requiring a separate ArcFace inference (~0.4 s on CPU).  8 546 phantoms
    // = 63 min; with the cap the worst case is 200 × 0.4 s = 80 s.
    const capped = sizable.length > MAX_FACES_PER_PHOTO
        ? sizable.slice(0, MAX_FACES_PER_PHOTO)
        : sizable;
    if (faces.length > MAX_FACES_PER_PHOTO) {
        console.warn(
            `[FaceService] Detected ${faces.length} faces — capping at ${MAX_FACES_PER_PHOTO}. ` +
            `This may indicate a corrupted image or a preprocessing issue.`
        );
    }

    const results = [];
    for (const { box, landmarks } of capped) {
        const aligned    = await alignFace(buf, landmarks, box);
        const descriptor = await getEmbedding(aligned);
        const [x1, y1, x2, y2] = box;
        results.push({
            descriptor,
            box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        });
    }
    return results;
};

/**
 * Build a face matcher from a list of guest documents.
 * Returns an object with findBestMatch(descriptor) → { label, distance }
 * — identical interface to the old face-api FaceMatcher so matchService.js
 *   needs no changes.
 *
 * ArcFace embeddings are L2-normalised, so dot-product = cosine similarity.
 * `distance` is returned as  1 − similarity  so that lower = better match,
 * consistent with the confidence = 1 − distance formula in matchService.js.
 */
exports.computeFaceMatcher = (guests) => {
    const gallery = guests.map(g => ({
        id:  g._id.toString(),
        emb: l2norm(Array.from(g.faceDescriptor)),
    }));

    return {
        findBestMatch(queryDescriptor) {
            const query = l2norm(Array.from(queryDescriptor));
            let bestId  = "unknown";
            let bestSim = -Infinity;

            for (const { id, emb } of gallery) {
                const sim = cosine(query, emb);
                if (sim > bestSim) { bestSim = sim; bestId = id; }
            }

            if (bestSim < MATCH_THRESHOLD)
                return { label: "unknown", distance: 1 - bestSim };

            return { label: bestId, distance: 1 - bestSim };
        },
    };
};
