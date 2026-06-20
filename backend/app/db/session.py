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


def ensure_runtime_schema() -> None:
    """Apply tiny additive schema updates for local SQLite installs."""
    if not database_url.startswith("sqlite"):
        return

    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "documents" not in table_names:
        return

    document_columns = {column["name"] for column in inspector.get_columns("documents")}
    statements: list[str] = []
    if "file_size" not in document_columns:
        statements.append("ALTER TABLE documents ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0")
    if "metadata" not in document_columns:
        statements.append("ALTER TABLE documents ADD COLUMN metadata JSON")

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
