import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-08-09T12:00:00Z";
const user = { id: "chat-user", email: "chat@autoai.test", name: "Asha Kumari", username: "asha", provider: "email", is_admin: false, role: "user", subscription_status: "free", created_at: now, updated_at: now };
const chats = [
  { id: "chat-today", title: "Mixed Hindi and English conversation", model: "llama-3.3-70b-versatile", mode: "instant", created_at: now, updated_at: now },
  { id: "chat-week", title: "A very long prior research conversation title that must truncate", model: "llama-3.3-70b-versatile", mode: "medium", created_at: "2026-08-04T12:00:00Z", updated_at: "2026-08-04T12:00:00Z" },
];
const populated = {
  ...chats[0], preset_mode: "auto", selected_preset: "instant", manual_preset_locked: false,
  messages: [
    { id: "message-user", role: "user", content: "कृपया इस long English request को clearly explain करें।", created_at: "2026-08-09T11:58:00Z" },
    { id: "message-ai", role: "assistant", content: "## साफ़ उत्तर\n\nThis is a readable mixed-language response.\n\n```typescript\nconst longVariableName = 'This code remains horizontally scrollable without breaking the page';\n```\n\n| Item | Detailed status |\n|---|---|\n| Chat layout | Clean and responsive |", created_at: "2026-08-09T11:59:00Z" },
  ],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function fixtures(page: Page) {
  await page.addInitScript(() => localStorage.setItem("auto-ai-access-token", "chat-test-token"));
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path.endsWith("/auth/me") || path.endsWith("/users/me")) return json(route, user);
    if (path.endsWith("/chat/sessions") && method === "GET") return json(route, chats);
    if (path.endsWith("/chat/sessions") && method === "POST") return json(route, { ...populated, id: "chat-new", title: "New chat", messages: [] });
    if (path.endsWith("/chat/sessions/chat-today") && method === "GET") return json(route, populated);
    if (path.endsWith("/chat/sessions/chat-week") && method === "GET") return json(route, { ...populated, ...chats[1] });
    if (path.endsWith("/chat/sessions/chat-today") && method === "PATCH") return json(route, populated);
    if (path.endsWith("/documents")) return json(route, []);
    if (path.endsWith("/ai/chat/generations/active")) return json(route, []);
    if (path.endsWith("/ai/research-models")) return json(route, { providers: {}, defaults: { max_models: 6, timeout_seconds: 45, final_judge_model: null } });
    if (path.endsWith("/ai/intelligence/config")) return json(route, { modes: { instant: { available: true }, medium: { available: true }, high: { available: true }, deep_research: { available: true }, coding: { available: true } }, models: [], refreshed: true });
    if (path.endsWith("/form-services/interpret")) return json(route, { handled: false, confidence: 0, reason: "Not a service request" });
    if (path.endsWith("/intent-engine/interpret")) return json(route, { event_id: "intent-1", intent: {}, decision: { outcome: "TEXT_RESPONSE", user_message: "" } });
    if (path.endsWith("/chat/sessions/chat-today/messages") && method === "POST") {
      const payload = route.request().postDataJSON();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return json(route, { id: "generation-1", chat_id: "chat-today", status: "running", assistant_message_id: "assistant-new", user_message: { id: "user-new", role: "user", content: payload.message, created_at: now }, assistant_message: { id: "assistant-new", role: "assistant", content: "", created_at: now }, activity: [] });
    }
    if (path.endsWith("/content/public/announcements")) return json(route, []);
    if (path.endsWith("/calls/config")) return json(route, { enabled: false });
    return json(route, {});
  });
}

async function noHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(result.scrollWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.clientWidth + 1);
}

test("empty AI Chat is conversation-first without promotional cards", async ({ page }) => {
  await fixtures(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "आज मैं आपकी कैसे मदद करूँ?" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Message AutoAI")).toBeVisible();
  await expect(page.getByText("Document-aware")).toHaveCount(0);
  await expect(page.getByText("Emotion-aware")).toHaveCount(0);
  await expect(page.getByText("Action-ready")).toHaveCount(0);
  await expect(page.getByText("Ultra human mode")).toHaveCount(0);
});

test("history search opens the correct chat and new chat remains functional", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await fixtures(page);
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Search conversations" }).fill("prior research");
  await page.getByRole("button", { name: /A very long prior research/ }).click();
  await expect(page).toHaveURL(/\/chat\/chat-week$/);
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("heading", { name: "आज मैं आपकी कैसे मदद करूँ?" })).toBeVisible();
});

test("first user message appears optimistically while generation starts", async ({ page }) => {
  await fixtures(page);
  await page.goto("/chat/chat-today");
  const composer = page.getByLabel("Message AutoAI");
  await composer.fill("यह पहला optimistic message तुरंत दिखना चाहिए");
  await composer.press("Enter");
  await expect(page.getByText("यह पहला optimistic message तुरंत दिखना चाहिए")).toBeVisible({ timeout: 800 });
});

test("failed chat deletion remains visible with truthful recovery", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await fixtures(page);
  await page.route("**/api/v1/chat/sessions/chat-today", (route) => route.request().method() === "DELETE" ? json(route, { detail: "failure" }, 500) : route.fallback());
  await page.goto("/chat/chat-today");
  await page.getByLabel("Actions for Mixed Hindi and English conversation").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete chat" }).click();
  await expect(page.getByRole("alert")).toHaveText("Chat was not deleted. Please try again.");
  await expect(page.getByRole("button", { name: /Mixed Hindi and English conversation/ })).toBeVisible();
});

const viewports = [
  [320,568], [360,800], [375,812], [390,844], [412,915], [480,800], [768,1024],
  [1024,768], [1280,720], [1366,768], [1440,900], [800,360]
] as const;

for (const [width, height] of viewports) {
  test(`populated AI Chat has no overflow at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixtures(page);
    await page.goto("/chat/chat-today");
    await expect(page.locator(".message-card-ai").filter({ hasText: "readable mixed-language response" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Message AutoAI")).toBeVisible();
    await noHorizontalOverflow(page);
    if ((width === 390 && height === 844) || (width === 1366 && height === 768) || height === 360) {
      await page.screenshot({ path: `../output/playwright/chat-simple-${width}x${height}.png`, fullPage: true });
    }
  });
}

test("mobile history drawer closes with Escape and restores the conversation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page);
  await page.goto("/chat/chat-today");
  await page.getByRole("button", { name: "Open conversation menu" }).click();
  await expect(page.getByRole("navigation", { name: "Chat history" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-sidebar")).toHaveAttribute("data-open", "false");
  await expect(page.getByLabel("Message AutoAI")).toBeVisible();
});

for (const scale of [1.25, 1.5, 2]) {
  test(`AI Chat remains usable at ${Math.round(scale * 100)}% font scaling`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixtures(page);
    await page.goto("/chat/chat-today");
    await page.locator("html").evaluate((element, value) => { element.style.fontSize = `${16 * Number(value)}px`; }, scale);
    await expect(page.getByLabel("Message AutoAI")).toBeVisible();
    await noHorizontalOverflow(page);
  });
}
