import { describe, expect, it } from "vitest";
import { destinationFromSocialNotification, parseNotificationDestination, routeForNotificationDestination } from "./notificationDestination";

describe("notification destination contract", () => {
  it.each([
    ["MESSAGE_THREAD", "thread/a", null, "/messages/thread%2Fa"],
    ["AI_CONVERSATION", "chat a", null, "/chat/chat%20a"],
    ["MISSED_CALL", "call/1", null, "/call-hub/calls?callId=call%2F1&filter=missed"],
    ["CALL_HISTORY", "call/1", null, "/call-hub/calls?callId=call%2F1"],
    ["FOLLOW_REQUEST", "request/1", null, "/call-hub/requests?requestId=request%2F1&tab=incoming"],
    ["RELATIONSHIP_FOLLOWUP", "contact/1", null, "/relationships?contact=contact%2F1"],
    ["FOLLOW_ACCEPTED", "user/1", "thread/1", "/messages/thread%2F1"],
    ["SOCIAL_ALERT", "alert/1", null, "/call-hub/alerts?notificationId=alert%2F1"],
    ["SCREEN_SHARE_SESSION", "session/1", null, "/screen-share/session%2F1"],
    ["SETTINGS_SECTION", "privacy", null, "/settings?section=privacy"],
    ["PAYMENT_RESULT", "payment/1", "success", "/payment/success"],
  ])("maps %s without accepting an arbitrary route", (destination, entityId, secondaryId, expected) => {
    expect(routeForNotificationDestination({ eventId: "event-1", destination: destination as never, entityId, secondaryId })).toBe(expected);
  });

  it("rejects unknown destinations and missing event ids", () => {
    expect(parseNotificationDestination({ eventId: "1", destination: "EVIL", route: "https://example.com" })).toBeNull();
    expect(parseNotificationDestination({ destination: "MESSAGE_THREAD", entityId: "thread" })).toBeNull();
  });

  it("uses the same resolver for in-app alerts", () => {
    expect(destinationFromSocialNotification({ id: "n1", notification_type: "follow_request", target_type: "follow_requests", target_id: "r1" }))
      .toEqual({ eventId: "in-app:n1", destination: "FOLLOW_REQUEST", entityId: "r1" });
  });
});
