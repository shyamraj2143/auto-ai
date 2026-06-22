from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import AnyHttpUrl, Field, field_validator
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
        "http://autoai.site.je",
        "https://autoai.site.je",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]



    DATABASE_URL: str | None = None
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

    UPLOAD_DIR: str = str(PROJECT_ROOT / "backend" / "uploads")
    MAX_UPLOAD_MB: int = 20
    ALLOWED_DOCUMENT_EXTENSIONS: set[str] = {".pdf", ".txt", ".docx"}
    ALLOWED_IMAGE_EXTENSIONS: set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    ALLOWED_AUDIO_EXTENSIONS: set[str] = {".flac", ".mp3", ".m4a", ".mpeg", ".mpga", ".ogg", ".wav", ".webm"}

    RATE_LIMIT_PER_MINUTE: int = 90
    ADMIN_EMAILS: set[str] = set()

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> list[str] | Any:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("ADMIN_EMAILS", mode="before")
    @classmethod
    def parse_admin_emails(cls, value: Any) -> set[str] | Any:
        if isinstance(value, str):
            return {email.strip().lower() for email in value.split(",") if email.strip()}
        return value

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL
        sqlite_path = Path(self.SQLITE_PATH)
        sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{sqlite_path.as_posix()}"

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
