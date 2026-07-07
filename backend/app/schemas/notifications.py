from pydantic import BaseModel, Field, field_validator


class DeviceTokenRegisterRequest(BaseModel):
    token: str = Field(min_length=20, max_length=512)
    platform: str = Field(default="android", max_length=32)
    app_version: str | None = Field(default=None, max_length=64)
    version_code: int = Field(default=0, ge=0)

    @field_validator("token", "platform", "app_version")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class DeviceTokenRegisterResponse(BaseModel):
    registered: bool = True


class ApkUpdateNotificationRequest(BaseModel):
    version_code: int = Field(ge=1)
    version_name: str = Field(min_length=1, max_length=64)
    changelog: str | None = Field(default=None, max_length=500)


class ApkUpdateNotificationResponse(BaseModel):
    sent: int = 0
    failed: int = 0
    inactive: int = 0
    skipped: bool = False
    detail: str = ""
