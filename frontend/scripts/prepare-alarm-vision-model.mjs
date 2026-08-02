import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const MODEL_BYTES = 3_758_596;
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = resolve(frontendRoot, "public/models/face_landmarker.task");
const temporaryPath = `${modelPath}.download`;

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isVerified(content) {
  return content.length === MODEL_BYTES && digest(content) === MODEL_SHA256;
}

if (existsSync(modelPath) && isVerified(readFileSync(modelPath))) {
  console.log("Verified cached offline alarm face model.");
  process.exit(0);
}

mkdirSync(dirname(modelPath), { recursive: true });

try {
  const response = await fetch(MODEL_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download returned HTTP ${response.status}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!isVerified(content)) {
    throw new Error(`integrity check failed (bytes=${content.length}, sha256=${digest(content)})`);
  }
  writeFileSync(temporaryPath, content, { mode: 0o644 });
  renameSync(temporaryPath, modelPath);
  console.log(`Downloaded and verified offline alarm face model (${MODEL_BYTES} bytes).`);
} catch (error) {
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  throw new Error(`Unable to prepare the offline alarm face model: ${error instanceof Error ? error.message : String(error)}`);
}
