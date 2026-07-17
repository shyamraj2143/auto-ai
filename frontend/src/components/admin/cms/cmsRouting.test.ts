import { describe, expect, it } from "vitest";
import { cmsSectionFromPath } from "./cmsRouting";

describe("cmsSectionFromPath", () => {
  it("opens Forms as the forms editor instead of retaining the page editor", () => {
    expect(cmsSectionFromPath("/admin/website-builder/forms")).toBe("forms");
    expect(cmsSectionFromPath("/admin/website-builder/pages/contact-page-id")).toBe("pages");
  });

  it("maps live page editor routes separately from website builder routes", () => {
    expect(cmsSectionFromPath("/admin/live-pages")).toBe("live");
    expect(cmsSectionFromPath("/admin/live-pages/page-id")).toBe("live");
  });
});
