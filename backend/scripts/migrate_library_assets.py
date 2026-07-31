"""Apply the additive LibraryAsset and per-chat preset schema."""

from app import models  # noqa: F401
from app.db.base import Base
from app.db.session import engine, ensure_runtime_schema
from app.models.library_asset import LibraryAsset


def migrate() -> None:
    Base.metadata.create_all(bind=engine, tables=[LibraryAsset.__table__])
    ensure_runtime_schema()


if __name__ == "__main__":
    migrate()
    print("Library asset and chat preset schema migration completed.")
