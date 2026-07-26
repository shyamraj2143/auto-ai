import type { PublicCallUser } from "../calls/types";

export type UserMessage = {
  id: string;
  thread_id: string;
  sender_id: string;
  client_message_id?: string | null;
  message_type: "text" | "image" | "file" | "audio" | "system" | string;
  text_content?: string | null;
  attachment_url?: string | null;
  attachment_name?: string | null;
  attachment_size?: number | null;
  mime_type?: string | null;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
  reply_to_message_id?: string | null;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
};

export type ChatPublicUser = PublicCallUser;

export type UserThread = {
  id: string;
  is_group: boolean;
  created_at: string;
  updated_at: string;
  peer: ChatPublicUser;
  last_message?: UserMessage | null;
  unread_count: number;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  restricted_reason?: string | null;
};

export type ThreadPage = { items: UserThread[]; page: number; limit: number; has_more: boolean };
export type ChatUserPage = { items: ChatPublicUser[]; page: number; limit: number; has_more: boolean };
export type MessagePage = { items: UserMessage[]; has_more: boolean };

export type ChatSettings = {
  read_receipts_enabled: boolean;
  last_seen_enabled: boolean;
  typing_indicator_enabled: boolean;
  allow_messages_from: "everyone" | "known_users" | "nobody";
};

export type ChatRealtimeEvent = {
  schema_version?: 1;
  event_id: string;
  type: string;
  thread_id?: string | null;
  sender_user_id?: string | null;
  timestamp?: string;
  payload: Record<string, unknown>;
};
