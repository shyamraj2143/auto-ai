from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


PaidPlan = Literal["pro", "premium", "ultra"]


class PaymentLinkConfig(BaseModel):
    pro: str | None = None
    premium: str | None = None
    ultra: str | None = None


class PaymentConfigRead(BaseModel):
    key_id: str | None = None
    razorpay_ready: bool = False
    razorpay_config_id: str | None = None
    upi_id: str | None = None
    upi_payee_name: str | None = None
    payment_links: PaymentLinkConfig


class CreateOrderRequest(BaseModel):
    amount: int
    currency: str = Field(default="INR", min_length=3, max_length=3)
    receipt: str | None = Field(default=None, max_length=40)
    checkout_config_id: str | None = Field(default=None, max_length=80)
    plan_id: PaidPlan | None = None
    plan: PaidPlan | None = None
    promo_code: str | None = Field(default=None, max_length=40)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("receipt")
    @classmethod
    def normalize_receipt(cls, value: str | None) -> str | None:
        if not value:
            return value
        return value.strip() or None

    @field_validator("checkout_config_id")
    @classmethod
    def normalize_checkout_config_id(cls, value: str | None) -> str | None:
        if not value:
            return value
        candidate = value.strip()
        return candidate if candidate.startswith("config_") else None

    @field_validator("promo_code")
    @classmethod
    def normalize_promo_code(cls, value: str | None) -> str | None:
        return value.strip().upper() or None if value else value


class CreateOrderResponse(BaseModel):
    order_id: str
    amount: int
    currency: str
    plan_id: PaidPlan


class VerifyPaymentRequest(BaseModel):
    razorpay_payment_id: str | None = None
    razorpay_order_id: str | None = None
    razorpay_signature: str | None = None
    plan_id: PaidPlan | None = None
    plan: PaidPlan | None = None
    amount: int | None = None
    currency: str = Field(default="INR", min_length=3, max_length=3)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.strip().upper()


class VerifyPaymentResponse(BaseModel):
    success: bool
    message: str


class BillingPlanRead(BaseModel):
    id: str
    label: str
    price_paise: int
    currency: str = "INR"
    features: list[str]
    token_quota: int
    model_access: list[str]
    upload_limit_mb: int
    priority_speed: str
    daily_message_limit: int


class BillingCurrentPlanRead(BaseModel):
    plan: str
    plan_name: str
    status: str
    expires_at: datetime | None = None
    renewal_at: datetime | None = None
    token_limit_monthly: int
    tokens_used_monthly: int
    token_balance: int
    daily_message_limit: int
    messages_used_today: int
    upload_limit_mb: int
    enabled_ai_models: list[str]
    auto_renewal: bool
    is_lifetime: bool


class PaymentHistoryRead(BaseModel):
    id: str
    date: datetime
    amount_paise: int
    currency: str
    plan: str
    status: str
    invoice_url: str


class BillingCenterRead(BaseModel):
    current_plan: BillingCurrentPlanRead
    plans: list[BillingPlanRead]
    payment_history: list[PaymentHistoryRead]
    payment_methods: list[str]
    support_email: str | None = None


class PromoCodeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    plan: PaidPlan

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class PromoCodeResponse(BaseModel):
    code: str
    discount_percent: int
    plan: PaidPlan
    original_amount_paise: int
    discounted_amount_paise: int


class AutoRenewalUpdate(BaseModel):
    auto_renewal: bool


class RestorePurchaseResponse(BaseModel):
    restored: bool
    message: str
