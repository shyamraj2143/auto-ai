from functools import lru_cache
import ipaddress
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import AliasChoices, AnyHttpUrl, EmailStr, Field, SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FRONTEND_URL = "https://autoai.site.je"
DEFAULT_BACKEND_URL = "http://localhost:8000"
DEFAULT_RAZORPAY_CHECKOUT_CONFIG_ID = "config_T9uIbVgLBfz7ko"
DEFAULT_UPLOAD_DIR = str(PROJECT_ROOT / "backend" / "uploads")
DEFAULT_LIBRARY_STORAGE_DIR = str(PROJECT_ROOT / "backend" / "library_uploads")
DEFAULT_FORM_SERVICE_STORAGE_DIR = str(PROJECT_ROOT / "backend" / "private" / "form-service")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    PROJECT_NAME: str = "Auto-AI"
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = "development"
    FRONTEND_URL: str = DEFAULT_FRONTEND_URL
    RAILWAY_PUBLIC_DOMAIN: str | None = None
    RAILWAY_GIT_COMMIT_SHA: str | None = None
    RAILWAY_DEPLOYMENT_ID: str | None = None
    BACKEND_URL: str | None = Field(default=None, validate_default=True)
    RAZORPAY_CALLBACK_URL: str | None = None
    RAZORPAY_FAILURE_URL: str | None = None

    SECRET_KEY: str = Field(default="change-me-in-production")
    JWT_SECRET_KEY: str | None = None
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    PASSWORD_RESET_TOKEN_EXPIRE_MINUTES: int = 45
    PASSWORD_RESET_FROM_EMAIL: str | None = None
    PASSWORD_RESET_FROM_NAME: str = "Auto-AI"
    SMTP_HOST: str | None = None
    SMTP_PORT: int = 587
    SMTP_USERNAME: str | None = None
    SMTP_PASSWORD: SecretStr | None = None
    SMTP_USE_TLS: bool = True
    SMTP_USE_SSL: bool = False

    GOOGLE_CLIENT_ID: str | None = None
    GOOGLE_ANDROID_CLIENT_ID: str | None = None
    GOOGLE_WEB_CLIENT_ID: str | None = None
    FIREBASE_PROJECT_ID: str | None = Field(default=None, validation_alias=AliasChoices("FIREBASE_PROJECT_ID", "FCM_PROJECT_ID"))
    FCM_ENABLED: bool = True
    FIREBASE_CLIENT_EMAIL: str | None = None
    FIREBASE_PRIVATE_KEY: SecretStr | None = None
    FIREBASE_SERVICE_ACCOUNT_JSON: SecretStr | None = Field(default=None, validation_alias=AliasChoices("FIREBASE_SERVICE_ACCOUNT_JSON", "FCM_SERVICE_ACCOUNT_JSON"))
    FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: SecretStr | None = None
    FIREBASE_SERVICE_ACCOUNT_FILE: str | None = None
    UPDATE_NOTIFY_SECRET: SecretStr | None = Field(default=None, validation_alias=AliasChoices("UPDATE_NOTIFY_SECRET", "AUTO_AI_UPDATE_NOTIFY_SECRET"))

    CALL_FEATURE_ENABLED: bool = True
    REDIS_URL: str | None = None
    TURN_PROVIDER: str = "coturn"
    TURN_SERVER_URLS: list[str] = []
    TURN_SHARED_SECRET: SecretStr | None = None
    TURN_REALM: str | None = None
    TURN_CREDENTIAL_TTL: int = 3600
    METERED_DOMAIN: str | None = None
    METERED_TURN_API_KEY: SecretStr | None = None
    METERED_TURN_TIMEOUT_SECONDS: float = 5.0
    CALL_RING_TIMEOUT_SECONDS: int = 30
    CALL_SYSTEM_FALLBACK_DELAY_SECONDS: int = 7
    CALL_NOTIFICATION_TTL_SECONDS: int = 30
    CALL_RECONNECT_GRACE_SECONDS: int = 18
    CALL_MAX_ATTEMPTS_PER_MINUTE: int = 8
    CALL_SEARCH_MAX_PER_MINUTE: int = 30
    CALL_SIGNAL_MAX_PER_MINUTE: int = 360
    CALL_ICE_MAX_PER_CALL: int = 256
    CALL_WS_TICKET_TTL_SECONDS: int = 60
    CALL_PRESENCE_TTL_SECONDS: int = 55
    RELATIONSHIP_FOLLOWUP_WORKER_ENABLED: bool = True
    RELATIONSHIP_FOLLOWUP_POLL_SECONDS: int = Field(default=30, ge=5, le=3600)
    RELATIONSHIP_FOLLOWUP_BATCH_SIZE: int = Field(default=50, ge=1, le=100)
    SCREEN_SHARE_GUEST_TOKEN_TTL_SECONDS: int = 7200
    SCREEN_SHARE_JOIN_MAX_PER_MINUTE: int = 10
    BACKEND_CORS_ORIGINS: list[AnyHttpUrl | str] = ["https://autoai.site.je", "https://www.autoai.site.je", "http://autoai.site.je"]
    TRUSTED_HOSTS: list[str] = ["autoai.site.je", "www.autoai.site.je", "localhost", "127.0.0.1", "testserver"]
    MAX_REQUEST_BODY_MB: int = 110

    DATABASE_URL: str | None = None
    MYSQL_URL: str | None = None
    SQLITE_PATH: str = str(PROJECT_ROOT / "database" / "auto_ai.db")
    DB_BACKEND: str = "sqlite"
    MONGODB_URL: str | None = None
    MONGODB_DATABASE: str = "auto_ai"

    AI_PROVIDER: str = "groq"
    GROQ_API_KEY: str | None = None
    AUTO_AI_GROQ_API_KEY: str | None = None
    GROQ_MODEL: str = "openai/gpt-oss-120b"
    GROQ_SEARCH_MODEL: str = "groq/compound-mini"
    GROQ_VISION_MODEL: str = "meta-llama/llama-4-scout-17b-16e-instruct"
    ALARM_GROQ_VISION_MODEL: str = "qwen/qwen3.6-27b"
    BEDROCK_VISION_MODEL: str = "qwen.qwen3-vl-235b-a22b-instruct"
    GROQ_AUDIO_MODEL: str = "whisper-large-v3-turbo"
    GROQ_ALARM_MODEL: str | None = None
    GROQ_ALARM_TRANSCRIPTION_MODEL: str | None = None
    GROQ_ALARM_TIMEOUT_SECONDS: float = 12.0
    GROQ_ASSISTANT_MODEL: str | None = None
    GROQ_TRANSCRIPTION_MODEL: str | None = None
    GROQ_REQUEST_TIMEOUT_SECONDS: float = 30.0

    OPENAI_API_KEY: str | None = Field(default=None, validation_alias="AUTO_AI_OPENAI_API_KEY")
    OPENAI_MODEL: str = "gpt-4.1-mini"
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    GEMINI_API_KEY: str | None = None
    GEMINI_MODEL: str = "gemini-2.5-flash"
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    BEDROCK_API_KEY: str | None = None
    BEDROCK_REGION: str = "us-east-1"
    BEDROCK_MODEL: str = "openai.gpt-oss-120b"
    BEDROCK_BASE_URL: str | None = None
    BEDROCK_AUTH_MODE: str = "auto"
    BEDROCK_ENDPOINT_MODE: str = "mantle"
    BEDROCK_MANTLE_BASE_URL: str | None = None
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None
    AWS_SESSION_TOKEN: str | None = None

    GROQ_TEMPERATURE: float = 0.3
    GROQ_MAX_TOKENS: int = 4096
    MAX_CONTEXT_MESSAGES: int = 24
    MAX_DOCUMENT_CONTEXT_CHARS: int = 24000
    DOCUMENT_OCR_MAX_PAGES: int = 12

    GROQ_RESEARCH_MODELS: list[str] = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "openai/gpt-oss-120b"]
    BEDROCK_RESEARCH_MODELS: list[str] = ["amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0", "anthropic.claude-3-haiku-20240307-v1:0"]
    OPENAI_RESEARCH_MODELS: list[str] = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"]
    GEMINI_RESEARCH_MODELS: list[str] = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"]
    DEEP_RESEARCH_DEFAULT_MAX_MODELS: int = 100
    DEEP_RESEARCH_MAX_MODELS: int = 100
    DEEP_RESEARCH_MAX_INPUT_TOKENS: int = 6000
    DEEP_RESEARCH_MAX_OUTPUT_TOKENS: int = 1200
    DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS: int = 45
    DEEP_RESEARCH_RATE_LIMIT_PER_MINUTE: int = 8
    DEEP_RESEARCH_GROQ_TPM_BUDGET: int = 7600
    DEEP_RESEARCH_JUDGE_PROVIDER: str = "groq"
    DEEP_RESEARCH_JUDGE_MODEL: str | None = None
    ORCHESTRATION_GROQ_MODELS: list[str] = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3-32b", "meta-llama/llama-4-scout-17b-16e-instruct"]
    ORCHESTRATION_BEDROCK_MODELS: list[str] = ["amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0", "anthropic.claude-3-haiku-20240307-v1:0"]
    ORCHESTRATION_INSTANT_FALLBACKS: list[str] = ["openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]
    ORCHESTRATION_GROQ_CODING_MODEL: str | None = None
    ORCHESTRATION_BEDROCK_CODING_MODEL: str | None = None
    ORCHESTRATION_INCLUDE_ALL_AVAILABLE_MODELS: bool = True
    ORCHESTRATION_MAX_PARALLEL: int = 9
    ORCHESTRATION_MAX_RETRIES: int = 1
    ORCHESTRATION_TOTAL_TIMEOUT_SECONDS: int = 90
    ORCHESTRATION_HEALTH_TTL_SECONDS: int = 300
    ORCHESTRATION_CIRCUIT_FAILURE_THRESHOLD: int = 3
    ORCHESTRATION_CIRCUIT_COOLDOWN_SECONDS: int = 120
    ORCHESTRATION_MAX_OUTPUT_TOKENS: int = 1600
    ORCHESTRATION_MAX_EVENTS_PER_GENERATION: int = 500

    TAVILY_API_KEY: str | None = None
    SERPER_API_KEY: str | None = None
    SEARCH_CACHE_TTL_SECONDS: int = 60 * 30
    SEARCH_MAX_RESULTS: int = 6
    SEARCH_DEEP_MAX_RESULTS: int = 10
    SEARCH_COUNTRY: str = "us"
    SEARCH_LANGUAGE: str = "en"
    RESPONSE_CACHE_ENABLED: bool = True
    RESPONSE_CACHE_TTL_SECONDS: int = 300
    RESPONSE_CACHE_MAX_ENTRIES: int = 500
    RESPONSE_CACHE_MAX_ITEM_CHARS: int = 100_000

    SELF_ENGINE_ENABLED: bool = True
    SELF_ENGINE_INTERVAL_SECONDS: int = Field(default=21600, ge=900, le=604800)

    UPLOAD_DIR: str = DEFAULT_UPLOAD_DIR
    LIBRARY_STORAGE_DIR: str = DEFAULT_LIBRARY_STORAGE_DIR
    FORM_SERVICE_STORAGE_DIR: str = DEFAULT_FORM_SERVICE_STORAGE_DIR
    FORM_SERVICE_MAX_UPLOAD_MB: int = 10
    FORM_SERVICE_MAX_PDF_PAGES: int = 50
    LIBRARY_MAX_UPLOAD_MB: int = 20
    LIBRARY_STORAGE_BACKEND: str = "local"
    LIBRARY_S3_BUCKET: str | None = None
    LIBRARY_S3_ENDPOINT_URL: str | None = None
    LIBRARY_S3_REGION: str = "us-east-1"
    LIBRARY_S3_ACCESS_KEY_ID: str | None = None
    LIBRARY_S3_SECRET_ACCESS_KEY: SecretStr | None = None
    APK_STORAGE_DIR: str = str(PROJECT_ROOT / "public" / "downloads")
    APK_FILENAME: str = "auto-ai.apk"
    APK_DEFAULT_VERSION: str = "1.0.18"
    APK_DEFAULT_VERSION_CODE: int = 19
    APK_MIN_ANDROID_VERSION: str = "Android 7.0"
    MAX_APK_UPLOAD_MB: int = 100
    MAX_UPLOAD_MB: int = 20
    ALLOWED_DOCUMENT_EXTENSIONS: set[str] = {".pdf", ".txt", ".docx"}
    ALLOWED_IMAGE_EXTENSIONS: set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    ALLOWED_AUDIO_EXTENSIONS: set[str] = {".flac", ".mp3", ".m4a", ".mpeg", ".mpga", ".ogg", ".wav", ".webm"}
    RATE_LIMIT_PER_MINUTE: int = 90
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 8
    RATE_LIMIT_REGISTER_PER_MINUTE: int = 5
    RATE_LIMIT_PASSWORD_RESET_PER_MINUTE: int = 5

    @property
    def sqlalchemy_database_url(self) -> str:
        """Return the SQLAlchemy URL used by the relational database layer."""
        raw_url = (self.DATABASE_URL or self.MYSQL_URL or "").strip()
        if raw_url:
            if raw_url.startswith("postgres://"):
                return "postgresql://" + raw_url[len("postgres://"):]
            return raw_url
        sqlite_path = Path(self.SQLITE_PATH).expanduser()
        if not sqlite_path.is_absolute():
            sqlite_path = PROJECT_ROOT / sqlite_path
        return f"sqlite:///{sqlite_path}"

    @property
    def database_backend(self) -> str:
        url = self.sqlalchemy_database_url.lower()
        if url.startswith("postgresql"):
            return "postgresql"
        if url.startswith("mysql"):
            return "mysql"
        if url.startswith("sqlite"):
            return "sqlite"
        return self.DB_BACKEND.lower()

    @property
    def safe_database_target(self) -> str:
        url = self.sqlalchemy_database_url
        if url.startswith("sqlite:///"):
            return url
        try:
            parsed = urlsplit(url)
            if parsed.hostname:
                host = parsed.hostname
                if parsed.port:
                    host = f"{host}:{parsed.port}"
                return urlunsplit((parsed.scheme, host, parsed.path or "", "", ""))
        except ValueError:
            pass
        return "<configured database>"

    @property
    def persistent_storage(self) -> bool:
        if self.database_backend != "sqlite":
            return True
        path = Path(self.SQLITE_PATH).expanduser()
        return bool(path.is_absolute() and any(part in {"data", "database", "persistent"} for part in path.parts))

    @property
    def frontend_url(self) -> str:
        """Backward-compatible lowercase URL accessor used by existing services."""
        return str(self.FRONTEND_URL or DEFAULT_FRONTEND_URL).rstrip("/")

    @property
    def backend_url(self) -> str:
        """Return the effective public backend URL, normalised for callers."""
        configured = (self.BACKEND_URL or "").strip().strip('"').strip("'").rstrip("/")
        if configured:
            if not re.match(r"^https?://", configured, re.IGNORECASE):
                configured = f"https://{configured}"
            return configured
        railway_domain = (self.RAILWAY_PUBLIC_DOMAIN or "").strip().strip('"').strip("'").rstrip("/")
        if railway_domain:
            if not re.match(r"^https?://", railway_domain, re.IGNORECASE):
                railway_domain = f"https://{railway_domain}"
            return railway_domain
        return DEFAULT_BACKEND_URL

    @property
    def razorpay_callback_url(self) -> str | None:
        return self.RAZORPAY_CALLBACK_URL

    @property
    def razorpay_failure_url(self) -> str | None:
        return self.RAZORPAY_FAILURE_URL

    @property
    def redis_url(self) -> str | None:
        """Backward-compatible lowercase accessor for Redis URL consumers."""
        return self.REDIS_URL

    @property
    def turn_configured(self) -> bool:
        return bool(self.TURN_SERVER_URLS or (self.METERED_DOMAIN and self.METERED_TURN_API_KEY))

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
