export const NOTIFICATION_DESTINATIONS = [
  "MESSAGE_THREAD",
  "AI_CONVERSATION",
  "INCOMING_CALL",
  "MISSED_CALL",
  "CALL_HISTORY",
  "FOLLOW_REQUEST",
  "FOLLOW_ACCEPTED",
  "SOCIAL_ALERT",
  "SCREEN_SHARE_SESSION",
  "APP_UPDATE",
  "SETTINGS_SECTION",
  "PAYMENT_RESULT",
] as const;

export type NotificationDestination = (typeof NOTIFICATION_DESTINATIONS)[number];

export type NotificationDestinationEvent = {
  eventId: string;
  destination: NotificationDestination;
  entityId?: string | null;
  secondaryId?: string | null;
  createdAt?: string | null;
};

const destinationSet = new Set<string>(NOTIFICATION_DESTINATIONS);

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= 256 ? clean : null;
}

export function parseNotificationDestination(raw: unknown): NotificationDestinationEvent | null {
  let detail = raw;
  if (typeof detail === "string") {
    try { detail = JSON.parse(detail); } catch { return null; }
  }
  if (!detail || typeof detail !== "object") return null;
  const value = detail as Record<string, unknown>;
  const destination = cleanId(value.destination);
  const eventId = cleanId(value.eventId ?? value.event_id);
  if (!destination || !destinationSet.has(destination) || !eventId) return null;
  return {
    eventId,
    destination: destination as NotificationDestination,
    entityId: cleanId(value.entityId ?? value.entity_id),
    secondaryId: cleanId(value.secondaryId ?? value.secondary_id),
    createdAt: cleanId(value.createdAt ?? value.created_at),
  };
}

export function routeForNotificationDestination(event: NotificationDestinationEvent): string | null {
  const id = event.entityId ? encodeURIComponent(event.entityId) : "";
  const secondaryId = event.secondaryId ? encodeURIComponent(event.secondaryId) : "";
  switch (event.destination) {
    case "MESSAGE_THREAD": return id ? `/messages/${id}` : null;
    case "AI_CONVERSATION": return id ? `/chat/${id}` : null;
    case "MISSED_CALL": return id ? `/call-hub/calls?callId=${id}&filter=missed` : null;
    case "CALL_HISTORY": return id ? `/call-hub/calls?callId=${id}` : "/call-hub/calls";
    case "FOLLOW_REQUEST": return id ? `/call-hub/requests?requestId=${id}&tab=incoming` : null;
    case "FOLLOW_ACCEPTED": return secondaryId ? `/messages/${secondaryId}` : id ? `/call-hub/chats?userId=${id}` : null;
    case "SOCIAL_ALERT": return id ? `/call-hub/alerts?notificationId=${id}` : null;
    case "SCREEN_SHARE_SESSION": return id ? `/screen-share/${id}` : null;
    case "SETTINGS_SECTION": return id ? `/settings?section=${id}` : "/settings";
    case "PAYMENT_RESULT": return event.secondaryId === "failed" ? "/payment/failed" : event.secondaryId === "success" ? "/payment/success" : null;
    case "INCOMING_CALL":
    case "APP_UPDATE":
      return null;
  }
}

export function destinationFromSocialNotification(item: {
  id: string;
  notification_type: string;
  target_type: string;
  target_id?: string | null;
  actor?: { id: string } | null;
}): NotificationDestinationEvent | null {
  const eventId = `in-app:${item.id}`;
  if (item.notification_type === "message" && item.target_id) return { eventId, destination: "MESSAGE_THREAD", entityId: item.target_id };
  if (item.notification_type === "follow_request" && item.target_id) return { eventId, destination: "FOLLOW_REQUEST", entityId: item.target_id };
  if (item.notification_type === "follow_accept") return { eventId, destination: "FOLLOW_ACCEPTED", entityId: item.actor?.id ?? item.target_id };
  if (item.notification_type === "missed_call" && item.target_id) return { eventId, destination: "MISSED_CALL", entityId: item.target_id };
  if (item.target_type === "call" && item.target_id) return { eventId, destination: "CALL_HISTORY", entityId: item.target_id };
  return { eventId, destination: "SOCIAL_ALERT", entityId: item.id };
}
