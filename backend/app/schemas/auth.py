from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator


class UserCreate(BaseModel):
    email: EmailStr
    mobile: str | None = Field(default=None, min_length=6, max_length=32)
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=128)


class UserLogin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetConfirm(BaseModel):
    token: str = Field(min_length=32, max_length=512)
    password: str = Field(min_length=8, max_length=128)


class PasswordResetResult(BaseModel):
    message: str
    reset_url: str | None = None


class UserRead(BaseModel):
    id: str
    email: EmailStr
    mobile: str | None = None
    name: str
    username: str | None = None
    phone_number: str | None = None
    phone_country_code: str | None = None
    phone_verified: bool = False
    phone_verified_at: datetime | None = None
    picture: str | None = None
    avatar: str | None = None
    provider: str = "email"
    google_id: str | None = None
    is_admin: bool
    role: str = "user"
    subscription_status: str = "free"
    intelligence_mode: str = "instant"
    memory_enabled: bool = True
    feedback_learning_enabled: bool = True
    created_at: datetime
    updated_at: datetime
    profile_updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class UserProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    username: str | None = Field(default=None, min_length=3, max_length=30)
    phone_country_code: str | None = Field(default=None, max_length=8)
    phone_number: str | None = Field(default=None, max_length=32)
    memory_enabled: bool | None = None
    feedback_learning_enabled: bool | None = None


class PhoneVerificationSend(BaseModel):
    phone_country_code: str = Field(min_length=2, max_length=8)
    phone_number: str = Field(min_length=6, max_length=32)


class PhoneVerificationCheck(BaseModel):
    code: str = Field(min_length=4, max_length=10)

    @field_validator("code")
    @classmethod
    def digits_only(cls, value: str) -> str:
        normalized = "".join(character for character in value if character.isdigit())
        if not 4 <= len(normalized) <= 10:
            raise ValueError("Enter a valid verification code.")
        return normalized


class PhoneVerificationStatus(BaseModel):
    message: str
    destination: str
    expires_in_seconds: int = 600
    resend_after_seconds: int = 30
    verified: bool = False
    user: UserRead | None = None


class UsernameAvailability(BaseModel):
    username: str
    available: bool
    valid: bool
    message: str


class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserRead


class GoogleTokenRequest(BaseModel):
    id_token: str = Field(min_length=32, max_length=8192)


class RefreshRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=32, max_length=8192)


class LogoutRequest(BaseModel):
    refresh_token: str | None = Field(default=None, min_length=32, max_length=8192)


class GoogleConfig(BaseModel):
    enabled: bool
    client_id: str | None = None
