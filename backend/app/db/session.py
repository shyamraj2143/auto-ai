from pathlib import Path
import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.db.base import Base


database_url = settings.sqlalchemy_database_url
connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
logger = logging.getLogger("auto_ai.database")


def init_db() -> None:
    if database_url.startswith("sqlite:///"):
        sqlite_file = Path(database_url.replace("sqlite:///", "", 1))
        sqlite_file.parent.mkdir(parents=True, exist_ok=True)

    logger.info(
        "Database backend=%s target=%s",
        settings.database_backend,
        settings.safe_database_target,
    )

    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    from app.services.admin_control import ensure_admin_defaults

    with SessionLocal() as db:
        ensure_admin_defaults(db)


def ensure_runtime_schema() -> None:
    """Apply additive-only schema updates without dropping tables or deleting rows."""
    inspector = inspect(engine)
    dialect = engine.dialect.name
    quote = engine.dialect.identifier_preparer.quote
    table_names = set(inspector.get_table_names())
    statements: list[str] = []
    ensure_mobile_index = False
    migrate_legacy_apk_releases = "apk_versions" in table_names and "apk_releases" in table_names

    def column_definition(kind: str) -> str:
        if kind == "json":
            return "JSON"
        if kind == "datetime":
            return "TIMESTAMP" if dialect == "postgresql" else "DATETIME"
        return kind

    def add_column(table_name: str, column_name: str, definition: str) -> None:
        statements.append(
            f"ALTER TABLE {quote(table_name)} ADD COLUMN {quote(column_name)} {column_definition(definition)}"
        )

    def concat_url_version(column_sql: str) -> str:
        if dialect == "mysql":
            return f"CONCAT('/api/download/apk?version=', {column_sql})"
        return f"'/api/download/apk?version=' || {column_sql}"

    if "documents" in table_names:
        document_columns = {column["name"] for column in inspector.get_columns("documents")}
        if "file_size" not in document_columns:
            add_column("documents", "file_size", "INTEGER NOT NULL DEFAULT 0")
        if "metadata" not in document_columns:
            add_column("documents", "metadata", "json")

    if "users" in table_names:
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        if "mobile" not in user_columns:
            add_column("users", "mobile", "VARCHAR(32)")
        if "role" not in user_columns:
            add_column("users", "role", "VARCHAR(32) NOT NULL DEFAULT 'user'")
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
            "quota_updated_at": "datetime",
            "token_usage_month": "VARCHAR(7) NOT NULL DEFAULT ''",
            "messages_used_date": "VARCHAR(10) NOT NULL DEFAULT ''",
            "auto_renewal": "BOOLEAN NOT NULL DEFAULT FALSE",
            "is_lifetime": "BOOLEAN NOT NULL DEFAULT FALSE",
            "suspended_at": "datetime",
            "suspended_by": "VARCHAR(36)",
        }
        for column_name, definition in quota_columns.items():
            if column_name not in subscription_columns:
                add_column("user_subscriptions", column_name, definition)

    if "api_usage" in table_names:
        usage_columns = {column["name"] for column in inspector.get_columns("api_usage")}
        if "provider" not in usage_columns:
            add_column("api_usage", "provider", "VARCHAR(32) NOT NULL DEFAULT 'unknown'")
        if "input_tokens" not in usage_columns:
            add_column("api_usage", "input_tokens", "INTEGER NOT NULL DEFAULT 0")
        if "output_tokens" not in usage_columns:
            add_column("api_usage", "output_tokens", "INTEGER NOT NULL DEFAULT 0")

    if "messages" in table_names:
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "metadata" not in message_columns:
            add_column("messages", "metadata", "json")

    if "chat_generations" in table_names:
        generation_columns = {column["name"] for column in inspector.get_columns("chat_generations")}
        if "error" not in generation_columns:
            add_column("chat_generations", "error", "TEXT")
        if "completed_at" not in generation_columns:
            add_column("chat_generations", "completed_at", "datetime")

    if "apk_versions" in table_names:
        apk_columns = {column["name"] for column in inspector.get_columns("apk_versions")}
        apk_version_columns = {
            "version_code": "INTEGER NOT NULL DEFAULT 1",
            "version_name": "VARCHAR(40) NOT NULL DEFAULT '1.0.0'",
            "apk_url": "VARCHAR(500) NOT NULL DEFAULT '/api/download/apk'",
            "file_size": "INTEGER NOT NULL DEFAULT 0",
            "release_date": "datetime",
            "force_update": "BOOLEAN NOT NULL DEFAULT FALSE",
            "changelog": "TEXT NOT NULL DEFAULT ''",
            "download_count": "INTEGER NOT NULL DEFAULT 0",
            "filename": "VARCHAR(255) NOT NULL DEFAULT 'auto-ai.apk'",
            "file_path": "VARCHAR(500) NOT NULL DEFAULT ''",
            "sha256": "VARCHAR(64) NOT NULL DEFAULT ''",
            "min_android_version": "VARCHAR(40) NOT NULL DEFAULT 'Android 7.0'",
            "release_notes": "json",
            "is_active": "BOOLEAN NOT NULL DEFAULT TRUE",
            "created_at": "datetime",
        }
        for column_name, definition in apk_version_columns.items():
            if column_name not in apk_columns:
                add_column("apk_versions", column_name, definition)

    if not statements and not ensure_mobile_index and not migrate_legacy_apk_releases:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        if ensure_mobile_index and dialect in {"sqlite", "postgresql"}:
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_mobile ON {quote('users')} "
                    f"({quote('mobile')}) WHERE {quote('mobile')} IS NOT NULL"
                )
            )
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_users_role ON {quote('users')} ({quote('role')})"))
        if ensure_mobile_index:
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('role')} = 'user' WHERE {quote('role')} IS NULL OR TRIM({quote('role')}) = ''"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('role')} = 'admin' WHERE {quote('is_admin')} = TRUE AND {quote('role')} NOT IN ('admin', 'super_admin')"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('is_admin')} = TRUE WHERE {quote('role')} IN ('admin', 'super_admin') AND {quote('is_admin')} = FALSE"))
        if "user_subscriptions" in table_names:
            subscriptions = quote("user_subscriptions")
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('token_limit_monthly')} = 10000 WHERE {quote('token_limit_monthly')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('tokens_used_monthly')} = 0 WHERE {quote('tokens_used_monthly')} IS NULL OR {quote('tokens_used_monthly')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('bonus_tokens')} = 0 WHERE {quote('bonus_tokens')} IS NULL OR {quote('bonus_tokens')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('daily_message_limit')} = 25 WHERE {quote('daily_message_limit')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('messages_used_today')} = 0 WHERE {quote('messages_used_today')} IS NULL OR {quote('messages_used_today')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('auto_renewal')} = FALSE WHERE {quote('auto_renewal')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('is_lifetime')} = FALSE WHERE {quote('is_lifetime')} IS NULL"))
            connection.execute(
                text(
                    f"UPDATE {subscriptions} SET {quote('plan_name')} = CASE {quote('plan')} "
                    "WHEN 'admin' THEN 'Admin' WHEN 'ultra' THEN 'Ultra' "
                    "WHEN 'premium' THEN 'Premium' WHEN 'pro-plus' THEN 'Pro Plus' "
                    "WHEN 'pro' THEN 'Pro' ELSE 'Free' END "
                    f"WHERE {quote('plan_name')} IS NULL OR TRIM({quote('plan_name')}) = ''"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {subscriptions} SET {quote('token_balance')} = CASE "
                    f"WHEN {quote('token_limit_monthly')} <= 0 THEN 0 "
                    f"WHEN {quote('token_limit_monthly')} + {quote('bonus_tokens')} - {quote('tokens_used_monthly')} > 0 "
                    f"THEN {quote('token_limit_monthly')} + {quote('bonus_tokens')} - {quote('tokens_used_monthly')} ELSE 0 END "
                    f"WHERE {quote('token_balance')} IS NULL OR {quote('token_balance')} < 0"
                )
            )
        if "api_usage" in table_names:
            api_usage = quote("api_usage")
            connection.execute(text(f"UPDATE {api_usage} SET {quote('input_tokens')} = {quote('prompt_tokens')} WHERE {quote('input_tokens')} = 0 AND {quote('prompt_tokens')} > 0"))
            connection.execute(text(f"UPDATE {api_usage} SET {quote('output_tokens')} = {quote('completion_tokens')} WHERE {quote('output_tokens')} = 0 AND {quote('completion_tokens')} > 0"))
        if "apk_versions" in table_names:
            apk_versions = quote("apk_versions")
            connection.execute(text(f"UPDATE {apk_versions} SET {quote('release_date')} = {quote('created_at')} WHERE {quote('release_date')} IS NULL"))
            connection.execute(text(f"UPDATE {apk_versions} SET {quote('created_at')} = {quote('release_date')} WHERE {quote('created_at')} IS NULL"))
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('apk_url')} = {concat_url_version(quote('version_name'))} "
                    f"WHERE {quote('apk_url')} IS NULL OR TRIM({quote('apk_url')}) = ''"
                )
            )
            connection.execute(text(f"UPDATE {apk_versions} SET {quote('release_notes')} = '[]' WHERE {quote('release_notes')} IS NULL"))
        if migrate_legacy_apk_releases:
            connection.execute(
                text(
                    f"INSERT INTO {quote('apk_versions')} "
                    f"({quote('id')}, {quote('version_code')}, {quote('version_name')}, {quote('apk_url')}, {quote('file_size')}, "
                    f"{quote('release_date')}, {quote('force_update')}, {quote('changelog')}, {quote('download_count')}, "
                    f"{quote('filename')}, {quote('file_path')}, {quote('sha256')}, {quote('min_android_version')}, "
                    f"{quote('release_notes')}, {quote('is_active')}, {quote('created_at')}) "
                    f"SELECT {quote('id')}, {quote('version_code')}, {quote('version')}, {concat_url_version(quote('version'))}, "
                    f"{quote('file_size')}, {quote('created_at')}, FALSE, {quote('changelog')}, 0, {quote('filename')}, "
                    f"{quote('file_path')}, {quote('sha256')}, {quote('min_android_version')}, {quote('release_notes')}, "
                    f"{quote('is_active')}, {quote('created_at')} FROM {quote('apk_releases')} "
                    f"WHERE NOT EXISTS (SELECT 1 FROM {quote('apk_versions')})"
                )
            )


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
