export type User = {
  id: string;
  email: string;
  mobile?: string | null;
  name: string;
  username?: string | null;
  phone_number?: string | null;
  phone_country_code?: string | null;
  phone_verified?: boolean;
  phone_verified_at?: string | null;
  picture?: string | null;
  avatar?: string | null;
  provider: string;
  google_id?: string | null;
  is_admin: boolean;
  role: UserRole;
  subscription_status: string;
  created_at: string;
  updated_at: string;
  profile_updated_at?: string | null;
};

export type UsernameAvailability = {
  username: string;
  available: boolean;
  valid: boolean;
  message: string;
};

export type UserRole = "user" | "admin" | "super_admin" | "content_admin" | "content_editor" | "content_viewer";

export type SearchMode = "off" | "auto" | "web" | "news" | "research" | "deep";
export type ChatMode = "normal" | "deep_research" | "multi_model";
export type AiProvider = "openai" | "groq" | "bedrock" | "gemini";
export type ResearchProvider = "groq" | "bedrock" | "openai" | "gemini";

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
  user_id?: string | null;
  role: "system" | "user" | "assistant";
  content: string;
  model?: string | null;
  token_count?: number;
  message_metadata?: {
    search?: SearchResultBundle;
    model?: ResponseModelInfo;
    attachments?: ChatAttachment[];
    client_message_id?: string;
    internal_context?: MessageInternalContext;
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
  mode: string;
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

export type ChatAttachment = {
  id: string;
  type: "image" | "file";
  url?: string | null;
  preview_url?: string | null;
  filename: string;
  mime_type?: string | null;
  file_size?: number | null;
  status?: "queued" | "uploading" | "uploaded" | "failed" | "analyzed" | string;
};

export type MessageInternalContext = {
  image_summary?: string | null;
  ocr_text?: string | null;
  parsed_file_text?: string | null;
};

export type ChatRequest = {
  message: string;
  client_message_id?: string;
  attachments?: ChatAttachment[];
  internal_context?: MessageInternalContext | null;
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
  openai_models?: string[];
  gemini_models?: string[];
  provider?: AiProvider;
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
  version_code: number;
  version_name: string;
  apk_url: string;
  file_name: string;
  file_size: number;
  changelog: string;
  force_update: boolean;
  is_active: boolean;
  download_count: number;
  created_at: string;
  updated_at: string;
  released_at: string;
  release_date: string;
  version: string;
  filename: string;
  sha256: string;
  min_android_version: string;
  release_notes: string[];
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
  picture?: string | null;
  avatar?: string | null;
  provider: string;
  google_id?: string | null;
  role: UserRole;
  subscription_status: string;
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

export type AdminPlanName = "free" | "pro" | "premium" | "ultra" | "pro-plus" | "admin";
export type PricingPlanName = "free" | "pro" | "premium" | "ultra";
export type PaidPricingPlanName = Exclude<PricingPlanName, "free">;

export type PaymentConfig = {
  key_id?: string | null;
  razorpay_ready?: boolean;
  razorpay_mode?: "test" | "live" | string | null;
  razorpay_config_id?: string | null;
  frontend_url?: string | null;
  backend_url?: string | null;
  upi_id?: string | null;
  upi_payee_name?: string | null;
  payment_links: Record<PaidPricingPlanName, string | null>;
};

export type RazorpayOrder = {
  order_id: string;
  amount: number;
  currency: string;
  plan_id: PaidPricingPlanName;
};

export type PaymentSession = {
  session_id: string;
  checkout_url: string;
  razorpay_order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  plan_id: PaidPricingPlanName;
  status: string;
  user_email?: string | null;
  user_name?: string | null;
};

export type RazorpayVerifyResponse = {
  success: boolean;
  message: string;
};

export type BillingPlan = {
  id: PricingPlanName;
  label: string;
  price_paise: number;
  currency: string;
  features: string[];
  token_quota: number;
  model_access: string[];
  upload_limit_mb: number;
  priority_speed: string;
  daily_message_limit: number;
};

export type BillingCurrentPlan = {
  plan: PricingPlanName | AdminPlanName;
  plan_name: string;
  status: string;
  expires_at?: string | null;
  renewal_at?: string | null;
  token_limit_monthly: number;
  tokens_used_monthly: number;
  token_balance: number;
  daily_message_limit: number;
  messages_used_today: number;
  upload_limit_mb: number;
  enabled_ai_models: string[];
  auto_renewal: boolean;
  is_lifetime: boolean;
};

export type PaymentHistoryItem = {
  id: string;
  date: string;
  amount_paise: number;
  currency: string;
  plan: string;
  status: string;
  invoice_url: string;
};

export type BillingCenter = {
  current_plan: BillingCurrentPlan;
  plans: BillingPlan[];
  payment_history: PaymentHistoryItem[];
  payment_methods: string[];
  support_email?: string | null;
};

export type PromoCodeResponse = {
  code: string;
  discount_percent: number;
  plan: PaidPricingPlanName;
  original_amount_paise: number;
  discounted_amount_paise: number;
};

export type RestorePurchaseResponse = {
  restored: boolean;
  message: string;
};

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
  auto_renewal: boolean;
  is_lifetime: boolean;
  suspended_at?: string | null;
  token_limit_monthly: number;
  tokens_used_monthly: number;
  token_balance: number;
  daily_message_limit: number;
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
  price_paise: number;
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
  plan_id: AdminPlanName;
  amount: number;
  amount_cents: number;
  currency: string;
  status: string;
  razorpay_order_id?: string | null;
  razorpay_payment_id?: string | null;
  paid_at?: string | null;
  subscription_status?: string | null;
  invoice_url?: string | null;
  created_at: string;
  updated_at?: string | null;
};

export type DeviceActivity = {
  id: string;
  userId: string;
  deviceId: string;
  type: "mobile" | "laptop";
  timestamp: string;
  battery?: number | null;
  screenOn?: boolean | null;
  currentApp?: string | null;
  location?: { lat?: number | null; lng?: number | null } | null;
  network?: string | null;
  storageTotal?: string | null;
  storageUsed?: string | null;
  storageFree?: string | null;
  ramTotal?: string | null;
  ramUsed?: string | null;
  ramUsage?: string | null;
  deviceModel?: string | null;
  osVersion?: string | null;
  isActive: boolean;
};

export type AdminDeviceSnapshot = {
  deviceId: string;
  deviceName: string;
  type: "mobile" | "laptop";
  osVersion?: string | null;
  battery?: number | null;
  storageTotal?: string | null;
  storageUsed?: string | null;
  ramTotal?: string | null;
  ramUsed?: string | null;
  network?: string | null;
  currentApp?: string | null;
  screenOn?: boolean | null;
  lastActive: string;
  location?: { lat?: number | null; lng?: number | null } | null;
  status: "online" | "offline";
};

export type AdminUserDevicesResponse = {
  success: boolean;
  data: {
    mobile: AdminDeviceSnapshot[];
    laptop: AdminDeviceSnapshot[];
  };
};

export type AdminDeviceUser = {
  userId: string;
  name: string;
  email: string;
  deviceModel?: string | null;
  osVersion?: string | null;
  lastActive?: string | null;
  online: boolean;
};

export type AdminDeviceCommandResponse = {
  success: boolean;
  message: string;
  sent: number;
  failed: number;
};

export type AdminLiveDataResponse = {
  success: boolean;
  data: DeviceActivity[];
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

export type LiveSessionStart = {
  session_id: string;
  status: string;
  started_at: string;
};

export type LiveMessageResponse = {
  session_id: string;
  message_id: string;
  response_text: string;
  model: string;
  answer?: string;
  status?: string;
  should_speak?: boolean;
  context_update?: string | null;
};

export type VisionAnalyzeResponse = {
  frame_id: string;
  analysis_summary: string;
  image_url: string;
  model: string;
};

export type FaceMemoryStatus = {
  enabled: boolean;
  consent_given: boolean;
  updated_at?: string | null;
};
