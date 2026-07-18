import { describe, expect, it } from "vitest";
import { decideOceanNavigation, type OceanNavigationInput } from "./oceanNavigation";

const baseInput: OceanNavigationInput = {
  currentPath: "/",
  destinationPath: "/login",
  sameOrigin: true,
  button: 0,
  modified: false,
  opensNewContext: false,
  download: false,
  defaultPrevented: false,
  reducedMotion: false,
  navigationPending: false
};

describe("ocean auth navigation", () => {
  it("animates ordinary login, signup, and auth cross-navigation", () => {
    expect(decideOceanNavigation(baseInput)).toBe("animate");
    expect(decideOceanNavigation({ ...baseInput, destinationPath: "/register" })).toBe("animate");
    expect(decideOceanNavigation({ ...baseInput, currentPath: "/login", destinationPath: "/register" })).toBe("animate");
    expect(decideOceanNavigation({ ...baseInput, currentPath: "/register", destinationPath: "/login" })).toBe("animate");
  });

  it("preserves modifier, middle-click, target and download browser behavior", () => {
    expect(decideOceanNavigation({ ...baseInput, modified: true })).toBe("ignore");
    expect(decideOceanNavigation({ ...baseInput, button: 1 })).toBe("ignore");
    expect(decideOceanNavigation({ ...baseInput, opensNewContext: true })).toBe("ignore");
    expect(decideOceanNavigation({ ...baseInput, download: true })).toBe("ignore");
  });

  it("uses a short dissolve only for reduced motion", () => {
    expect(decideOceanNavigation({ ...baseInput, reducedMotion: true })).toBe("dissolve");
  });

  it("blocks duplicate navigation while a dive is already pending", () => {
    expect(decideOceanNavigation({ ...baseInput, navigationPending: true })).toBe("block");
  });

  it("does not intercept unrelated, same-route, or cross-origin links", () => {
    expect(decideOceanNavigation({ ...baseInput, destinationPath: "/pricing" })).toBe("ignore");
    expect(decideOceanNavigation({ ...baseInput, sameOrigin: false })).toBe("ignore");
    expect(decideOceanNavigation({ ...baseInput, currentPath: "/login", destinationPath: "/login" })).toBe("ignore");
  });
});
