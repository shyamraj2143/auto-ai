export type User = {
  id: string;
  email: string;
  mobile?: string | null;
  name: string;
  is_admin: boolean;
  role: UserRole;
  created_at: string;
};

export type UserRole = "user" | "admin" | "super_admin";

export type SearchMode = "off" | "auto" | "web" | "news" | "research" | "deep";
export type ChatMode = "normal" | "deep_research" | "multi_model";
export type ResearchProvider = "groq" | "bedrock";

export type ResearchProviderModels = {
  enabled: boolean;
  models: string[];
};

export type ResearchModelOptions = {
  providers: Record<ResearchProvider, ResearchProviderModels>;
  defaults: {
    max_models: number;
    timeout_seconds: number;
    final_judge_model?: string | null;
  };
};

export type SearchSource = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  provider: string;
  published_at?: string | null;
  credibility_score: number;
  credibility_label: string;
};

export type SearchResultBundle = {
  run_id?: string | null;
  query: string;
  mode: SearchMode;
  provider: string;
  status: string;
  cache_hit: boolean;
  searched: boolean;
  reason: string;
  confidence_score: number;
  summary: string;
  sources: SearchSource[];
  created_at?: string | null;
};

export type SearchHistoryItem = {
  id: string;
  query: string;
  mode: SearchMode;
  provider: string;
  status: string;
  cache_hit: boolean;
  confidence_score: number;
  summary: string;
  results: SearchResultBundle;
  created_at: string;
};

export type Message = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
  message_metadata?: {
    search?: SearchResultBundle;
    model?: ResponseModelInfo;
    [key: string]: unknown;
  };
  created_at: string;
};

export type ResponseModelInfo = {
  provider: string;
  provider_label?: string;
  model: string;
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
  mode?: ChatMode;
  providers?: ResearchProvider[];
  max_models?: number;
  all_models?: boolean;
  timeout_seconds?: number;
  groq_models?: string[];
  bedrock_models?: string[];
  final_judge_model?: string | null;
  provider?: "openai" | "groq" | "bedrock";
  model?: string | null;
  web_search?: boolean;
  search_mode?: SearchMode;
  reasoning?: boolean;
  document_ids?: string[];
};

export type StreamEvent =
  | { type: "meta"; chat_id: string; model?: ResponseModelInfo }
  | { type: "searching"; mode: SearchMode; message: string }
  | { type: "sources"; search: SearchResultBundle }
  | { type: "delta"; delta: string }
  | { type: "done"; message_id: string }
  | { type: "error"; detail: string };

export type ChatGeneration = {
  id: string;
  chat_id: string;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  status: "pending" | "running" | "cancel_requested" | "completed" | "failed" | "cancelled" | string;
  error?: string | null;
  user_message?: Message | null;
  assistant_message?: Message | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

export type ApkRelease = {
  id: string;
  version_name: string;
  apk_url: string;
  release_date: string;
  force_update: boolean;
  download_count: number;
  version: string;
  version_code: number;
  filename: string;
  file_size: number;
  sha256: string;
  min_android_version: string;
  release_notes: string[];
  changelog: string;
  is_active: boolean;
  created_at: string;
  download_url: string;
};

export type ApkStats = {
  latest: ApkRelease | null;
  total_downloads: number;
  downloads_by_version: Record<string, number>;
};

export type AdminStats = {
  total_users: number;
  active_users: number;
  blocked_users: number;
  total_chats: number;
  total_api_usage: number;
  active_subscriptions: number;
  paid_subscriptions: number;
  total_revenue_cents: number;
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

export type AdminUser = {
  id: string;
  email: string;
  mobile?: string | null;
  name: string;
  role: UserRole;
  status: "active" | "blocked";
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
  subscription?: {
    plan: AdminPlanName;
    is_active: boolean;
    expires_at?: string | null;
    payment_status: string;
    expiry_status: string;
  } | null;
  quota?: AdminQuota | null;
  usage?: {
    total_prompts: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_chats: number;
  } | null;
};

export type AdminPlanName = "free" | "pro" | "pro-plus" | "admin";

export type AdminQuota = {
  user_id: string;
  user_name: string;
  user_email: string;
  status: "active" | "blocked";
  plan_name: string;
  token_limit_monthly: number;
  tokens_used_monthly: number;
  token_balance: number;
  bonus_tokens: number;
  daily_message_limit: number;
  messages_used_today: number;
  quota_updated_by?: string | null;
  quota_updated_at?: string | null;
};

export type AdminSubscription = {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  plan: AdminPlanName;
  is_active: boolean;
  expires_at?: string | null;
  payment_status: string;
  razorpay_customer_id?: string | null;
  razorpay_payment_id?: string | null;
  stripe_customer_id?: string | null;
  stripe_payment_id?: string | null;
  expiry_status: string;
  created_at: string;
  updated_at: string;
};

export type AdminUsageProviderSummary = {
  provider: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type AdminUsageUserSummary = {
  user_id: string;
  user_name: string;
  user_email: string;
  plan: AdminPlanName;
  total_prompts: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  providers: AdminUsageProviderSummary[];
};

export type AdminUsageTimeBucket = {
  period: string;
  requests: number;
  total_tokens: number;
};

export type AdminUsageResponse = {
  users: AdminUsageUserSummary[];
  providers: AdminUsageProviderSummary[];
  daily: AdminUsageTimeBucket[];
  monthly: AdminUsageTimeBucket[];
};

export type AdminFeatureFlag = {
  id: string;
  key: string;
  scope: "global" | "user";
  user_id?: string | null;
  user_email?: string | null;
  enabled: boolean;
  description: string;
  created_at: string;
  updated_at: string;
};

export type AdminPlanLimit = {
  id: string;
  plan: AdminPlanName;
  daily_prompt_limit: number;
  monthly_prompt_limit: number;
  daily_token_limit: number;
  monthly_token_limit: number;
  max_models: number;
  allow_deep_research: boolean;
  allow_multi_model: boolean;
  allow_web_search: boolean;
  created_at: string;
  updated_at: string;
};

export type AdminFeaturesResponse = {
  flags: AdminFeatureFlag[];
  plan_limits: AdminPlanLimit[];
};

export type AdminPaymentRecord = {
  id: string;
  user_id?: string | null;
  user_name?: string | null;
  user_email?: string | null;
  provider: string;
  customer_id?: string | null;
  payment_id?: string | null;
  subscription_id?: string | null;
  plan: AdminPlanName;
  amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
};

export type AdminAnalytics = {
  stats: AdminStats;
  subscriptions_by_plan: Record<string, number>;
  users_by_status: Record<string, number>;
  usage_by_provider: AdminUsageProviderSummary[];
  payments_by_status: Record<string, number>;
  daily_usage: AdminUsageTimeBucket[];
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
