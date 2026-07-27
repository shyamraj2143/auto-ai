from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class DeviceLocation(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class DeviceActivityCreate(BaseModel):
    deviceId: str | None = Field(default=None, min_length=1, max_length=128)
    type: str = Field(default="mobile", pattern="^(mobile|laptop)$")
    timestamp: datetime | None = None
    battery: int | None = Field(default=None, ge=0, le=100)
    screenOn: bool | None = None
    currentApp: str | None = Field(default=None, max_length=255)
    foregroundAppName: str | None = Field(default=None, max_length=255)
    foregroundPackageName: str | None = Field(default=None, max_length=255)
    activityType: str | None = Field(default=None, max_length=64)
    source: str = Field(default="app_internal", pattern="^(usage_stats|accessibility|app_internal)$")
    permissionGranted: bool = False
    location: DeviceLocation | None = None
    network: str | None = Field(default=None, max_length=80)
    storageTotal: str | None = Field(default=None, max_length=80)
    storageUsed: str | None = Field(default=None, max_length=80)
    storageFree: str | None = Field(default=None, max_length=80)
    ramTotal: str | None = Field(default=None, max_length=80)
    ramUsed: str | None = Field(default=None, max_length=80)
    ramUsage: str | None = Field(default=None, max_length=80)
    deviceModel: str | None = Field(default=None, max_length=120)
    osVersion: str | None = Field(default=None, max_length=80)
    isActive: bool = True

    @field_validator("deviceId", "currentApp", "foregroundAppName", "foregroundPackageName", "activityType", "network", "storageTotal", "storageUsed", "storageFree", "ramTotal", "ramUsed", "ramUsage", "deviceModel", "osVersion")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        cleaned = " ".join(value.strip().split())
        return cleaned or None


class DeviceActivityIngestResponse(BaseModel):
    success: bool = True
    id: str
    activation_required: bool = False
    approved: bool = True


class DeviceRegisterRequest(BaseModel):
    deviceId: str = Field(min_length=1, max_length=128)
    legacyDeviceId: str | None = Field(default=None, max_length=128)
    userId: str | None = Field(default=None, min_length=1, max_length=64)
    platform: str = Field(default="android", max_length=32)
    deviceName: str | None = Field(default=None, max_length=120)
    manufacturer: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=80)
    osVersion: str | None = Field(default=None, max_length=80)
    appVersion: str | None = Field(default=None, max_length=64)
    appVersionCode: int = Field(default=0, ge=0)
    androidSdk: int | None = Field(default=None, ge=24, le=100)
    fcmToken: str | None = Field(default=None, max_length=512)
    permissionsStatus: dict[str, bool] | None = None
    lastSeenAt: datetime | None = None

    @field_validator("deviceId", "legacyDeviceId", "userId", "platform", "deviceName", "manufacturer", "model", "osVersion", "appVersion", "fcmToken")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        cleaned = " ".join(value.strip().split())
        return cleaned or None


class DeviceRegisterResponse(BaseModel):
    success: bool = True
    deviceId: str
    registered: bool = True
    activation_required: bool = False
    approved: bool = True
    fcmTokenStored: bool = False
    fcmTokenHash: str | None = None


class DeviceHeartbeatRequest(BaseModel):
    deviceId: str = Field(min_length=1, max_length=128)
    userId: str | None = Field(default=None, min_length=1, max_length=64)
    battery: int | None = Field(default=None, ge=0, le=100)
    batteryLevel: int | None = Field(default=None, ge=0, le=100)
    charging: bool | None = None
    network: str | None = Field(default=None, max_length=80)
    networkType: str | None = Field(default=None, max_length=80)
    screenStatus: str | bool | None = None
    storageTotal: str | None = Field(default=None, max_length=80)
    storageUsed: str | None = Field(default=None, max_length=80)
    ramTotal: str | None = Field(default=None, max_length=80)
    ramUsed: str | None = Field(default=None, max_length=80)
    permissionsStatus: dict[str, bool] | None = None
    lastSeenAt: datetime | None = None

    @field_validator("deviceId", "userId", "network", "networkType", "storageTotal", "storageUsed", "ramTotal", "ramUsed")
    @classmethod
    def normalize_heartbeat_text(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        cleaned = " ".join(value.strip().split())
        return cleaned or None


class DeviceCommandAckRequest(BaseModel):
    deviceId: str | None = Field(default=None, min_length=1, max_length=128)
    status: str = Field(default="acknowledged", pattern="^(acknowledged|failed)$")
