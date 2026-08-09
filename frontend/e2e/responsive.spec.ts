import { expect, test, type Page, type Route } from "@playwright/test";

const viewports = [
  { name: "320x568", width: 320, height: 568 },
  { name: "360x640", width: 360, height: 640 },
  { name: "360x780", width: 360, height: 780 },
  { name: "375x667", width: 375, height: 667 },
  { name: "393x873", width: 393, height: 873 },
  { name: "412x915", width: 412, height: 915 },
  { name: "480x854", width: 480, height: 854 },
  { name: "600x960", width: 600, height: 960 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "568x320-landscape", width: 568, height: 320 },
  { name: "915x412-landscape", width: 915, height: 412 },
] as const;

const sections = ["search", "requests", "chats", "calls", "alerts"] as const;
const now = "2026-07-28T12:00:00Z";
const user = { id: "user-1", email: "responsive@autoai.test", name: "Responsive User", username: "responsive", provider: "email", is_admin: false, role: "user", subscription_status: "free", created_at: now, updated_at: now };
const peer = { id: "user-2", display_name: "Aarav Example With A Long Display Name", username: "aarav_long_username", avatar_url: null, bio: "Connected contact", is_private: false, follow_status: "accepted", can_message: true, can_audio_call: true, can_video_call: true, profile_restricted: false, presence: "online", availability: "Available" };

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installAuthenticatedFixtures(page: Page) {
  page.on("pageerror", (error) => console.error("PAGE_ERROR", error.message));
  await page.addInitScript(() => localStorage.setItem("auto-ai-access-token", "responsive-test-token"));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("/content/public/announcements")) return json(route, []);
    if (path.endsWith("/auth/me") || path.endsWith("/users/me")) return json(route, user);
    if (path.endsWith("/chat/sessions")) return json(route, []);
    if (path.endsWith("/documents")) return json(route, []);
    if (path.endsWith("/ai/generations/active")) return json(route, []);
    if (path.endsWith("/ai/research-models")) return json(route, {
      providers: {
        groq: { enabled: true, models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] },
        bedrock: { enabled: true, models: ["amazon.nova-pro-v1:0"] },
        openai: { enabled: true, models: ["gpt-5"] },
        gemini: { enabled: true, models: ["gemini-2.5-pro"] },
      },
      defaults: { max_models: 6, timeout_seconds: 45, final_judge_model: null },
    });
    if (path.endsWith("/ai/intelligence/config")) return json(route, {
      modes: {
        instant: { available: true, description: "Fast single-model response" },
        medium: { available: true, description: "Balanced parallel intelligence" },
        high: { available: true, description: "Advanced multi-provider reasoning" },
        deep_research: { available: true, description: "Source-backed comprehensive research" },
        coding: { available: true, description: "Two Qwen Coder models collaborate on coding tasks." },
      },
      models: [],
      refreshed: true,
    });
    if (path.endsWith("/calls/config")) return json(route, { enabled: false, realtime_configured: false, turn_configured: false, firebase_configured: false, ring_timeout_seconds: 30, reconnect_grace_seconds: 10 });
    if (path.endsWith("/calls/history")) return json(route, { items: [{ id: "call-1", caller_id: "user-2", callee_id: "user-1", call_type: "audio", status: "missed", created_at: now, duration_seconds: 0, direction: "incoming", peer }], page: 1, limit: 20, has_more: false });
    if (path.includes("/social/requests/incoming")) return json(route, { items: [{ id: "request-1", status: "pending", requested_at: now, user: peer }], page: 1, limit: 30, has_more: false });
    if (path.includes("/social/requests/sent") || path.includes("/social/requests/history")) return json(route, { items: [], page: 1, limit: 30, has_more: false });
    if (path.includes("/social/connections")) return json(route, { items: [peer], page: 1, limit: 30, has_more: false, unread_notifications: 1 });
    if (path.includes("/social/notifications")) return json(route, { items: [{ id: "notice-1", notification_type: "follow_request", target_type: "follow_requests", target_id: "request-1", title: "Aarav requested to follow you", body: "Review the request", created_at: now, actor: peer }], page: 1, limit: 30, has_more: false, unread_count: 1 });
    if (path.includes("/social/search-history")) return json(route, []);
    if (path.endsWith("/messages")) return json(route, { items: [], page: 1, limit: 30, has_more: false });
    if (path.endsWith("/messages/settings")) return json(route, {});
    return json(route, {});
  });
}

async function openRoute(page: Page, route: string) {
  await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

async function assertNoFunctionalOverflow(page: Page) {
  const measurement = await page.evaluate(() => {
    const root = document.documentElement;
    const clipped = Array.from(document.querySelectorAll<HTMLElement>("button,input,select,textarea,a,[role='button'],[role='tab']"))
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (element.closest("[aria-hidden='true'],[data-open='false']")) return false;
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .map((element) => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 40), rect: element.getBoundingClientRect().toJSON() }));
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, clipped };
  });
  expect(measurement.scrollWidth, JSON.stringify(measurement)).toBeLessThanOrEqual(measurement.clientWidth + 1);
  expect(measurement.clipped, JSON.stringify(measurement)).toEqual([]);
}

