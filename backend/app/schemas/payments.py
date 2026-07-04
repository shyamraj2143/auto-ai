from typing import Literal

from pydantic import BaseModel, Field, field_validator


PaidPlan = Literal["pro", "premium", "ultra"]


class PaymentLinkConfig(BaseModel):
    pro: str | None = None
    premium: str | None = None
    ultra: str | None = None


class PaymentConfigRead(BaseModel):
    key_id: str | None = None
    payment_links: PaymentLinkConfig


class CreateOrderRequest(BaseModel):
    amount: int
    currency: str = Field(default="INR", min_length=3, max_length=3)
    receipt: str | None = Field(default=None, max_length=40)
    plan: PaidPlan | None = None

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


class CreateOrderResponse(BaseModel):
    order_id: str
    amount: int
    currency: str


class VerifyPaymentRequest(BaseModel):
    razorpay_payment_id: str | None = None
    razorpay_order_id: str | None = None
    razorpay_signature: str | None = None
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
