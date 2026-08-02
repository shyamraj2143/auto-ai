import { FaceLandmarker, type Category } from "@mediapipe/tasks-vision";
import wasmLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import { evaluateAwakeSnapshot, type LocalAwakeDecision } from "./awakeEvaluation";

const modelAssetUrl = `${import.meta.env.BASE_URL}models/face_landmarker.task`;
let detectorPromise: Promise<FaceLandmarker> | null = null;

function detector() {
  detectorPromise ??= FaceLandmarker.createFromOptions(
    { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl },
    {
      baseOptions: { modelAssetPath: modelAssetUrl, delegate: "CPU" },
      runningMode: "IMAGE",
      numFaces: 2,
      minFaceDetectionConfidence: .62,
      minFacePresenceConfidence: .62,
      minTrackingConfidence: .55,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    },
  ).catch((error) => {
    detectorPromise = null;
    throw error;
  });
  return detectorPromise;
}

function categoryScore(categories: Category[] | undefined, name: string) {
  const found = categories?.find((category) => category.categoryName === name);
  return found && Number.isFinite(found.score) ? found.score : null;
}

function imageQuality(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { brightness: 0, contrast: 0, edgeStrength: 0 };
  const width = Math.min(canvas.width, 360);
  const height = Math.max(1, Math.round(width * canvas.height / Math.max(1, canvas.width)));
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) return { brightness: 0, contrast: 0, edgeStrength: 0 };
  sampleContext.drawImage(canvas, 0, 0, width, height);
  const pixels = sampleContext.getImageData(0, 0, width, height).data;
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let edgeSum = 0;
  for (let y = 0; y < height; y += 3) {
    let previous = -1;
    for (let x = 0; x < width; x += 3) {
      const index = (y * width + x) * 4;
      const luminance = pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
      sum += luminance;
      sumSquares += luminance * luminance;
      if (previous >= 0) edgeSum += Math.abs(luminance - previous);
      previous = luminance;
      count += 1;
    }
  }
  const brightness = count ? sum / count : 0;
  const contrast = count ? Math.sqrt(Math.max(0, sumSquares / count - brightness * brightness)) : 0;
  const edgeStrength = count ? edgeSum / count : 0;
  return { brightness, contrast, edgeStrength };
}

export async function prewarmWebAwakeVerifier() {
  await detector();
}

export async function verifyAwakeOnDevice(canvas: HTMLCanvasElement): Promise<LocalAwakeDecision> {
  try {
    const landmarker = await detector();
    const result = landmarker.detect(canvas);
    const faceCount = result.faceLandmarks.length;
    const categories = result.faceBlendshapes[0]?.categories;
    return evaluateAwakeSnapshot({
      faceCount,
      landmarks: result.faceLandmarks[0] ?? [],
      blinkLeft: categoryScore(categories, "eyeBlinkLeft"),
      blinkRight: categoryScore(categories, "eyeBlinkRight"),
      ...imageQuality(canvas),
    });
  } catch {
    return {
      awake: false,
      confidence: 0,
      code: "detector_unavailable",
      reason: "The private on-device face checker could not start. The alarm will keep ringing.",
      model: "mediapipe-face-landmarker-offline",
    };
  }
}
