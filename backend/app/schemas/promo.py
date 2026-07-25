import re
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


PROMO_CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{2,39}$")
PromoDiscountType = Literal["percentage", "fixed"]
PromoStatusFilter = Literal["all", "active", "inactive", "archived", "expired", "scheduled"]


class PromoCodeBase(BaseModel):
    code: str = Field(min_length=3, max_length=40)
    description: str = Field(default="", max_length=1000)
    discount_type: PromoDiscountType
    discount_value: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    eligible_plans: list[Literal["pro", "premium", "ultra"]] = Field(min_length=1)
    minimum_amount: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    maximum_discount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    total_usage_limit: int | None = Field(default=None, gt=0)
    per_user_limit: int = Field(default=1, gt=0)
    is_active: bool = True
    new_users_only: bool = False

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not PROMO_CODE_PATTERN.fullmatch(normalized):
            raise ValueError("Code must use 3-40 letters, numbers, underscores, or hyphens.")
        return normalized

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str | None) -> str | None:
        return value.strip().upper() if value else None

    @field_validator("eligible_plans")
    @classmethod
    def unique_plans(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def validate_rules(self):
        if self.discount_type == "percentage":
            if self.discount_value > Decimal("100"):
                raise ValueError("Percentage discount cannot exceed 100.")
            if self.currency is not None:
                raise ValueError("Currency is only allowed for fixed discounts.")
        elif not self.currency:
            raise ValueError("Currency is required for fixed discounts.")
        if self.maximum_discount is not None and self.discount_type != "percentage":
            raise ValueError("Maximum discount is only allowed for percentage promos.")
        if self.starts_at and self.expires_at and self.expires_at <= self.starts_at:
            raise ValueError("Expiry must be later than the start date.")
        return self


class PromoCodeCreate(PromoCodeBase):
    pass


class PromoCodeUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=1000)
    discount_type: PromoDiscountType | None = None
    discount_value: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    eligible_plans: list[Literal["pro", "premium", "ultra"]] | None = None
    minimum_amount: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    maximum_discount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    total_usage_limit: int | None = Field(default=None, gt=0)
    per_user_limit: int | None = Field(default=None, gt=0)
    is_active: bool | None = None
    new_users_only: bool | None = None

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str | None) -> str | None:
        return value.strip().upper() if value else None


class PromoCodeRead(BaseModel):
    id: str
    code: str
    description: str
    discount_type: PromoDiscountType
    discount_value: Decimal
    currency: str | None = None
    eligible_plans: list[str]
    minimum_amount: Decimal | None = None
    maximum_discount: Decimal | None = None
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    total_usage_limit: int | None = None
    per_user_limit: int
    usage_count: int
    is_active: bool
    is_archived: bool
    new_users_only: bool
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime
    status: str


class PromoCodePage(BaseModel):
    items: list[PromoCodeRead]
    page: int
    page_size: int
    total: int
    total_pages: int


class PromoArchiveRequest(BaseModel):
    archived: bool = True


class PromoRedemptionRead(BaseModel):
    id: str
    user_id: str
    user_email: str | None = None
    payment_id: str
    original_amount: Decimal
    discount_amount: Decimal
    final_amount: Decimal
    status: str
    redeemed_at: datetime | None = None
    created_at: datetime


class PromoRedemptionPage(BaseModel):
    items: list[PromoRedemptionRead]
    page: int
    page_size: int
    total: int
    total_pages: int
