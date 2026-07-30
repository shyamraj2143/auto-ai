from pathlib import Path
import logging
import re
import uuid

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
        "database_backend=%s database_path_or_host=%s persistent_storage=%s",
        settings.database_backend,
        settings.safe_database_target,
        str(settings.persistent_storage).lower(),
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
    backfill_payment_records = "payment_records" in table_names
    backfill_subscriptions = "user_subscriptions" in table_names
    backfill_apk_versions = "apk_versions" in table_names
    backfill_chat_storage = {"chats", "messages", "chat_sessions", "chat_messages"}.issubset(table_names)
    backfill_social_relationships = "social_follows" in table_names
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

    if "content_pages" in table_names:
        cms_page_columns = {column["name"] for column in inspector.get_columns("content_pages")}
        if "published_slug" not in cms_page_columns:
            add_column("content_pages", "published_slug", "VARCHAR(160)")
        if "element_overrides" not in cms_page_columns:
            add_column("content_pages", "element_overrides", "json")

    if "announcements" in table_names:
        announcement_columns = {column["name"] for column in inspector.get_columns("announcements")}
        if "published_snapshot" not in announcement_columns:
            add_column("announcements", "published_snapshot", "json")

    if "demo_chat_sessions" in table_names:
        demo_columns = {column["name"] for column in inspector.get_columns("demo_chat_sessions")}
        if "history" not in demo_columns:
            add_column("demo_chat_sessions", "history", "json")

    if "users" in table_names:
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        user_indexes = {index["name"] for index in inspector.get_indexes("users")}
        if "mobile" not in user_columns:
            add_column("users", "mobile", "VARCHAR(32)")
        if "username" not in user_columns:
            add_column("users", "username", "VARCHAR(48)")
        if "phone_number" not in user_columns:
            add_column("users", "phone_number", "VARCHAR(32)")
        if "phone_country_code" not in user_columns:
            add_column("users", "phone_country_code", "VARCHAR(8)")
        if "phone_verified" not in user_columns:
            add_column("users", "phone_verified", "BOOLEAN NOT NULL DEFAULT FALSE")
        if "phone_verified_at" not in user_columns:
            add_column("users", "phone_verified_at", "datetime")
        if "picture" not in user_columns:
            add_column("users", "picture", "VARCHAR(500)")
        if "avatar" not in user_columns:
            add_column("users", "avatar", "VARCHAR(500)")
        if "bio" not in user_columns:
            add_column("users", "bio", "TEXT")
        if "profile_visibility" not in user_columns:
            add_column("users", "profile_visibility", "VARCHAR(16) NOT NULL DEFAULT 'public'")
        if "message_permission" not in user_columns:
            add_column("users", "message_permission", "VARCHAR(32) NOT NULL DEFAULT 'everyone'")
        if "provider" not in user_columns:
            add_column("users", "provider", "VARCHAR(32) NOT NULL DEFAULT 'email'")
        if "google_id" not in user_columns:
            add_column("users", "google_id", "VARCHAR(255)")
        if "role" not in user_columns:
            add_column("users", "role", "VARCHAR(32) NOT NULL DEFAULT 'user'")
        if "subscription_status" not in user_columns:
            add_column("users", "subscription_status", "VARCHAR(32) NOT NULL DEFAULT 'free'")
        if "intelligence_mode" not in user_columns:
            add_column("users", "intelligence_mode", "VARCHAR(32) NOT NULL DEFAULT 'instant'")
        if "memory_enabled" not in user_columns:
            add_column("users", "memory_enabled", "BOOLEAN NOT NULL DEFAULT TRUE")
        if "feedback_learning_enabled" not in user_columns:
            add_column("users", "feedback_learning_enabled", "BOOLEAN NOT NULL DEFAULT TRUE")
        if "created_at" not in user_columns:
            add_column("users", "created_at", "datetime")
        if "updated_at" not in user_columns:
            add_column("users", "updated_at", "datetime")
        if "profile_updated_at" not in user_columns:
            add_column("users", "profile_updated_at", "datetime")
        ensure_mobile_index = True

    if "user_subscriptions" in table_names:
        subscription_columns = {column["name"] for column in inspector.get_columns("user_subscriptions")}
        quota_columns = {
            "plan_id": "VARCHAR(32) NOT NULL DEFAULT 'free'",
            "status": "VARCHAR(32) NOT NULL DEFAULT 'free'",
            "token_limit_monthly": "INTEGER NOT NULL DEFAULT 10000",
            "tokens_added": "INTEGER NOT NULL DEFAULT 10000",
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
            "started_at": "datetime",
        }
        for column_name, definition in quota_columns.items():
            if column_name not in subscription_columns:
                add_column("user_subscriptions", column_name, definition)

    if "plan_limits" in table_names:
        plan_limit_columns = {column["name"] for column in inspector.get_columns("plan_limits")}
        if "price_paise" not in plan_limit_columns:
            add_column("plan_limits", "price_paise", "INTEGER NOT NULL DEFAULT 0")

    if "user_devices" in table_names:
        device_columns = {column["name"] for column in inspector.get_columns("user_devices")}
        if "fcm_token_ciphertext" not in device_columns:
            add_column("user_devices", "fcm_token_ciphertext", "TEXT")
        if "fcm_token_hash" not in device_columns:
            add_column("user_devices", "fcm_token_hash", "VARCHAR(64)")
        if "app_version_code" not in device_columns:
            add_column("user_devices", "app_version_code", "INTEGER NOT NULL DEFAULT 0")
        if "device_name" not in device_columns:
            add_column("user_devices", "device_name", "VARCHAR(120)")
        if "os_version" not in device_columns:
            add_column("user_devices", "os_version", "VARCHAR(80)")
        extra_device_columns = {
            "legacy_device_id": "VARCHAR(128)",
            "manufacturer": "VARCHAR(80)",
            "model": "VARCHAR(80)",
            "android_sdk": "INTEGER",
            "last_fcm_send_result": "VARCHAR(40)",
            "last_fcm_failure_code": "VARCHAR(64)",
            "last_fcm_received_at": "datetime",
            "last_notification_displayed_at": "datetime",
            "firebase_installation_id_ciphertext": "TEXT",
            "firebase_installation_id_hash": "VARCHAR(64)",
            "installation_rotation_status": "VARCHAR(48)",
            "push_provider": "VARCHAR(32) NOT NULL DEFAULT 'fcm'",
            "battery_level": "INTEGER",
            "charging": "BOOLEAN",
            "network_type": "VARCHAR(80)",
            "screen_status": "VARCHAR(16)",
            "storage_used": "VARCHAR(80)",
            "storage_total": "VARCHAR(80)",
            "ram_used": "VARCHAR(80)",
            "ram_total": "VARCHAR(80)",
            "permissions_status": "TEXT",
            "status": "VARCHAR(16) NOT NULL DEFAULT 'offline'",
        }
        for column_name, definition in extra_device_columns.items():
            if column_name not in device_columns:
                add_column("user_devices", column_name, definition)

    if "calls" in table_names:
        call_columns = {column["name"] for column in inspector.get_columns("calls")}
        if "revision" not in call_columns:
            add_column("calls", "revision", "INTEGER NOT NULL DEFAULT 1")
        if "trace_id" not in call_columns:
            add_column("calls", "trace_id", "VARCHAR(36) NOT NULL DEFAULT ''")
        if "failure_code" not in call_columns:
            add_column("calls", "failure_code", "VARCHAR(32)")

    if "call_deliveries" in table_names:
        delivery_columns = {column["name"] for column in inspector.get_columns("call_deliveries")}
        delivery_diagnostics = {
            "original_priority": "VARCHAR(40)",
            "delivered_priority": "VARCHAR(40)",
            "firebase_service_started_at": "datetime",
            "ringtone_started_at": "datetime",
        }
        for column_name, definition in delivery_diagnostics.items():
            if column_name not in delivery_columns:
                add_column("call_deliveries", column_name, definition)

    if "user_device_activities" in table_names:
        activity_columns = {column["name"] for column in inspector.get_columns("user_device_activities")}
        activity_device_columns = {
            "device_id": "VARCHAR(128)",
            "device_type": "VARCHAR(16) NOT NULL DEFAULT 'mobile'",
            "storage_total": "VARCHAR(80)",
            "storage_used": "VARCHAR(80)",
            "ram_total": "VARCHAR(80)",
            "ram_used": "VARCHAR(80)",
            "foreground_app_name": "VARCHAR(255)",
            "foreground_package_name": "VARCHAR(255)",
            "activity_type": "VARCHAR(64)",
            "source": "VARCHAR(32) NOT NULL DEFAULT 'app_internal'",
            "permission_granted": "BOOLEAN NOT NULL DEFAULT FALSE",
        }
        for column_name, definition in activity_device_columns.items():
            if column_name not in activity_columns:
                add_column("user_device_activities", column_name, definition)

    if "payment_records" in table_names:
        payment_columns = {column["name"] for column in inspector.get_columns("payment_records")}
        payment_indexes = {index["name"] for index in inspector.get_indexes("payment_records")}
        payment_record_columns = {
            "user_email": "VARCHAR(255)",
            "plan_id": "VARCHAR(32) NOT NULL DEFAULT 'free'",
            "amount": "INTEGER NOT NULL DEFAULT 0",
            "razorpay_order_id": "VARCHAR(120)",
            "razorpay_payment_id": "VARCHAR(120)",
            "razorpay_signature": "VARCHAR(255)",
            "paid_at": "datetime",
            "verified_at": "datetime",
            "receipt_number": "VARCHAR(64)",
            "original_amount_paise": "INTEGER",
            "discount_amount_paise": "INTEGER NOT NULL DEFAULT 0",
            "promo_code_id": "VARCHAR(36)",
            "promo_code_snapshot": "VARCHAR(40)",
            "plan_name_snapshot": "VARCHAR(80)",
            "billing_period_snapshot": "VARCHAR(40)",
            "updated_at": "datetime",
        }
        for column_name, definition in payment_record_columns.items():
            if column_name not in payment_columns:
                add_column("payment_records", column_name, definition)
        if "ix_payment_records_receipt_number" not in payment_indexes:
            statements.append(
                f"CREATE UNIQUE INDEX {quote('ix_payment_records_receipt_number')} ON "
                f"{quote('payment_records')} ({quote('receipt_number')})"
            )
        if "ix_payment_records_status_created" not in payment_indexes:
            statements.append(
                f"CREATE INDEX {quote('ix_payment_records_status_created')} ON "
                f"{quote('payment_records')} ({quote('status')}, {quote('created_at')})"
            )

    if "promo_codes" in table_names:
        promo_columns = {column["name"] for column in inspector.get_columns("promo_codes")}
        if "reserved_count" not in promo_columns:
            add_column("promo_codes", "reserved_count", "INTEGER NOT NULL DEFAULT 0")

    if "promo_redemptions" in table_names:
        redemption_columns = {column["name"] for column in inspector.get_columns("promo_redemptions")}
        redemption_indexes = {index["name"] for index in inspector.get_indexes("promo_redemptions")}
        if "usage_slot" not in redemption_columns:
            add_column("promo_redemptions", "usage_slot", "INTEGER")
        if "uq_promo_redemptions_user_slot" not in redemption_indexes:
            statements.append(
                f"CREATE UNIQUE INDEX {quote('uq_promo_redemptions_user_slot')} ON {quote('promo_redemptions')} "
                f"({quote('promo_code_id')}, {quote('user_id')}, {quote('usage_slot')})"
            )
    if "api_usage" in table_names:
        usage_columns = {column["name"] for column in inspector.get_columns("api_usage")}
        if "provider" not in usage_columns:
            add_column("api_usage", "provider", "VARCHAR(32) NOT NULL DEFAULT 'unknown'")
        if "input_tokens" not in usage_columns:
            add_column("api_usage", "input_tokens", "INTEGER NOT NULL DEFAULT 0")
        if "output_tokens" not in usage_columns:
            add_column("api_usage", "output_tokens", "INTEGER NOT NULL DEFAULT 0")

    if "chats" in table_names:
        chat_columns = {column["name"] for column in inspector.get_columns("chats")}
        if "mode" not in chat_columns:
            add_column("chats", "mode", "VARCHAR(32) NOT NULL DEFAULT 'normal'")

    if "screen_share_sessions" in table_names:
        screen_share_columns = {column["name"] for column in inspector.get_columns("screen_share_sessions")}
        if "screenCodeHash" not in screen_share_columns:
            add_column("screen_share_sessions", "screenCodeHash", "VARCHAR(64)")
        if "sharerGuestId" not in screen_share_columns:
            add_column("screen_share_sessions", "sharerGuestId", "VARCHAR(36)")
        if "viewerGuestId" not in screen_share_columns:
            add_column("screen_share_sessions", "viewerGuestId", "VARCHAR(36)")

    if "messages" in table_names:
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "metadata" not in message_columns:
            add_column("messages", "metadata", "json")
        if "user_id" not in message_columns:
            add_column("messages", "user_id", "VARCHAR(36)")
        if "model" not in message_columns:
            add_column("messages", "model", "VARCHAR(120)")

    if "social_follows" in table_names:
        social_columns = {column["name"] for column in inspector.get_columns("social_follows")}
        social_columns_to_add = {
            "pair_key": "VARCHAR(73)",
            "responder_user_id": "VARCHAR(36)",
            "cancelled_at": "datetime",
            "disconnected_at": "datetime",
            "rejection_reason_category": "VARCHAR(32)",
        }
        for column_name, definition in social_columns_to_add.items():
            if column_name not in social_columns:
                add_column("social_follows", column_name, definition)

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
            "file_name": "VARCHAR(255) NOT NULL DEFAULT 'auto-ai.apk'",
            "file_size": "INTEGER NOT NULL DEFAULT 0",
            "release_date": "datetime",
            "force_update": "BOOLEAN NOT NULL DEFAULT FALSE",
            "changelog": "TEXT NOT NULL DEFAULT ''",
            "download_count": "INTEGER NOT NULL DEFAULT 0",
            "filename": "VARCHAR(255) NOT NULL DEFAULT 'auto-ai.apk'",
            "file_path": "VARCHAR(500) NOT NULL DEFAULT ''",
            "sha256": "VARCHAR(64) NOT NULL DEFAULT ''",
            "min_android_version": "VARCHAR(40) NOT NULL DEFAULT 'Android 7.0'",
            "minimum_android_sdk": "INTEGER NOT NULL DEFAULT 24",
            "minimum_supported_version_code": "INTEGER NOT NULL DEFAULT 1",
            "package_name": "VARCHAR(120) NOT NULL DEFAULT 'com.autoai.app'",
            "release_notes": "json",
            "is_active": "BOOLEAN NOT NULL DEFAULT TRUE",
            "created_at": "datetime",
            "updated_at": "datetime",
            "released_at": "datetime",
        }
        for column_name, definition in apk_version_columns.items():
            if column_name not in apk_columns:
                add_column("apk_versions", column_name, definition)

    if (
        not statements
        and not ensure_mobile_index
        and not backfill_payment_records
        and not backfill_subscriptions
        and not backfill_apk_versions
        and not migrate_legacy_apk_releases
        and not backfill_chat_storage
        and not backfill_social_relationships
    ):
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        if "calls" in table_names and any("trace_id" in statement for statement in statements):
            call_rows = connection.execute(text(f"SELECT {quote('id')} FROM {quote('calls')}"))
            for row in call_rows:
                connection.execute(
                    text(f"UPDATE {quote('calls')} SET {quote('trace_id')} = :trace_id WHERE {quote('id')} = :call_id"),
                    {"trace_id": str(uuid.uuid4()), "call_id": row[0]},
                )
        if ensure_mobile_index and dialect in {"sqlite", "postgresql"}:
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_mobile ON {quote('users')} "
                    f"({quote('mobile')}) WHERE {quote('mobile')} IS NOT NULL"
                )
            )
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON {quote('users')} "
                    f"({quote('username')}) WHERE {quote('username')} IS NOT NULL"
                )
            )
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username_lower ON {quote('users')} "
                    f"(LOWER({quote('username')})) WHERE {quote('username')} IS NOT NULL"
                )
            )
            connection.execute(
                text(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_id ON {quote('users')} "
                    f"({quote('google_id')}) WHERE {quote('google_id')} IS NOT NULL"
                )
            )
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_users_role ON {quote('users')} ({quote('role')})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_users_provider ON {quote('users')} ({quote('provider')})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_users_subscription_status ON {quote('users')} ({quote('subscription_status')})"))
        if "user_devices" in table_names and dialect in {"sqlite", "postgresql"}:
            connection.execute(
                text(
                    f"CREATE INDEX IF NOT EXISTS ix_user_devices_fcm_token_hash ON {quote('user_devices')} "
                    f"({quote('fcm_token_hash')}) WHERE {quote('fcm_token_hash')} IS NOT NULL"
                )
            )
        if "user_device_activities" in table_names and dialect in {"sqlite", "postgresql"}:
            activities = quote("user_device_activities")
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_user_device_activities_device_id ON {activities} ({quote('device_id')})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_user_device_activities_device_type ON {activities} ({quote('device_type')})"))
            connection.execute(
                text(
                    f"UPDATE {activities} SET {quote('device_id')} = 'mobile-' || {quote('user_id')} "
                    f"WHERE {quote('device_id')} IS NULL OR TRIM({quote('device_id')}) = ''"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {activities} SET {quote('device_type')} = 'mobile' "
                    f"WHERE {quote('device_type')} IS NULL OR TRIM({quote('device_type')}) = ''"
                )
            )
        if ensure_mobile_index and dialect == "mysql":
            if "ix_users_username" not in user_indexes:
                connection.execute(text(f"CREATE UNIQUE INDEX ix_users_username ON {quote('users')} ({quote('username')})"))
            if "ix_users_google_id" not in user_indexes:
                connection.execute(text(f"CREATE UNIQUE INDEX ix_users_google_id ON {quote('users')} ({quote('google_id')})"))
            if "ix_users_provider" not in user_indexes:
                connection.execute(text(f"CREATE INDEX ix_users_provider ON {quote('users')} ({quote('provider')})"))
            if "ix_users_subscription_status" not in user_indexes:
                connection.execute(text(f"CREATE INDEX ix_users_subscription_status ON {quote('users')} ({quote('subscription_status')})"))
        if ensure_mobile_index:
            rows = connection.execute(
                text(f"SELECT {quote('id')}, {quote('name')}, {quote('username')} FROM {quote('users')}")
            ).mappings()
            assigned: set[str] = set()
            pending: list[tuple[str, str]] = []
            for row in rows:
                current = str(row["username"] or "").strip().lower()
                if current:
                    assigned.add(current)
                    continue
                base = re.sub(r"[^a-z0-9]+", "_", str(row["name"] or "user").lower()).strip("_")[:30] or "user"
                suffix = re.sub(r"[^a-z0-9]", "", str(row["id"]).lower())[:8] or "account"
                candidate = f"{base}_{suffix}"[:48]
                counter = 2
                while candidate in assigned:
                    tail = f"_{counter}"
                    candidate = f"{base[:48 - len(tail)]}{tail}"
                    counter += 1
                assigned.add(candidate)
                pending.append((str(row["id"]), candidate))
            for user_id, username in pending:
                connection.execute(
                    text(f"UPDATE {quote('users')} SET {quote('username')} = :username WHERE {quote('id')} = :user_id"),
                    {"username": username, "user_id": user_id},
                )
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('provider')} = 'email' WHERE {quote('provider')} IS NULL OR TRIM({quote('provider')}) = ''"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('profile_visibility')} = 'public' WHERE {quote('profile_visibility')} IS NULL OR TRIM({quote('profile_visibility')}) = ''"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('message_permission')} = 'everyone' WHERE {quote('message_permission')} IS NULL OR TRIM({quote('message_permission')}) = ''"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('subscription_status')} = 'free' WHERE {quote('subscription_status')} IS NULL OR TRIM({quote('subscription_status')}) = ''"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('role')} = 'user' WHERE {quote('role')} IS NULL OR TRIM({quote('role')}) = ''"))
            connection.execute(
                text(
                    f"UPDATE {quote('users')} SET {quote('email')} = 'screen-share-guest@autoai.site.je' "
                    f"WHERE {quote('email')} = 'screen-share-guest@internal.invalid'"
                )
            )
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('role')} = 'admin' WHERE {quote('is_admin')} = TRUE AND {quote('role')} NOT IN ('admin', 'super_admin', 'content_admin', 'content_editor', 'content_viewer')"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('is_admin')} = TRUE WHERE {quote('role')} IN ('admin', 'super_admin', 'content_admin', 'content_editor', 'content_viewer') AND {quote('is_admin')} = FALSE"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('created_at')} = CURRENT_TIMESTAMP WHERE {quote('created_at')} IS NULL"))
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('updated_at')} = {quote('created_at')} WHERE {quote('updated_at')} IS NULL"))
            if "phone_number" in user_columns or any("phone_number" in statement for statement in statements):
                connection.execute(text(f"UPDATE {quote('users')} SET {quote('phone_number')} = {quote('mobile')} WHERE ({quote('phone_number')} IS NULL OR TRIM({quote('phone_number')}) = '') AND {quote('mobile')} IS NOT NULL"))
            if "profile_updated_at" in user_columns or any("profile_updated_at" in statement for statement in statements):
                connection.execute(text(f"UPDATE {quote('users')} SET {quote('profile_updated_at')} = {quote('updated_at')} WHERE {quote('profile_updated_at')} IS NULL"))
        if "user_subscriptions" in table_names:
            subscriptions = quote("user_subscriptions")
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('plan_id')} = {quote('plan')} WHERE {quote('plan_id')} IS NULL OR TRIM({quote('plan_id')}) = ''"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('status')} = CASE WHEN {quote('suspended_at')} IS NOT NULL THEN 'suspended' WHEN {quote('is_active')} = TRUE THEN 'active' ELSE COALESCE(NULLIF(TRIM({quote('payment_status')}), ''), 'free') END WHERE {quote('status')} IS NULL OR TRIM({quote('status')}) = ''"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('token_limit_monthly')} = 10000 WHERE {quote('token_limit_monthly')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('tokens_added')} = {quote('token_limit_monthly')} WHERE {quote('tokens_added')} IS NULL OR {quote('tokens_added')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('tokens_used_monthly')} = 0 WHERE {quote('tokens_used_monthly')} IS NULL OR {quote('tokens_used_monthly')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('bonus_tokens')} = 0 WHERE {quote('bonus_tokens')} IS NULL OR {quote('bonus_tokens')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('daily_message_limit')} = 25 WHERE {quote('daily_message_limit')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('messages_used_today')} = 0 WHERE {quote('messages_used_today')} IS NULL OR {quote('messages_used_today')} < 0"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('auto_renewal')} = FALSE WHERE {quote('auto_renewal')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('is_lifetime')} = FALSE WHERE {quote('is_lifetime')} IS NULL"))
            connection.execute(text(f"UPDATE {subscriptions} SET {quote('started_at')} = {quote('created_at')} WHERE {quote('started_at')} IS NULL"))
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
        if "payment_records" in table_names:
            payment_records = quote("payment_records")
            connection.execute(text(f"UPDATE {payment_records} SET {quote('plan_id')} = {quote('plan')} WHERE {quote('plan_id')} IS NULL OR TRIM({quote('plan_id')}) = ''"))
            connection.execute(text(f"UPDATE {payment_records} SET {quote('amount')} = {quote('amount_cents')} WHERE {quote('amount')} IS NULL OR {quote('amount')} <= 0"))
            connection.execute(text(f"UPDATE {payment_records} SET {quote('razorpay_order_id')} = {quote('subscription_id')} WHERE ({quote('razorpay_order_id')} IS NULL OR TRIM({quote('razorpay_order_id')}) = '') AND {quote('provider')} = 'razorpay'"))
            connection.execute(text(f"UPDATE {payment_records} SET {quote('razorpay_payment_id')} = {quote('payment_id')} WHERE ({quote('razorpay_payment_id')} IS NULL OR TRIM({quote('razorpay_payment_id')}) = '') AND {quote('provider')} = 'razorpay'"))
            connection.execute(text(f"UPDATE {payment_records} SET {quote('paid_at')} = {quote('created_at')} WHERE {quote('paid_at')} IS NULL AND {quote('status')} IN ('paid', 'verified', 'captured', 'succeeded')"))
            if "verified_at" in payment_columns or any("verified_at" in statement for statement in statements):
                connection.execute(text(f"UPDATE {payment_records} SET {quote('verified_at')} = {quote('paid_at')} WHERE {quote('verified_at')} IS NULL AND {quote('status')} IN ('paid', 'verified', 'captured', 'succeeded')"))
            connection.execute(text(f"UPDATE {payment_records} SET {quote('updated_at')} = {quote('created_at')} WHERE {quote('updated_at')} IS NULL"))
        if "api_usage" in table_names:
            api_usage = quote("api_usage")
            connection.execute(text(f"UPDATE {api_usage} SET {quote('input_tokens')} = {quote('prompt_tokens')} WHERE {quote('input_tokens')} = 0 AND {quote('prompt_tokens')} > 0"))
            connection.execute(text(f"UPDATE {api_usage} SET {quote('output_tokens')} = {quote('completion_tokens')} WHERE {quote('output_tokens')} = 0 AND {quote('completion_tokens')} > 0"))
        if "messages" in table_names and "chats" in table_names:
            messages = quote("messages")
            chats = quote("chats")
            connection.execute(
                text(
                    f"UPDATE {messages} SET {quote('user_id')} = "
                    f"(SELECT {chats}.{quote('user_id')} FROM {chats} WHERE {chats}.{quote('id')} = {messages}.{quote('chat_id')}) "
                    f"WHERE {quote('user_id')} IS NULL"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {messages} SET {quote('model')} = "
                    f"(SELECT {chats}.{quote('model')} FROM {chats} WHERE {chats}.{quote('id')} = {messages}.{quote('chat_id')}) "
                    f"WHERE {quote('model')} IS NULL"
                )
            )
        if backfill_chat_storage:
            from app.services.chat_storage import backfill_chat_storage_tables

            backfill_chat_storage_tables(connection, quote)
        if "social_follows" in table_names:
            social_follows = quote("social_follows")
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_social_follows_pair_key ON {social_follows} ({quote('pair_key')})"))
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_social_follows_status_created ON {social_follows} ({quote('status')}, {quote('requested_at')})"))
            rows = connection.execute(
                text(
                    f"SELECT {quote('id')}, {quote('follower_id')}, {quote('following_id')} "
                    f"FROM {social_follows} WHERE {quote('pair_key')} IS NULL OR TRIM({quote('pair_key')}) = ''"
                )
            ).mappings()
            for row in rows:
                key = ":".join(sorted([str(row["follower_id"]), str(row["following_id"])]))
                connection.execute(
                    text(f"UPDATE {social_follows} SET {quote('pair_key')} = :pair_key WHERE {quote('id')} = :row_id"),
                    {"pair_key": key, "row_id": str(row["id"])},
                )
            if {"chat_participants", "chat_threads", "user_chat_messages"}.issubset(table_names):
                message_threads = [
                    str(row["thread_id"])
                    for row in connection.execute(
                        text(f"SELECT DISTINCT {quote('thread_id')} FROM {quote('user_chat_messages')}")
                    ).mappings()
                ]
                for thread_id in message_threads:
                    participants = [
                        str(row["user_id"])
                        for row in connection.execute(
                            text(
                                f"SELECT {quote('user_id')} FROM {quote('chat_participants')} "
                                f"WHERE {quote('thread_id')} = :thread_id ORDER BY {quote('user_id')} ASC"
                            ),
                            {"thread_id": thread_id},
                        ).mappings()
                    ]
                    if len(participants) != 2:
                        continue
                    first_id, second_id = participants
                    key = ":".join([first_id, second_id])
                    existing = connection.execute(
                        text(
                            f"SELECT {quote('id')} FROM {social_follows} "
                            f"WHERE ({quote('pair_key')} = :pair_key OR "
                            f"(({quote('follower_id')} = :first_id AND {quote('following_id')} = :second_id) OR "
                            f"({quote('follower_id')} = :second_id AND {quote('following_id')} = :first_id))) "
                            f"AND {quote('status')} IN ('pending', 'accepted') LIMIT 1"
                        ),
                        {"pair_key": key, "first_id": first_id, "second_id": second_id},
                    ).first()
                    if existing:
                        continue
                    connection.execute(
                        text(
                            f"INSERT INTO {social_follows} "
                            f"({quote('id')}, {quote('follower_id')}, {quote('following_id')}, {quote('pair_key')}, "
                            f"{quote('status')}, {quote('requested_at')}, {quote('responded_at')}, {quote('responder_user_id')}, "
                            f"{quote('created_at')}, {quote('updated_at')}) "
                            "VALUES (:id, :first_id, :second_id, :pair_key, 'accepted', CURRENT_TIMESTAMP, "
                            ":responded_at, :responder_user_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                        ),
                        {
                            "id": str(uuid.uuid4()),
                            "first_id": first_id,
                            "second_id": second_id,
                            "pair_key": key,
                            "responded_at": None,
                            "responder_user_id": None,
                        },
                    )
        if "apk_versions" in table_names:
            apk_versions = quote("apk_versions")
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('release_date')} = "
                    f"COALESCE({quote('release_date')}, {quote('released_at')}, {quote('created_at')}, CURRENT_TIMESTAMP) "
                    f"WHERE {quote('release_date')} IS NULL"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('created_at')} = "
                    f"COALESCE({quote('created_at')}, {quote('release_date')}, {quote('released_at')}, CURRENT_TIMESTAMP) "
                    f"WHERE {quote('created_at')} IS NULL"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('file_name')} = {quote('filename')} "
                    f"WHERE ({quote('file_name')} IS NULL OR TRIM({quote('file_name')}) = '') "
                    f"AND {quote('filename')} IS NOT NULL AND TRIM({quote('filename')}) != ''"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('filename')} = {quote('file_name')} "
                    f"WHERE ({quote('filename')} IS NULL OR TRIM({quote('filename')}) = '') "
                    f"AND {quote('file_name')} IS NOT NULL AND TRIM({quote('file_name')}) != ''"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('released_at')} = "
                    f"COALESCE({quote('released_at')}, {quote('release_date')}, {quote('created_at')}, CURRENT_TIMESTAMP) "
                    f"WHERE {quote('released_at')} IS NULL"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('release_date')} = "
                    f"COALESCE({quote('release_date')}, {quote('released_at')}, {quote('created_at')}, CURRENT_TIMESTAMP) "
                    f"WHERE {quote('release_date')} IS NULL"
                )
            )
            connection.execute(
                text(
                    f"UPDATE {apk_versions} SET {quote('updated_at')} = "
                    f"COALESCE({quote('updated_at')}, {quote('created_at')}, {quote('released_at')}, CURRENT_TIMESTAMP) "
                    f"WHERE {quote('updated_at')} IS NULL"
                )
            )
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
                    f"{quote('file_name')}, {quote('filename')}, {quote('file_path')}, {quote('sha256')}, {quote('min_android_version')}, "
                    f"{quote('release_notes')}, {quote('is_active')}, {quote('created_at')}, {quote('updated_at')}, {quote('released_at')}) "
                    f"SELECT {quote('id')}, {quote('version_code')}, {quote('version')}, {concat_url_version(quote('version'))}, "
                    f"{quote('file_size')}, {quote('created_at')}, FALSE, {quote('changelog')}, 0, {quote('filename')}, {quote('filename')}, "
                    f"{quote('file_path')}, {quote('sha256')}, {quote('min_android_version')}, {quote('release_notes')}, "
                    f"{quote('is_active')}, {quote('created_at')}, {quote('created_at')}, {quote('created_at')} FROM {quote('apk_releases')} "
                    f"WHERE NOT EXISTS (SELECT 1 FROM {quote('apk_versions')})"
                )
            )


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
