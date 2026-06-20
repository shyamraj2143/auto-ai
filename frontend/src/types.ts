export type User = {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  created_at: string;
};

export type Message = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  created_at: string;
};

export type ChatListItem = {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
};

export type Chat = ChatListItem & {
  system_prompt?: string | null;
  messages: Message[];
};

export type DocumentItem = {
  id: string;
  chat_id?: string | null;
  filename: string;
  content_type: string;
  file_size: number;
  summary?: string | null;
  document_metadata: Record<string, unknown>;
  created_at: string;
};

export type ChatRequest = {
  message: string;
  chat_id?: string | null;
  title?: string | null;
  system_prompt?: string | null;
  provider?: "openai" | "groq" | "bedrock";
  model?: string | null;
  web_search?: boolean;
  reasoning?: boolean;
  document_ids?: string[];
};

export type StreamEvent =
  | { type: "meta"; chat_id: string }
  | { type: "delta"; delta: string }
  | { type: "done"; message_id: string }
  | { type: "error"; detail: string };

export type AdminStats = {
  user_count: number;
  chat_count: number;
  message_count: number;
  document_count: number;
  api_calls: number;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  system: {
    environment: string;
    database_backend: string;
    python_version: string;
    storage_total_gb: number;
    storage_free_gb: number;
  };
};

export type InteractionProfile = {
  id: string;
  user_id: string;
  trust_score: number;
  rapport_score: number;
  respect_score: number;
  curiosity_score: number;
  confidence_score: number;
  frustration_score: number;
  humor_score: number;
  communication_style: Record<string, unknown>;
  personality_blend: Record<string, unknown>;
  favorite_topics: string[];
  current_projects: string[];
  long_term_objectives: string[];
  learning_style?: string | null;
  first_interaction_at: string;
  last_interaction_at: string;
  created_at: string;
  updated_at: string;
};

export type UserMemory = {
  id: string;
  user_id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  confidence: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type TurnAnalysis = {
  id: string;
  user_id: string;
  chat_id: string;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  emotion: Record<string, unknown>;
  tone: Record<string, unknown>;
  intent: string;
  language: string;
  personality_mode: Record<string, unknown>;
  state_delta: Record<string, unknown>;
  flags: Record<string, unknown>;
  created_at: string;
};

export type HumanState = {
  profile: InteractionProfile;
  memories: UserMemory[];
  recent_turns: TurnAnalysis[];
};
