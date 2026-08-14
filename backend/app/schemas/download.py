from datetime import datetime

from pydantic import BaseModel, Field, model_validator


PUBLIC_APK_DOWNLOAD_URL = "https://auto-ai-app-download.up.railway.app/"


class ApkReleaseRead(BaseModel):
    id: str
    version_code: int
    version_name: str
    apk_url: str
    file_name: str
    file_size: int
    changelog: str = ""
    force_update: bool
    is_active: bool
    download_count: int
    created_at: datetime
    updated_at: datetime
    released_at: datetime
    release_date: datetime
    version: str
    filename: str
    sha256: str
    min_android_version: str
    minimum_android_sdk: int = 24
    minimum_supported_version_code: int = 1
    package_name: str = "com.autoai.app"
    release_id: str = ""
    release_notes: list[str] = Field(default_factory=list)
    download_url: str

    @model_validator(mode="after")
    def use_public_download_host(self) -> "ApkReleaseRead":
        # Keep release metadata stable while moving the actual APK download to
        # the dedicated Railway download service. The API remains the source of
        # truth for release metadata and download counting.
        self.apk_url = PUBLIC_APK_DOWNLOAD_URL
        self.download_url = PUBLIC_APK_DOWNLOAD_URL
        return self


class ApkReleaseCreate(BaseModel):
    version_name: str = Field(pattern=r"^\d+\.\d+\.\d+([.-][A-Za-z0-9]+)?$")
    version_code: int = Field(ge=1)
    apk_url: str | None = Field(default=None, max_length=500)
    file_name: str | None = Field(default=None, max_length=255)
    file_size: int = Field(default=0, ge=0)
    is_active: bool = True
    released_at: datetime | None = None
    min_android_version: str = Field(default="Android 7.0", max_length=40)
    release_notes: list[str] = Field(default_factory=list, max_length=20)
    changelog: str = Field(default="", max_length=8000)
    force_update: bool = False


class ApkReleaseUpdate(BaseModel):
    version_name: str | None = Field(default=None, pattern=r"^\d+\.\d+\.\d+([.-][A-Za-z0-9]+)?$")
    version_code: int | None = Field(default=None, ge=1)
    apk_url: str | None = Field(default=None, max_length=500)
    file_name: str | None = Field(default=None, max_length=255)
    file_size: int | None = Field(default=None, ge=0)
    changelog: str | None = Field(default=None, max_length=8000)
    force_update: bool | None = None
    release_notes: list[str] | None = Field(default=None, max_length=20)
    is_active: bool | None = None
    released_at: datetime | None = None
    minimum_supported_version_code: int | None = Field(default=None, ge=1)


class ApkDownloadCountRequest(BaseModel):
    id: str | None = None
    version_name: str | None = None
    version_code: int | None = None


class ApkVersionUpsert(BaseModel):
    id: str | None = None
    version_code: int = Field(ge=1)
    version_name: str = Field(pattern=r"^\d+\.\d+\.\d+([.-][A-Za-z0-9]+)?$")
    apk_url: str = Field(min_length=1, max_length=500)
    file_name: str | None = Field(default=None, max_length=255)
    file_size: int = Field(default=0, ge=0)
    sha256: str = Field(default="", pattern=r"^$|^[A-Fa-f0-9]{64}$")
    changelog: str = Field(default="", max_length=8000)
    force_update: bool = False
    is_active: bool = True
    released_at: datetime | None = None
    min_android_version: str = Field(default="Android 7.0", max_length=40)
    release_notes: list[str] = Field(default_factory=list, max_length=20)


class ApkStats(BaseModel):
    latest: ApkReleaseRead | None
    total_downloads: int
    downloads_by_version: dict[str, int]
