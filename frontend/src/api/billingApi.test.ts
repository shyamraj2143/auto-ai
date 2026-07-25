import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("billing API query contracts", () => {
  it("sends user payment search, status, and pagination to the server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], page: 2, page_size: 20, total: 0, total_pages: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.paymentHistory("token", { query: "AA-100", status: "success", page: 2, pageSize: 20 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/payments/history?");
    expect(url).toContain("query=AA-100");
    expect(url).toContain("status=success");
    expect(url).toContain("page=2");
  });

  it("sends admin payment filters to the protected admin endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], page: 1, page_size: 20, total: 0, total_pages: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.adminPayments("admin-token", { query: "user@example.test", status: "failed" });

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/admin/subscriptions/payments?");
    expect(String(url)).toContain("status=failed");
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("cancels an owned payment session through the authenticated endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.cancelPaymentSession("token", "session/id");

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/payments/sessions/session%2Fid/cancel");
    expect(options.method).toBe("POST");
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer token");
  });
});
