from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import AnyHttpUrl, EmailStr, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", PROJECT_ROOT / ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    PROJECT_NAME: str = "Auto-AI"
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = "development"

    SECRET_KEY: str = Field(default="change-me-in-production")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24

    BACKEND_CORS_ORIGINS: list[AnyHttpUrl | str] = [
        "https://autoai.site.je",
        "http://autoai.site.je",
    ]



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
    GROQ_AUDIO_MODEL: str = "whisper-large-v3-turbo"

    OPENAI_API_KEY: str | None = Field(
        default=None,
        validation_alias="AUTO_AI_OPENAI_API_KEY",
    )
    OPENAI_MODEL: str = "gpt-4.1-mini"
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"

    GEMINI_API_KEY: str | None = None
    GEMINI_MODEL: str = "gemini-2.5-flash"
    GEMINI_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta/openai"

    BEDROCK_API_KEY: str | None = None
    BEDROCK_REGION: str = "us-south-1"
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

    GROQ_RESEARCH_MODELS: list[str] = [
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "openai/gpt-oss-120b",
    ]
    BEDROCK_RESEARCH_MODELS: list[str] = [
        "amazon.nova-pro-v1:0",
        "amazon.nova-lite-v1:0",
        "anthropic.claude-3-haiku-20240307-v1:0",
    ]
    OPENAI_RESEARCH_MODELS: list[str] = [
        "gpt-4.1-mini",
        "gpt-4o-mini",
        "gpt-4.1",
    ]
    GEMINI_RESEARCH_MODELS: list[str] = [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
    ]
    DEEP_RESEARCH_DEFAULT_MAX_MODELS: int = 3
    DEEP_RESEARCH_MAX_MODELS: int = 6
    DEEP_RESEARCH_MAX_INPUT_TOKENS: int = 6000
    DEEP_RESEARCH_MAX_OUTPUT_TOKENS: int = 1200
    DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS: int = 45
    DEEP_RESEARCH_RATE_LIMIT_PER_MINUTE: int = 8
    DEEP_RESEARCH_GROQ_TPM_BUDGET: int = 7600
    DEEP_RESEARCH_JUDGE_PROVIDER: str = "groq"
    DEEP_RESEARCH_JUDGE_MODEL: str | None = None

    TAVILY_API_KEY: str | None = None
    SERPER_API_KEY: str | None = None
    SEARCH_CACHE_TTL_SECONDS: int = 60 * 30
    SEARCH_MAX_RESULTS: int = 6
    SEARCH_DEEP_MAX_RESULTS: int = 10
    SEARCH_COUNTRY: str = "us"
    SEARCH_LANGUAGE: str = "en"

    UPLOAD_DIR: str = str(PROJECT_ROOT / "backend" / "uploads")
    APK_STORAGE_DIR: str = str(PROJECT_ROOT / "public" / "downloads")
    APK_FILENAME: str = "auto-ai.apk"
    APK_DEFAULT_VERSION: str = "1.0.8"
    APK_DEFAULT_VERSION_CODE: int = 9
    APK_MIN_ANDROID_VERSION: str = "Android 7.0"
    MAX_UPLOAD_MB: int = 20
    ALLOWED_DOCUMENT_EXTENSIONS: set[str] = {".pdf", ".txt", ".docx"}
    ALLOWED_IMAGE_EXTENSIONS: set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    ALLOWED_AUDIO_EXTENSIONS: set[str] = {".flac", ".mp3", ".m4a", ".mpeg", ".mpga", ".ogg", ".wav", ".webm"}

    RATE_LIMIT_PER_MINUTE: int = 90
    ADMIN_EMAIL: EmailStr | None = None
    ADMIN_PASSWORD: SecretStr | None = Field(default=None, min_length=8, max_length=128)
    ADMIN_NAME: str | None = Field(default=None, min_length=2, max_length=120)
    RAZORPAY_KEY_ID: str | None = None
    RAZORPAY_KEY_SECRET: SecretStr | None = None
    RAZORPAY_WEBHOOK_SECRET: SecretStr | None = None
    RAZORPAY_PRO_LINK: str | None = None
    RAZORPAY_PREMIUM_LINK: str | None = None
    RAZORPAY_ULTRA_LINK: str | None = None
    PROMO_CODES: str = ""

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> list[str] | Any:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("GROQ_RESEARCH_MODELS", "BEDROCK_RESEARCH_MODELS", "OPENAI_RESEARCH_MODELS", "GEMINI_RESEARCH_MODELS", mode="before")
    @classmethod
    def parse_model_list(cls, value: Any) -> list[str] | Any:
        if isinstance(value, str):
            return [model.strip() for model in value.split(",") if model.strip()]
        return value

    @property
    def sqlalchemy_database_url(self) -> str:
        configured_url = self.DATABASE_URL or self.MYSQL_URL
        if configured_url:
            return self._normalize_sqlalchemy_url(configured_url)

        backend = self.DB_BACKEND.strip().lower()
        if self.is_production and backend != "sqlite":
            raise RuntimeError(
                "Production database URL is missing. Set DATABASE_URL for PostgreSQL/MySQL "
                "or MYSQL_URL for Railway MySQL."
            )

        sqlite_path = self.resolved_sqlite_path
        if self.is_production and self.SQLITE_PATH.strip().replace("\\", "/") != "/data/auto_ai.db":
            raise RuntimeError(
                "Production SQLite requires a Railway volume at /data with "
                "SQLITE_PATH=/data/auto_ai.db, or set DATABASE_URL/MYSQL_URL."
            )
        if self.is_production and self._path_is_inside_project(sqlite_path):
            raise RuntimeError(
                "Unsafe production SQLite path. Mount a Railway volume at /data and set "
                "SQLITE_PATH=/data/auto_ai.db, or set DATABASE_URL/MYSQL_URL."
            )
        sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{sqlite_path.as_posix()}"

    @property
    def resolved_sqlite_path(self) -> Path:
        path = Path(self.SQLITE_PATH).expanduser()
        if not path.is_absolute():
            path = PROJECT_ROOT / path
        return path.resolve()

    @property
    def database_backend(self) -> str:
        configured_url = self.DATABASE_URL or self.MYSQL_URL
        if not configured_url:
            return "sqlite"
        scheme = urlsplit(configured_url).scheme.split("+", 1)[0].lower()
        if scheme == "postgres":
            return "postgresql"
        if scheme in {"mysql", "postgresql", "sqlite"}:
            return scheme
        return scheme or "unknown"

    @property
    def safe_database_target(self) -> str:
        configured_url = self.DATABASE_URL or self.MYSQL_URL
        if configured_url:
            parsed = urlsplit(configured_url)
            host = parsed.hostname or "unknown-host"
            port = f":{parsed.port}" if parsed.port else ""
            database = parsed.path or ""
            scheme = parsed.scheme.split("+", 1)[0] or "database"
            return f"{scheme}://{host}{port}{database}"

        sqlite_path = self.resolved_sqlite_path
        try:
            relative = sqlite_path.relative_to(PROJECT_ROOT)
            return f"<project>/{relative.as_posix()}"
        except ValueError:
            return sqlite_path.as_posix()

    @property
    def persistent_storage(self) -> bool:
        if self.DATABASE_URL or self.MYSQL_URL:
            return True
        sqlite_path_value = self.SQLITE_PATH.strip().replace("\\", "/")
        if self.is_production:
            return sqlite_path_value == "/data/auto_ai.db"
        return not self._path_is_inside_project(self.resolved_sqlite_path)

    @staticmethod
    def _normalize_sqlalchemy_url(raw_url: str) -> str:
        parsed = urlsplit(raw_url)
        scheme = parsed.scheme.lower()
        if scheme == "postgres":
            scheme = "postgresql+psycopg"
        elif scheme == "postgresql":
            scheme = "postgresql+psycopg"
        elif scheme == "mysql":
            scheme = "mysql+pymysql"
        return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))

    @staticmethod
    def _path_is_inside_project(path: Path) -> bool:
        try:
            path.relative_to(PROJECT_ROOT)
            return True
        except ValueError:
            return False

    @property
    def default_chat_model(self) -> str:
        return self.chat_model_for()

    @staticmethod
    def _project_env_value(name: str) -> str | None:
        for env_path in (PROJECT_ROOT / ".env.local", PROJECT_ROOT / ".env"):
            if not env_path.exists():
                continue
            for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() != name:
                    continue
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                    value = value[1:-1]
                return value or None
        return None

    @property
    def groq_api_key(self) -> str | None:
        return (
            self.AUTO_AI_GROQ_API_KEY
            or self._project_env_value("AUTO_AI_GROQ_API_KEY")
            or self._project_env_value("GROQ_API_KEY")
            or self.GROQ_API_KEY
        )

    @property
    def bedrock_api_key(self) -> str | None:
        return self._project_env_value("BEDROCK_API_KEY") or self.BEDROCK_API_KEY

    @property
    def bedrock_region(self) -> str:
        return self._project_env_value("BEDROCK_REGION") or self.BEDROCK_REGION

    @property
    def bedrock_model(self) -> str:
        return self._project_env_value("BEDROCK_MODEL") or self.BEDROCK_MODEL

    @property
    def bedrock_base_url(self) -> str | None:
        return self._project_env_value("BEDROCK_BASE_URL") or self.BEDROCK_BASE_URL

    @property
    def bedrock_auth_mode(self) -> str:
        return self._project_env_value("BEDROCK_AUTH_MODE") or self.BEDROCK_AUTH_MODE

    @property
    def bedrock_endpoint_mode(self) -> str:
        return self._project_env_value("BEDROCK_ENDPOINT_MODE") or self.BEDROCK_ENDPOINT_MODE

    @property
    def bedrock_mantle_base_url(self) -> str:
        return (
            self._project_env_value("BEDROCK_MANTLE_BASE_URL")
            or self.BEDROCK_MANTLE_BASE_URL
            or f"https://bedrock-mantle.{self.bedrock_region}.api.aws/v1"
        ).rstrip("/")

    @property
    def aws_access_key_id(self) -> str | None:
        return self._project_env_value("AWS_ACCESS_KEY_ID") or self.AWS_ACCESS_KEY_ID

    @property
    def aws_secret_access_key(self) -> str | None:
        return self._project_env_value("AWS_SECRET_ACCESS_KEY") or self.AWS_SECRET_ACCESS_KEY

    @property
    def aws_session_token(self) -> str | None:
        return self._project_env_value("AWS_SESSION_TOKEN") or self.AWS_SESSION_TOKEN

    def chat_model_for(self, provider: str | None = None) -> str:
        selected_provider = (provider or self.AI_PROVIDER).lower()
        if selected_provider == "openai":
            return self.OPENAI_MODEL
        if selected_provider == "gemini":
            return self.GEMINI_MODEL
        if selected_provider == "bedrock":
            return self.bedrock_model
        return self.GROQ_MODEL

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
