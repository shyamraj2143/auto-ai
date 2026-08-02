import { describe, expect, it } from "vitest";
import { awakeFailureSpeech, awakeSuccessSpeech } from "./alarmSpeech";
import { evaluateAwakeSnapshot, type AwakeLandmark, type AwakeSnapshot } from "./awakeEvaluation";

function landmarks(): AwakeLandmark[] {
  const points = Array.from({ length: 478 }, (_, index) => ({
    x: .35 + (index % 20) / 19 * .30,
    y: .25 + (Math.floor(index / 20) % 20) / 19 * .50,
    z: 0,
  }));
  points[33] = { x: .40, y: .45, z: 0 };
  points[263] = { x: .60, y: .45, z: 0 };
  points[1] = { x: .50, y: .52, z: 0 };
  return points;
}

function awakeSnapshot(overrides: Partial<AwakeSnapshot> = {}): AwakeSnapshot {
  return {
    faceCount: 1,
    landmarks: landmarks(),
    blinkLeft: .08,
    blinkRight: .09,
    brightness: 118,
    contrast: 38,
    edgeStrength: 12,
    ...overrides,
  };
}

describe("offline awake verification", () => {
  it("accepts one centered face with both eyes clearly open", () => {
    const result = evaluateAwakeSnapshot(awakeSnapshot());
    expect(result.awake).toBe(true);
    expect(result.model).toBe("mediapipe-face-landmarker-offline");
    expect(result.confidence).toBeGreaterThan(.75);
  });

  it("rejects closed eyes, missing faces and unclear captures", () => {
    expect(evaluateAwakeSnapshot(awakeSnapshot({ blinkLeft: .82, blinkRight: .77 })).code).toBe("eyes_closed");
    expect(evaluateAwakeSnapshot(awakeSnapshot({ faceCount: 0, landmarks: [] })).code).toBe("no_face");
    expect(evaluateAwakeSnapshot(awakeSnapshot({ brightness: 8 })).code).toBe("image_quality");
  });

  it("speaks an alarm-stays-on warning and an AI Chat success handoff", () => {
    const alarm = { title: "रेलवे परीक्षा की तैयारी", language: "hinglish-IN" as const };
    expect(awakeFailureSpeech("eyes_closed", alarm.language)).toContain("अलार्म बंद नहीं होगा");
    expect(awakeFailureSpeech("eyes_closed", alarm.language)).toContain("सोए हुए");
    expect(awakeSuccessSpeech(alarm)).toContain("AI Chat");
    expect(awakeSuccessSpeech(alarm)).toContain("रेलवे परीक्षा की तैयारी");
  });
});
