const path = require("path");
const fs = require("fs");
const canvas = require("canvas");

let faceapi = null;
let initializationError = null;
let modelsLoaded = false;

const patchNodeUtilCompatibility = () => {
    const nodeUtil = require("util");
    if (typeof nodeUtil.isNullOrUndefined !== "function") {
        nodeUtil.isNullOrUndefined = (value) => value === null || value === undefined;
    }
};

const initializeFaceApi = () => {
    if (faceapi || initializationError) return;
    try {
        patchNodeUtilCompatibility();
        faceapi = require("@vladmandic/face-api");
        const { Canvas, Image, ImageData } = canvas;
        faceapi.env.monkeyPatch({ Canvas, Image, ImageData });
    } catch (error) {
        initializationError = error;
    }
};

const ensureFaceApiReady = async () => {
    initializeFaceApi();
    if (initializationError || !faceapi) {
        throw new Error(
            "Face recognition is unavailable: install @tensorflow/tfjs-node in backend and restart the server."
        );
    }

    if (modelsLoaded) return;
    const modelPath = path.join(__dirname, "../weights");
    hydrateWeightsFromPackage(modelPath);
    ensureLegacyWeightFiles(modelPath);
    validateWeightFiles(modelPath);
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
    modelsLoaded = true;
    console.log("Face-api models loaded");
};

const hydrateWeightsFromPackage = (modelPath) => {
    const packageModelPath = path.join(__dirname, "../node_modules/@vladmandic/face-api/model");
    if (!fs.existsSync(packageModelPath)) return;

    const requiredFiles = [
        "ssd_mobilenetv1_model.bin",
        "ssd_mobilenetv1_model-weights_manifest.json",
        "face_landmark_68_model.bin",
        "face_landmark_68_model-weights_manifest.json",
        "face_recognition_model.bin",
        "face_recognition_model-weights_manifest.json",
    ];

    for (const fileName of requiredFiles) {
        const sourcePath = path.join(packageModelPath, fileName);
        const targetPath = path.join(modelPath, fileName);
        if (!fs.existsSync(sourcePath)) continue;
        if (!fs.existsSync(targetPath)) {
            fs.copyFileSync(sourcePath, targetPath);
            continue;
        }

        const sourceSize = fs.statSync(sourcePath).size;
        const targetSize = fs.statSync(targetPath).size;
        if (targetSize < sourceSize) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
};

const ensureLegacyWeightFiles = (modelPath) => {
    const mappings = [
        ["ssd_mobilenetv1_model-shard1", "ssd_mobilenetv1_model.bin"],
        ["face_landmark_68_model-shard1", "face_landmark_68_model.bin"],
        ["face_recognition_model-shard1", "face_recognition_model.bin"],
    ];

    for (const [legacyName, expectedName] of mappings) {
        const legacyPath = path.join(modelPath, legacyName);
        const expectedPath = path.join(modelPath, expectedName);
        if (!fs.existsSync(expectedPath) && fs.existsSync(legacyPath)) {
            fs.copyFileSync(legacyPath, expectedPath);
        }
    }
};

const validateWeightFiles = (modelPath) => {
    const manifests = [
        "ssd_mobilenetv1_model-weights_manifest.json",
        "face_landmark_68_model-weights_manifest.json",
        "face_recognition_model-weights_manifest.json",
    ];

    const sizeByDtype = { float32: 4, int32: 4, bool: 1 };
    const sizeByQuantizedType = { uint8: 1, uint16: 2, float16: 2 };

    for (const manifestName of manifests) {
        const manifestPath = path.join(modelPath, manifestName);
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`Missing weights manifest: ${manifestPath}`);
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const expectedBytes = manifest.reduce((groupAcc, group) => {
            const groupBytes = group.weights.reduce((acc, weight) => {
                const elements = (weight.shape || []).reduce((mul, n) => mul * n, 1) || 1;
                const bytesPerElement = weight.quantization
                    ? (sizeByQuantizedType[weight.quantization.dtype] || 4)
                    : (sizeByDtype[weight.dtype] || 4);
                return acc + (elements * bytesPerElement);
            }, 0);
            return groupAcc + groupBytes;
        }, 0);

        const actualBytes = manifest.reduce((groupAcc, group) => {
            const groupBytes = (group.paths || []).reduce((acc, fileName) => {
                const filePath = path.join(modelPath, fileName);
                if (!fs.existsSync(filePath)) return acc;
                return acc + fs.statSync(filePath).size;
            }, 0);
            return groupAcc + groupBytes;
        }, 0);

        if (actualBytes < expectedBytes) {
            throw new Error(
                `Incomplete face-api weights for ${manifestName}. Expected ${expectedBytes} bytes, found ${actualBytes}. ` +
                `Re-download model files in backend/weights (ssd_mobilenetv1_model.bin and face_recognition_model.bin are likely incomplete).`
            );
        }
    }
};

exports.extractFaceDescriptor = async (imageBuffer) => {
    await ensureFaceApiReady();
    const img = await canvas.loadImage(imageBuffer);
    const detection = await faceapi
        .detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

    if (!detection) return null;
    return Array.from(detection.descriptor);
};

exports.detectAllFaces = async (imageBuffer) => {
    await ensureFaceApiReady();
    const img = await canvas.loadImage(imageBuffer);
    const detections = await faceapi
        .detectAllFaces(img)
        .withFaceLandmarks()
        .withFaceDescriptors();

    return detections.map((d) => ({
        descriptor: Array.from(d.descriptor),
        box: {
            x: d.detection.box.x,
            y: d.detection.box.y,
            width: d.detection.box.width,
            height: d.detection.box.height,
        },
    }));
};

exports.computeFaceMatcher = (guests) => {
    initializeFaceApi();
    if (initializationError || !faceapi) {
        throw new Error(
            "Face matching is unavailable: install @tensorflow/tfjs-node in backend and restart the server."
        );
    }
    const labeledDescriptors = guests.map((guest) => {
        return new faceapi.LabeledFaceDescriptors(guest._id.toString(), [
            new Float32Array(guest.faceDescriptor),
        ]);
    });
    return new faceapi.FaceMatcher(labeledDescriptors, 0.6); // 0.6 is distance threshold
};
