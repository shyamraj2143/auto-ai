from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.db.base import Base


database_url = settings.sqlalchemy_database_url
connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db() -> None:
    if database_url.startswith("sqlite:///"):
        sqlite_file = Path(database_url.replace("sqlite:///", "", 1))
        sqlite_file.parent.mkdir(parents=True, exist_ok=True)

    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    from app.services.admin_control import ensure_admin_defaults

    with SessionLocal() as db:
        ensure_admin_defaults(db)


def ensure_runtime_schema() -> None:
    """Apply tiny additive schema updates for local SQLite installs."""
    if not database_url.startswith("sqlite"):
        return

    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    statements: list[str] = []
    ensure_mobile_index = False
    if "documents" in table_names:
        document_columns = {column["name"] for column in inspector.get_columns("documents")}
        if "file_size" not in document_columns:
            statements.append("ALTER TABLE documents ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0")
        if "metadata" not in document_columns:
            statements.append("ALTER TABLE documents ADD COLUMN metadata JSON")

    if "users" in table_names:
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        if "mobile" not in user_columns:
            statements.append("ALTER TABLE users ADD COLUMN mobile VARCHAR(32)")
        if "role" not in user_columns:
            statements.append("ALTER TABLE users ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'")
        ensure_mobile_index = True

    if "user_subscriptions" in table_names:
        subscription_columns = {column["name"] for column in inspector.get_columns("user_subscriptions")}
        quota_columns = {
            "token_limit_monthly": "INTEGER NOT NULL DEFAULT 10000",
            "tokens_used_monthly": "INTEGER NOT NULL DEFAULT 0",
            "token_balance": "INTEGER NOT NULL DEFAULT 10000",
            "bonus_tokens": "INTEGER NOT NULL DEFAULT 0",
            "daily_message_limit": "INTEGER NOT NULL DEFAULT 25",
            "messages_used_today": "INTEGER NOT NULL DEFAULT 0",
            "plan_name": "VARCHAR(64) NOT NULL DEFAULT 'Free'",
            "quota_updated_by": "VARCHAR(36)",
            "quota_updated_at": "DATETIME",
            "token_usage_month": "VARCHAR(7) NOT NULL DEFAULT ''",
            "messages_used_date": "VARCHAR(10) NOT NULL DEFAULT ''",
        }
        for column_name, definition in quota_columns.items():
            if column_name not in subscription_columns:
                statements.append(f"ALTER TABLE user_subscriptions ADD COLUMN {column_name} {definition}")

    if "api_usage" in table_names:
        usage_columns = {column["name"] for column in inspector.get_columns("api_usage")}
        if "provider" not in usage_columns:
            statements.append("ALTER TABLE api_usage ADD COLUMN provider VARCHAR(32) NOT NULL DEFAULT 'unknown'")
        if "input_tokens" not in usage_columns:
            statements.append("ALTER TABLE api_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0")
        if "output_tokens" not in usage_columns:
            statements.append("ALTER TABLE api_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0")

    if "messages" in table_names:
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "metadata" not in message_columns:
            statements.append("ALTER TABLE messages ADD COLUMN metadata JSON")

    if "chat_generations" in table_names:
        generation_columns = {column["name"] for column in inspector.get_columns("chat_generations")}
        if "error" not in generation_columns:
            statements.append("ALTER TABLE chat_generations ADD COLUMN error TEXT")
        if "completed_at" not in generation_columns:
            statements.append("ALTER TABLE chat_generations ADD COLUMN completed_at DATETIME")

    if not statements and not ensure_mobile_index:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        if ensure_mobile_index:
            connection.execute(
                text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_mobile ON users (mobile) WHERE mobile IS NOT NULL")
            )
            connection.execute(text("CREATE INDEX IF NOT EXISTS ix_users_role ON users (role)"))
            connection.execute(text("UPDATE users SET role = 'user' WHERE role IS NULL OR TRIM(role) = ''"))
            connection.execute(text("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND role NOT IN ('admin', 'super_admin')"))
            connection.execute(text("UPDATE users SET is_admin = 1 WHERE role IN ('admin', 'super_admin') AND is_admin = 0"))
        if "user_subscriptions" in table_names:
            connection.execute(text("UPDATE user_subscriptions SET token_limit_monthly = 10000 WHERE token_limit_monthly IS NULL"))
            connection.execute(text("UPDATE user_subscriptions SET tokens_used_monthly = 0 WHERE tokens_used_monthly IS NULL OR tokens_used_monthly < 0"))
            connection.execute(text("UPDATE user_subscriptions SET bonus_tokens = 0 WHERE bonus_tokens IS NULL OR bonus_tokens < 0"))
            connection.execute(text("UPDATE user_subscriptions SET daily_message_limit = 25 WHERE daily_message_limit IS NULL"))
            connection.execute(text("UPDATE user_subscriptions SET messages_used_today = 0 WHERE messages_used_today IS NULL OR messages_used_today < 0"))
            connection.execute(
                text(
                    "UPDATE user_subscriptions SET plan_name = CASE plan "
                    "WHEN 'admin' THEN 'Admin' WHEN 'pro-plus' THEN 'Pro Plus' "
                    "WHEN 'pro' THEN 'Pro' ELSE 'Free' END "
                    "WHERE plan_name IS NULL OR TRIM(plan_name) = ''"
                )
            )
            connection.execute(
                text(
                    "UPDATE user_subscriptions SET token_balance = CASE "
                    "WHEN token_limit_monthly <= 0 THEN 0 "
                    "WHEN token_limit_monthly + bonus_tokens - tokens_used_monthly > 0 "
                    "THEN token_limit_monthly + bonus_tokens - tokens_used_monthly ELSE 0 END "
                    "WHERE token_balance IS NULL OR token_balance < 0"
                )
            )
        if "api_usage" in table_names:
            connection.execute(text("UPDATE api_usage SET input_tokens = prompt_tokens WHERE input_tokens = 0 AND prompt_tokens > 0"))
            connection.execute(text("UPDATE api_usage SET output_tokens = completion_tokens WHERE output_tokens = 0 AND completion_tokens > 0"))


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
