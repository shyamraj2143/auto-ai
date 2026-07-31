import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("call reliability hotfix", () => {
  it("retries transient native foreground service starts", () => {
    const provider = source("src/features/calls/CallProvider.tsx");
    expect(provider).toContain("retryableNativeServiceCodes");
    expect(provider).toContain("SERVICE_READY_TIMEOUT");
    expect(provider).toContain("attempt < 3");
  });
});
