from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator


class AdminSubscriptionSummary(BaseModel):
    plan: str
    is_active: bool
    expires_at: datetime | None = None
    payment_status: str
    expiry_status: str


class AdminUserUsageSummary(BaseModel):
    total_prompts: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    total_chats: int = 0


class AdminUserRead(BaseModel):
    id: str
    email: EmailStr
    mobile: str | None = None
    name: str
    role: str
    status: str
    is_active: bool
    is_admin: bool
    created_at: datetime
    updated_at: datetime
    subscription: AdminSubscriptionSummary | None = None
    usage: AdminUserUsageSummary | None = None


class AdminUserStatusUpdate(BaseModel):
    is_active: bool = Field(description="true to unblock, false to block")


class AdminUserRoleUpdate(BaseModel):
    role: str = Field(pattern="^(user|admin|super_admin)$")


class AdminUserPasswordReset(BaseModel):
    new_password: str = Field(min_length=8, max_length=128)


class AdminCreateUser(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: str = Field(pattern="^(admin|super_admin)$")


class TokenUsageSummary(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class SystemStatus(BaseModel):
    environment: str
    database_backend: str
    python_version: str
    storage_total_gb: float
    storage_free_gb: float


class AdminStats(BaseModel):
    total_users: int
    active_users: int
    blocked_users: int
    total_chats: int
    total_api_usage: int
    active_subscriptions: int = 0
    paid_subscriptions: int = 0
    total_revenue_cents: int = 0
    user_count: int
    chat_count: int
    message_count: int
    document_count: int
    api_calls: int
    token_usage: TokenUsageSummary
    system: SystemStatus


class AdminSubscriptionRead(BaseModel):
    id: str
    user_id: str
    user_name: str
    user_email: EmailStr
    plan: str
    is_active: bool
    expires_at: datetime | None = None
    payment_status: str
    razorpay_customer_id: str | None = None
    razorpay_payment_id: str | None = None
    stripe_customer_id: str | None = None
    stripe_payment_id: str | None = None
    expiry_status: str
    created_at: datetime
    updated_at: datetime


class AdminSubscriptionUpdate(BaseModel):
    plan: str | None = Field(default=None, pattern="^(free|pro|pro-plus|admin)$")
    is_active: bool | None = None
    expires_at: datetime | None = None
    payment_status: str | None = Field(default=None, max_length=32)
    razorpay_customer_id: str | None = Field(default=None, max_length=120)
    razorpay_payment_id: str | None = Field(default=None, max_length=120)
    stripe_customer_id: str | None = Field(default=None, max_length=120)
    stripe_payment_id: str | None = Field(default=None, max_length=120)

    @field_validator("payment_status")
    @classmethod
    def normalize_payment_status(cls, value: str | None) -> str | None:
        return value.strip().lower() if value else value


class AdminUsageProviderSummary(BaseModel):
    provider: str
    requests: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class AdminUsageUserSummary(BaseModel):
    user_id: str
    user_name: str
    user_email: EmailStr
    plan: str
    total_prompts: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    providers: list[AdminUsageProviderSummary]


class AdminUsageTimeBucket(BaseModel):
    period: str
    requests: int
    total_tokens: int


class AdminUsageResponse(BaseModel):
    users: list[AdminUsageUserSummary]
    providers: list[AdminUsageProviderSummary]
    daily: list[AdminUsageTimeBucket]
    monthly: list[AdminUsageTimeBucket]


class AdminFeatureFlagRead(BaseModel):
    id: str
    key: str
    scope: str
    user_id: str | None = None
    user_email: EmailStr | None = None
    enabled: bool
    description: str
    created_at: datetime
    updated_at: datetime


class AdminFeatureFlagUpdate(BaseModel):
    key: str
    enabled: bool
    user_id: str | None = None


class AdminPlanLimitRead(BaseModel):
    id: str
    plan: str
    daily_prompt_limit: int
    monthly_prompt_limit: int
    daily_token_limit: int
    monthly_token_limit: int
    max_models: int
    allow_deep_research: bool
    allow_multi_model: bool
    allow_web_search: bool
    created_at: datetime
    updated_at: datetime


class AdminPlanLimitUpdate(BaseModel):
    daily_prompt_limit: int | None = Field(default=None, ge=0)
    monthly_prompt_limit: int | None = Field(default=None, ge=0)
    daily_token_limit: int | None = Field(default=None, ge=0)
    monthly_token_limit: int | None = Field(default=None, ge=0)
    max_models: int | None = Field(default=None, ge=0, le=50)
    allow_deep_research: bool | None = None
    allow_multi_model: bool | None = None
    allow_web_search: bool | None = None


class AdminFeaturesResponse(BaseModel):
    flags: list[AdminFeatureFlagRead]
    plan_limits: list[AdminPlanLimitRead]


class AdminPaymentRecordRead(BaseModel):
    id: str
    user_id: str | None = None
    user_name: str | None = None
    user_email: EmailStr | None = None
    provider: str
    customer_id: str | None = None
    payment_id: str | None = None
    subscription_id: str | None = None
    plan: str
    amount_cents: int
    currency: str
    status: str
    created_at: datetime


class AdminAnalyticsResponse(BaseModel):
    stats: AdminStats
    subscriptions_by_plan: dict[str, int]
    users_by_status: dict[str, int]
    usage_by_provider: list[AdminUsageProviderSummary]
    payments_by_status: dict[str, int]
    daily_usage: list[AdminUsageTimeBucket]
