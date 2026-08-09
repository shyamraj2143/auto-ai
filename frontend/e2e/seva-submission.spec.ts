import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-08-09T10:02:00Z";
const user = { id: "user-seva", email: "seva@autoai.test", name: "Asha Kumari", username: "asha", provider: "email", is_admin: false, role: "user", subscription_status: "free", created_at: now, updated_at: now };
const task = {
  id: "task-verified", chat_id: null, service_id: "autoai.demo-bihar-income-certificate", service_name: "Bihar Income Certificate", provider: "AutoAI Verified Demo", state: "COMPLETED_VERIFIED", execution_mode: "EXECUTE_WITH_CONFIRMATION", progress_percent: 100, version: 18, created_at: "2026-08-09T09:45:00Z", updated_at: now,
  active_card: {
    type: "action_receipt", title: "Action receipt", description: "Submission is verified.", state: "COMPLETED_VERIFIED", status: "active", task_id: "task-verified", task_version: 18, progress_percent: 100, execution_mode: "EXECUTE_WITH_CONFIRMATION", actions: ["track", "view_receipt"], updated_at: now,
    data: {
      service_name: "Bihar Income Certificate", status: "verified", application_id: "AUTOAI-TEST-240809", reference_number: "AUTOAI-TEST-240809", transaction_id: "TXN-240809", submission_timestamp: "2026-08-09T10:00:00Z", last_updated: now, expected_timeline: "7 working days", evidence: [{ type: "portal_receipt", verified: true, reference: "receipt-1" }],
      status_timeline: [
        { key: "application_started", label: "Application started / आवेदन शुरू", status: "completed", timestamp: "2026-08-09T09:45:00Z" },
        { key: "information_ready", label: "Information completed / जानकारी पूर्ण", status: "completed", timestamp: "2026-08-09T09:52:00Z" },
        { key: "submitted", label: "Sent to department / विभाग को भेजा गया", status: "completed", timestamp: "2026-08-09T10:00:00Z" },
        { key: "verification", label: "Under verification / सत्यापन जारी", status: "completed", timestamp: "2026-08-09T10:01:00Z" },
        { key: "completed", label: "Completed / पूर्ण", status: "completed", timestamp: now },
      ],
      application_preview: { portal_name: "AutoAI verified local adapter", current_stage: "Completed Verified", completed_fields: 7, total_fields: 7, currently_filling: "Ready", fields: [], documents: [] },
    },
  },
};

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installFixtures(page: Page) {
  await page.addInitScript(() => localStorage.setItem("auto-ai-access-token", "seva-test-token"));
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me") || path.endsWith("/users/me")) return json(route, user);
    if (path.endsWith("/form-services/tasks/task-verified")) return json(route, task);
    if (path.includes("/content/public/announcements")) return json(route, []);
    return json(route, {});
  });
}

for (const viewport of [{ name: "mobile", width: 360, height: 780 }, { name: "desktop", width: 1366, height: 768 }]) {
  test(`verified Seva success and tracker are responsive on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installFixtures(page);
    await page.goto("/seva/applications/task-verified", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Application submitted successfully")).toBeVisible();
    await expect(page.getByRole("button", { name: "OK, Done" })).toBeVisible();
    await page.getByRole("button", { name: "Track Status" }).click();
    await expect(page.getByRole("region", { name: "Application status tracker" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../output/playwright/seva-submission-${viewport.name}.png`, fullPage: true });
  });
}
