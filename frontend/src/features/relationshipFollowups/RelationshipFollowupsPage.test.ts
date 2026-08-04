import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./RelationshipFollowupsPage.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("./relationshipFollowupsApi.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./relationshipFollowups.css", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../../components/settings/SettingsPage.tsx", import.meta.url), "utf8");

describe("Relationship Follow-up production contract", () => {
  it("connects the dedicated route and Action Hub entry to authenticated APIs", () => {
    expect(routes).toContain('path="/relationships"');
    expect(api).toContain('apiFetch<RelationshipContactPage>(`/relationship-followups?${params}`');
    expect(api).toContain('method: "POST", token, operation: "relationships.create"');
    expect(api).toContain('method: "PATCH", token, operation: "relationships.update"');
    expect(api).toContain("crypto.randomUUID()");
  });

  it("provides loading, empty, offline, error, success, retry and expired-session-capable states", () => {
    expect(page).toContain("Loading follow-ups");
    expect(page).toContain("Add someone important");
    expect(page).toContain("You are offline");
    expect(page).toContain('className="rf-alert" role="alert"');
    expect(page).toContain('className="rf-notice" role="status"');
    expect(page).toContain("refreshAfterAction");
    expect(page).toContain("Retry delivery");
    expect(api).toContain("operation: \"relationships.list\"");
  });

  it("supports complete add, edit, search, filtering and reminder actions", () => {
    for (const required of [
      "validateForm(form)",
      "All relationships",
      "All priorities",
      "Due first",
      "Mark contacted",
      "Snooze 1 day",
      "Reschedule",
      "Pause",
      "Archive",
      "Restore",
    ]) expect(page).toContain(required);
    expect(api).toContain("/contacted");
    expect(api).toContain("/snooze");
    expect(api).toContain("/reschedule");
  });

  it("keeps protected-contact access permission-free and asks notification permission only after explanation", () => {
    expect(page).toContain("No contacts permission required");
    expect(page).not.toContain("Contacts.requestPermissions");
    expect(page).not.toContain("READ_CONTACTS");
    expect(page).toContain("Enable relationship reminders");
    expect(page).toContain(": setPermissionExplainer(true)");
    expect(page).toContain("onClick={() => void enablePush()}");
    expect(page).toContain("permission.permanentlyDenied");
    expect(page).toContain("callNative.openAppNotificationSettings()");
    expect(page).toContain("In-app reminders always work");
    expect(settings).toContain("Relationship reminders");
  });

  it("keeps AI suggestions editable and user-controlled", () => {
    expect(page).toContain('aria-label="Editable AI suggestion"');
    expect(page).toContain("setAiSuggestion(e.target.value)");
    expect(page).toContain("navigator.share");
    expect(page).toContain("AutoAI never sends automatically");
    expect(api).toContain("/ai-suggestion");
  });

  it("is keyboard accessible and responsive down to 320px with visible native options", () => {
    expect(page).toContain('role="dialog" aria-modal="true"');
    expect(page).toContain('event.key === "Escape"');
    expect(page).toContain('event.key !== "Tab"');
    expect(page).toContain("createPortal(");
    expect(styles).toContain("z-index: 5000");
    expect(styles).toContain("min-height: 48px");
    expect(styles).toContain(".rf-page option { background: #fff; color: #09142a; }");
    expect(styles).toContain("@media (max-width: 380px)");
    expect(styles).toContain("100dvh");
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("prefers-reduced-motion");
    expect(styles).toContain("overflow-x: hidden");
  });
});
