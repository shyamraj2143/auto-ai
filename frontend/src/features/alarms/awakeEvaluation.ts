export type AwakeFailureCode =
  | "none"
  | "no_face"
  | "multiple_faces"
  | "face_small"
  | "head_pose"
  | "eyes_closed"
  | "image_quality"
  | "detector_unavailable";

export type AwakeLandmark = { x: number; y: number; z?: number };

export type AwakeSnapshot = {
  faceCount: number;
  landmarks: AwakeLandmark[];
  blinkLeft: number | null;
  blinkRight: number | null;
  brightness: number;
  contrast: number;
  edgeStrength: number;
};

export type LocalAwakeDecision = {
  awake: boolean;
  confidence: number;
  code: AwakeFailureCode;
  reason: string;
  model: "mediapipe-face-landmarker-offline";
};

const MODEL = "mediapipe-face-landmarker-offline" as const;

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function failed(code: AwakeFailureCode, reason: string, confidence = 0): LocalAwakeDecision {
  return { awake: false, confidence: clamp(confidence), code, reason, model: MODEL };
}

export function evaluateAwakeSnapshot(snapshot: AwakeSnapshot): LocalAwakeDecision {
  if (snapshot.faceCount === 0) return failed("no_face", "No face found. Look directly at the front camera.");
  if (snapshot.faceCount !== 1) return failed("multiple_faces", "Keep only your face in the frame and capture again.");
  if (snapshot.landmarks.length < 264) return failed("detector_unavailable", "Your face could not be checked clearly. Capture again.");
  if (snapshot.brightness < 32 || snapshot.brightness > 238 || snapshot.contrast < 13 || snapshot.edgeStrength < 3.8) {
    return failed("image_quality", "Use better light and hold the camera steady, then capture again.");
  }

  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of snapshot.landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const faceRatio = width * height;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  if (faceRatio < .052 || width < .20 || height < .24) {
    return failed("face_small", "Move closer so your face fills more of the frame.", faceRatio / .052);
  }
  if (centerX < .20 || centerX > .80 || centerY < .16 || centerY > .84) {
    return failed("head_pose", "Center your face and look directly at the camera.", .35);
  }

  const rightEye = snapshot.landmarks[33];
  const leftEye = snapshot.landmarks[263];
  const nose = snapshot.landmarks[1];
  const eyeDistance = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y);
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const roll = Math.abs(Math.atan2(leftEye.y - rightEye.y, leftEye.x - rightEye.x) * 180 / Math.PI);
  const yawOffset = eyeDistance > .001 ? Math.abs(nose.x - eyeMidX) / eyeDistance : 1;
  if (roll > 18 || yawOffset > .32) {
    return failed("head_pose", "Hold your head straight and look directly at the camera.", clamp(1 - roll / 45 - yawOffset / 2));
  }

  if (snapshot.blinkLeft == null || snapshot.blinkRight == null) {
    return failed("eyes_closed", "Keep both eyes clearly visible and capture again.", .25);
  }
  const leftBlink = clamp(snapshot.blinkLeft);
  const rightBlink = clamp(snapshot.blinkRight);
  const averageBlink = (leftBlink + rightBlink) / 2;
  const openScore = clamp(1 - Math.max(leftBlink, rightBlink));
  const confidence = clamp(openScore * .74 + Math.min(1, faceRatio / .18) * .16 + clamp(1 - roll / 30) * .10);
  if (leftBlink > .44 || rightBlink > .44 || averageBlink > .36) {
    return failed("eyes_closed", "Open both eyes and capture again to confirm you are awake.", confidence);
  }
  return {
    awake: true,
    confidence,
    code: "none",
    reason: "On-device face and open-eye check passed.",
    model: MODEL,
  };
}