for (const viewport of viewports) {
  test(`Call Hub has no overflow at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installAuthenticatedFixtures(page);
    await openRoute(page, "/call-hub/search");
    await expect(page.getByText("Call Hub", { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await assertNoFunctionalOverflow(page);
    await page.screenshot({ path: `../output/playwright/responsive-call-hub-${viewport.name}.png`, fullPage: true });
  });
}

for (const viewport of viewports) {
  for (const surface of [
    { name: "AI Chat", route: "/chat", locator: ".composer-shell" },
    { name: "Messages", route: "/messages", locator: ".um-page" },
  ]) {
    test(`${surface.name} has no overflow at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installAuthenticatedFixtures(page);
      await openRoute(page, surface.route);
      await expect(page.locator(surface.locator)).toBeVisible();
      await assertNoFunctionalOverflow(page);
      if (viewport.name === "393x873") {
        await page.screenshot({ path: `../output/playwright/responsive-${surface.name.toLowerCase().replace(" ", "-")}-393x873.png`, fullPage: true });
      }
    });
  }
}

test("preset selection stays collapsed without manual model controls", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 873 });
  await installAuthenticatedFixtures(page);
  await openRoute(page, "/chat");
  for (const preset of ["Medium", "High", "Deep Research", "Coding"]) {
    await page.getByRole("button", { name: /^(Auto|Instant|Medium|High|Deep Research|Coding)$/ }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${preset}`) }).click();
    await expect(page.locator("#composer-mode-popover")).toHaveCount(0);
  }
  await expect(page.getByText(/Configure models/i)).toHaveCount(0);
  await expect(page.getByText(/Up to 6/i)).toHaveCount(0);
  await assertNoFunctionalOverflow(page);
});

test("chat direct route renders the network-independent inline logo", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await installAuthenticatedFixtures(page);
  await openRoute(page, "/chat");

  const logo = page.locator(".workspace-sidebar .app-logo, .autoai-workspace-brand .app-logo").first();
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((element) => element.tagName.toLowerCase())).toBe("svg");
  expect(await logo.getAttribute("data-autoai-logo")).toBe("inline");
  expect(await logo.getAttribute("viewBox")).toBe("0 0 64 64");
  await expect(page.locator("img.app-logo")).toHaveCount(0);
});

test("AI response card keeps a stable service surface on pointer press", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 873 });
  await installAuthenticatedFixtures(page);
  await openRoute(page, "/chat");

  await page.evaluate(() => {
    const row = document.createElement("article");
    row.className = "message-row message-row-assistant";
    row.innerHTML = '<div class="message-content-stack"><div class="message-card message-card-ai"><p>Stable response</p></div></div>';
    document.body.appendChild(row);
  });

  const card = page.locator(".message-card-ai", { hasText: "Stable response" });
  await expect(card).toBeVisible();
  const before = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    const after = getComputedStyle(element, "::after");
    return { background: style.backgroundImage, shadow: style.boxShadow, after: after.content };
  });
  await card.dispatchEvent("pointerdown");
  const after = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    const pseudo = getComputedStyle(element, "::after");
    return { background: style.backgroundImage, shadow: style.boxShadow, after: pseudo.content };
  });

  expect(after.background).toBe(before.background);
  expect(after.shadow).toBe(before.shadow);
  expect(after.after === "none" || after.after === "normal").toBe(true);
});

for (const section of sections) {
  test(`Call Hub ${section} section is responsive`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 873 });
    await installAuthenticatedFixtures(page);
    await openRoute(page, `/call-hub/${section}`);
    await expect(page.locator(".pulse-connect-nav [aria-current='page']").filter({ hasText: new RegExp(section, "i") })).toBeVisible();
    await page.waitForTimeout(500);
    await assertNoFunctionalOverflow(page);
    await page.screenshot({ path: `../output/playwright/call-hub-${section}-393x873.png`, fullPage: true });
  });
}

for (const scale of [1, 1.15, 1.3, 1.5]) {
  test(`Call Hub wraps at font scale ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await installAuthenticatedFixtures(page);
    await openRoute(page, "/call-hub/requests");
    await page.locator("html").evaluate((element, value) => { element.style.fontSize = `${Number(value) * 100}%`; }, scale);
    await assertNoFunctionalOverflow(page);
  });
}

test("public/auth/payment routes have no mobile page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 873 });
  await page.route("**/api/v1/**", (route) => json(route, {}));
  for (const route of ["/", "/login", "/register", "/reset-password", "/download", "/pricing", "/payment/success", "/payment/failed"]) {
    await openRoute(page, route);
    await page.waitForTimeout(250);
    await assertNoFunctionalOverflow(page);
  }
});

test("clear history confirmation has no functional logo", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 873 });
  await installAuthenticatedFixtures(page);
  await openRoute(page, "/call-hub/search");
  await expect(page.locator(".calls-tab .app-logo,.calls-tab .brand-logo,.calls-tab [data-brand-logo]")).toHaveCount(0);
  const oversized = await page.locator(".calls-tab img").evaluateAll((images) => images.filter((image) => image.getBoundingClientRect().width > 48 || image.getBoundingClientRect().height > 48).length);
  expect(oversized).toBe(0);
});
