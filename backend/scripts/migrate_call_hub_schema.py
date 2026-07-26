from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import text  # noqa: E402

from app import models  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import engine  # noqa: E402


def main() -> None:
    Base.metadata.create_all(bind=engine, tables=[models.SearchHistory.__table__])
    with engine.begin() as connection:
        history = engine.dialect.identifier_preparer.quote("social_search_history")
        connection.execute(text(f"CREATE INDEX IF NOT EXISTS ix_social_search_history_user_created ON {history} (user_id, created_at)"))
        if engine.dialect.name == "postgresql":
            connection.execute(text("ALTER TABLE user_call_settings ALTER COLUMN call_permission SET DEFAULT 'everyone'"))
    print("Call Hub schema migration completed.")


if __name__ == "__main__":
    main()
