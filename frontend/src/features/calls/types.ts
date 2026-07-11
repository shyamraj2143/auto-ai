export type PresenceState = "online" | "away" | "background" | "busy" | "offline" | "hidden";
export type CallType = "audio" | "video";
export type CallPermission = "everyone" | "followers" | "mutual_followers" | "approved_contacts" | "previous_contacts" | "nobody";
export type CallSessionState =
  | "idle"
  | "preparing"
  | "dialing"
  | "notifying"
  | "ringing"
  | "incoming"
  | "accepting"
  | "connecting"
  | "active"
  | "reconnecting"
  | "ending"
  | "ended"
  | "rejected"
  | "cancelled"
  | "missed"
  | "busy"
  | "failed";

export type PublicCallUser = {
  id: string;
  display_name: string;
  username: string;
  avatar_url?: string | null;
  presence: PresenceState;
  availability: string;
  can_audio_call: boolean;
  can_video_call: boolean;
  last_seen_at?: string | null;
};

export type CallSettings = {
  is_discoverable: boolean;
  show_online_status: boolean;
  show_last_seen: boolean;
  allow_audio_calls: boolean;
  allow_video_calls: boolean;
  call_permission: CallPermission;
  silence_unknown_callers: boolean;
  call_notification_sound: boolean;
  vibration: boolean;
  data_saving_mode: boolean;
};

export type CallRecord = {
  id: string;
  caller_id: string;
  callee_id: string;
  call_type: CallType;
  status: string;
  created_at: string;
  ringing_at?: string | null;
  accepted_at?: string | null;
  connected_at?: string | null;
  ended_at?: string | null;
  duration_seconds: number;
  ended_by?: string | null;
  end_reason?: string | null;
  direction: "incoming" | "outgoing";
  peer: PublicCallUser;
  delivery?: string | null;
  silent?: boolean;
};

export type CallUserPage = { items: PublicCallUser[]; page: number; limit: number; has_more: boolean };
export type CallHistoryPage = { items: CallRecord[]; page: number; limit: number; has_more: boolean };
export type CallFeatureConfig = {
  enabled: boolean;
  realtime_configured: boolean;
  turn_configured: boolean;
  firebase_configured: boolean;
  ring_timeout_seconds: number;
  reconnect_grace_seconds: number;
  diagnostic?: string | null;
};
export type TurnCredentials = {
  configured?: boolean;
  provider?: string;
  ice_servers?: RTCIceServer[];
  iceServers?: RTCIceServer[];
  expires_at?: string | null;
  expiresAt?: string | null;
  relay_configured?: boolean;
  relayConfigured?: boolean;
  warning?: string | null;
};
export type BlockedCallUser = {
  id: string;
  display_name: string;
  username: string;
  avatar_url?: string | null;
  blocked_at: string;
};

export type FollowStatus = "self" | "none" | "pending" | "following" | "blocked";
export type SocialProfile = {
  id: string;
  display_name: string;
  username: string;
  avatar_url?: string | null;
  bio?: string | null;
  is_private: boolean;
  follow_status: FollowStatus;
  can_message: boolean;
  can_audio_call: boolean;
  can_video_call: boolean;
  profile_restricted: boolean;
};
export type SocialUserPage = { items: SocialProfile[]; page: number; limit: number; has_more: boolean; unread_notifications: number };
export type SocialRequest = { id: string; requested_at: string; user: SocialProfile };
export type SocialRequestPage = { items: SocialRequest[]; page: number; limit: number; has_more: boolean };
export type SocialNotification = {
  id: string;
  notification_type: string;
  target_type: string;
  target_id?: string | null;
  title: string;
  body?: string | null;
  read_at?: string | null;
  created_at: string;
  actor?: SocialProfile | null;
};
export type SocialNotificationPage = { items: SocialNotification[]; page: number; limit: number; has_more: boolean; unread_count: number };

export type SignalEventType =
  | "presence.snapshot"
  | "presence.user_updated"
  | "call.incoming"
  | "call.ringing"
  | "call.accepted"
  | "call.rejected"
  | "call.cancelled"
  | "call.busy"
  | "call.missed"
  | "call.active"
  | "call.ended"
  | "call.error"
  | "webrtc.offer"
  | "webrtc.answer"
  | "webrtc.ice_candidate"
  | "webrtc.restart_required"
  | "pong";

export type SignalEnvelope = {
  schema_version: 1;
  event_id: string;
  type: SignalEventType | string;
  call_id?: string | null;
  sender_user_id?: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
};

export type IncomingCallPayload = {
  call_type: CallType;
  caller: Pick<PublicCallUser, "id" | "display_name" | "username" | "avatar_url">;
  expires_at: string;
  silent?: boolean;
};
