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

    @field_validator("deviceId", "currentApp", "network", "storageTotal", "storageUsed", "storageFree", "ramTotal", "ramUsed", "ramUsage", "deviceModel", "osVersion")
    @classmethod
    def clean_text(cls, value: str | None) -> str | None:
        if not isinstance(value, str):
            return value
        cleaned = " ".join(value.strip().split())
        return cleaned or None


class DeviceActivityRead(BaseModel):
    id: str
    userId: str
    deviceId: str
    type: str
    timestamp: datetime
    battery: int | None = None
    screenOn: bool | None = None
    currentApp: str | None = None
    location: DeviceLocation | None = None
    network: str | None = None
    storageTotal: str | None = None
    storageUsed: str | None = None
    storageFree: str | None = None
    ramTotal: str | None = None
    ramUsed: str | None = None
    ramUsage: str | None = None
    deviceModel: str | None = None
    osVersion: str | None = None
    isActive: bool


class DeviceActivityIngestResponse(BaseModel):
    success: bool = True
    id: str


class AdminDeviceCommandResponse(BaseModel):
    success: bool = True
    message: str
    sent: int = 0
    failed: int = 0


class AdminLiveDataResponse(BaseModel):
    success: bool = True
    data: list[DeviceActivityRead]


class AdminDeviceSnapshotRead(BaseModel):
    deviceId: str
    deviceName: str
    type: str
    osVersion: str | None = None
    battery: int | None = None
    storageTotal: str | None = None
    storageUsed: str | None = None
    ramTotal: str | None = None
    ramUsed: str | None = None
    network: str | None = None
    currentApp: str | None = None
    screenOn: bool | None = None
    lastActive: datetime
    location: DeviceLocation | None = None
    status: str


class AdminUserDevicesData(BaseModel):
    mobile: list[AdminDeviceSnapshotRead]
    laptop: list[AdminDeviceSnapshotRead]


class AdminUserDevicesResponse(BaseModel):
    success: bool = True
    data: AdminUserDevicesData


class AdminDeviceUserRead(BaseModel):
    userId: str
    name: str
    email: str
    deviceModel: str | None = None
    osVersion: str | None = None
    lastActive: datetime | None = None
    online: bool = False
