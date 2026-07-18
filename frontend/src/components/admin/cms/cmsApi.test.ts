import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../../../api/client";
import { withCmsDraftRetry } from "./cmsApi";

describe("CMS draft retry policy", () => {
  it("retries a transient network failure once", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new ApiClientError("offline", { kind: "server_unreachable" }))
      .mockResolvedValueOnce("saved");

    await expect(withCmsDraftRetry(operation, 0)).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry validation errors", async () => {
    const validationError = new ApiClientError("invalid", { kind: "http_error", status: 422 });
    const operation = vi.fn().mockRejectedValue(validationError);

    await expect(withCmsDraftRetry(operation, 0)).rejects.toBe(validationError);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
