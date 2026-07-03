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

    if "messages" in table_names:
        message_columns = {column["name"] for column in inspector.get_columns("messages")}
        if "metadata" not in message_columns:
            statements.append("ALTER TABLE messages ADD COLUMN metadata JSON")

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
            connection.execute(text("UPDATE users SET role = 'admin' WHERE is_admin = 1"))
            connection.execute(text("UPDATE users SET is_admin = 1 WHERE role = 'admin' AND is_admin = 0"))
            for admin_email in settings.ADMIN_EMAILS:
                connection.execute(
                    text("UPDATE users SET role = 'admin', is_admin = 1 WHERE LOWER(email) = :email"),
                    {"email": admin_email.lower()},
                )


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
