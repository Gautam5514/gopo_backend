#!/usr/bin/env node
"use strict";

/**
 * Downloads the InsightFace buffalo_l model pack and extracts the two ONNX
 * files needed for face detection (RetinaFace) and recognition (ArcFace).
 *
 *   node backend/scripts/downloadModels.js
 */

const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const AdmZip   = require("adm-zip");

const OUT_DIR   = path.join(__dirname, "../models/buffalo_l");
const ZIP_TMP   = path.join(OUT_DIR, "_buffalo_l.zip");
const NEEDED    = ["det_10g.onnx", "w600k_r50.onnx"];
const ZIP_URL   = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";

const alreadyPresent = () => NEEDED.every(f => fs.existsSync(path.join(OUT_DIR, f)));

// Follow HTTP redirects
const download = (url, dest) =>
    new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        let receivedBytes = 0;
        let totalBytes    = 0;
        let lastPct       = -1;

        const get = (u) => {
            const mod = u.startsWith("https") ? https : http;
            mod.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return get(res.headers.location); // follow redirect
                }
                if (res.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(dest);
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }
                totalBytes = parseInt(res.headers["content-length"] || "0", 10);
                res.on("data", (chunk) => {
                    receivedBytes += chunk.length;
                    if (totalBytes > 0) {
                        const pct = Math.floor((receivedBytes / totalBytes) * 100);
                        if (pct !== lastPct && pct % 5 === 0) {
                            process.stdout.write(`\r  Downloading… ${pct}%`);
                            lastPct = pct;
                        }
                    }
                });
                res.pipe(file);
                file.on("finish", () => { file.close(); process.stdout.write("\n"); resolve(); });
            }).on("error", (err) => { file.close(); fs.unlinkSync(dest); reject(err); });
        };

        get(url);
    });

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    if (alreadyPresent()) {
        console.log("✅ buffalo_l models already present — nothing to download.");
        return;
    }

    console.log("⬇️  Downloading buffalo_l model pack (~180 MB)…");
    console.log(`   URL: ${ZIP_URL}`);
    await download(ZIP_URL, ZIP_TMP);

    console.log("📦 Extracting ONNX models…");
    const zip = new AdmZip(ZIP_TMP);
    const entries = zip.getEntries();

    for (const entry of entries) {
        const base = path.basename(entry.entryName);
        if (NEEDED.includes(base)) {
            const outPath = path.join(OUT_DIR, base);
            zip.extractEntryTo(entry, OUT_DIR, false, true);
            const size = (fs.statSync(outPath).size / 1_048_576).toFixed(1);
            console.log(`  ✓ ${base}  (${size} MB)`);
        }
    }

    fs.unlinkSync(ZIP_TMP);
    console.log("✅ Models ready in backend/models/buffalo_l/");
})().catch((err) => {
    console.error("❌ Download failed:", err.message);
    if (fs.existsSync(ZIP_TMP)) fs.unlinkSync(ZIP_TMP);
    process.exit(1);
});
