export type RelationshipType = "family" | "friend" | "relative" | "mentor" | "colleague" | "professional" | "other";
export type ContactChannel = "phone" | "email" | "whatsapp" | "other";
export type FollowupCadence = "weekly" | "fortnightly" | "monthly" | "quarterly" | "custom";
export type FollowupPriority = "normal" | "important" | "high";
export type FollowupStatus = "active" | "paused" | "archived";

export type RelationshipContact = {
  id: string;
  display_name: string;
  relationship_type: RelationshipType;
  preferred_channel: ContactChannel | null;
  contact_value: string;
  last_contacted_at: string | null;
  cadence: FollowupCadence;
  followup_interval_days: number;
  next_followup_at: string;
  preferred_reminder_time: string;
  timezone: string;
  priority: FollowupPriority;
  notes: string;
  preferred_language: "hi" | "en";
  status: FollowupStatus;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type RelationshipInteraction = {
  id: string;
  contacted_at: string;
  channel: string | null;
  note: string;
  created_at: string;
};

export type FollowupEvent = {
  id: string;
  scheduled_at: string;
  status: string;
  completed_at: string | null;
  snoozed_until: string | null;
  sent_at: string | null;
  attempt_count: number;
  failure_code: string | null;
};

export type RelationshipContactDetail = RelationshipContact & {
  interactions: RelationshipInteraction[];
  events: FollowupEvent[];
};

export type RelationshipContactPage = {
  items: RelationshipContact[];
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
};

export type FollowupSummary = {
  overdue: number;
  today: number;
  upcoming: number;
  recently_contacted: number;
  paused: number;
  archived: number;
  unread_due: number;
  next_due_at: string | null;
};

export type FollowupPreferences = {
  enabled: boolean;
  detailed_preview: boolean;
  permission_state: string;
  updated_at: string;
};

export type ContactFormPayload = {
  display_name: string;
  relationship_type: RelationshipType;
  preferred_channel: ContactChannel | null;
  contact_value: string;
  last_contacted_at: string | null;
  cadence: FollowupCadence;
  followup_interval_days: number | null;
  next_followup_at: string;
  preferred_reminder_time: string;
  timezone: string;
  priority: FollowupPriority;
  notes: string;
  preferred_language: "hi" | "en";
};
