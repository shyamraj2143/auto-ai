from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import inspect, text  # noqa: E402

from app.db.session import engine  # noqa: E402
from app import models  # noqa: F401,E402
from app.db.base import Base  # noqa: E402


def main() -> None:
    inspector = inspect(engine)
    dialect = engine.dialect.name
    quote = engine.dialect.identifier_preparer.quote
    Base.metadata.create_all(bind=engine, tables=[models.SocialFollow.__table__, models.SocialNotification.__table__])
    with engine.begin() as connection:
        user_columns = {column["name"] for column in inspector.get_columns("users")}
        if "bio" not in user_columns:
            connection.execute(text(f"ALTER TABLE {quote('users')} ADD COLUMN {quote('bio')} TEXT"))
        if "profile_visibility" not in user_columns:
            connection.execute(text(f"ALTER TABLE {quote('users')} ADD COLUMN {quote('profile_visibility')} VARCHAR(16) NOT NULL DEFAULT 'public'"))
        if "message_permission" not in user_columns:
            connection.execute(text(f"ALTER TABLE {quote('users')} ADD COLUMN {quote('message_permission')} VARCHAR(32) NOT NULL DEFAULT 'everyone'"))
        connection.execute(text(f"UPDATE {quote('users')} SET {quote('profile_visibility')} = 'public' WHERE {quote('profile_visibility')} IS NULL OR TRIM({quote('profile_visibility')}) = ''"))
        connection.execute(text(f"UPDATE {quote('users')} SET {quote('message_permission')} = 'everyone' WHERE {quote('message_permission')} IS NULL OR TRIM({quote('message_permission')}) = ''"))
        rows = connection.execute(text(f"SELECT {quote('id')}, {quote('name')}, {quote('username')} FROM {quote('users')}")).mappings()
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
            connection.execute(text(f"UPDATE {quote('users')} SET {quote('username')} = :username WHERE {quote('id')} = :user_id"), {"username": username, "user_id": user_id})
        if dialect in {"sqlite", "postgresql"}:
            connection.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username_lower ON {quote('users')} (LOWER({quote('username')})) WHERE {quote('username')} IS NOT NULL"))
    print("Social schema migration completed.")


if __name__ == "__main__":
    main()
