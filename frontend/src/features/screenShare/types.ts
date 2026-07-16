import type { PublicCallUser } from "../calls/types";

export type ScreenShareStatus = "waiting" | "active" | "ended" | "failed";
export type ScreenShareRole = "sharer" | "viewer";
export type ScreenShareUiState = "idle" | "preparing" | "waiting" | "connecting" | "active" | "reconnecting" | "ended" | "failed";
export type ScreenShareSource = "screen" | "window" | "browser";
export type ScreenShareQualityMode = "auto" | "data-saver" | "sharp-text" | "smooth-motion" | "hd";

export type ScreenShareSession = {
  sessionId?: string;
  session_id?: string;
  sharerUserId?: string;
  sharer_user_id?: string;
  viewerUserId?: string | null;
  viewer_user_id?: string | null;
  status: ScreenShareStatus;
  createdAt?: string;
  created_at?: string;
  startedAt?: string | null;
  started_at?: string | null;
  endedAt?: string | null;
  ended_at?: string | null;
  expiresAt?: string | null;
  expires_at?: string | null;
  inviteLink?: string | null;
  invite_link?: string | null;
  shareCode?: string | null;
  share_code?: string | null;
};

export type ScreenShareInvite = {
  sessionId: string;
  sharer: Pick<PublicCallUser, "id" | "display_name" | "username" | "avatar_url">;
  inviteLink?: string | null;
  expiresAt?: string | null;
  message?: string;
};

export type ScreenShareSignal = {
  schema_version?: 1;
  event_id: string;
  type: string;
  session_id?: string | null;
  sessionId?: string | null;
  sender_user_id?: string | null;
  timestamp?: string;
  payload: Record<string, unknown>;
};
