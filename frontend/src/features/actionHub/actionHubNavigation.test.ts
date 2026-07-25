import { describe, expect, it } from "vitest";
import { callSearchRoute, isActiveScreenShareState, validateQuickConnect } from "./actionHubNavigation";

describe("Action Hub navigation", () => {
  it("validates and normalizes screen-share codes", () => {
    expect(validateQuickConnect("screen", "12 34-5678")).toEqual({ valid: true, value: "12345678" });
    expect(validateQuickConnect("screen", "1234").valid).toBe(false);
  });

  it("validates AI commands and contact searches", () => {
    expect(validateQuickConnect("ai", "  explain this  ")).toEqual({ valid: true, value: "explain this" });
    expect(validateQuickConnect("voice", "x").valid).toBe(false);
    expect(validateQuickConnect("video", " shyam ")).toEqual({ valid: true, value: "shyam" });
  });

  it("builds an encoded call handoff route", () => {
    expect(callSearchRoute("Shyam Raj", "video")).toBe("/calls?view=search&type=video&q=Shyam+Raj");
  });

  it("recognizes only live screen-share states", () => {
    expect(isActiveScreenShareState("active")).toBe(true);
    expect(isActiveScreenShareState("reconnecting")).toBe(true);
    expect(isActiveScreenShareState("ended")).toBe(false);
  });
});
