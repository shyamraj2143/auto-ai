"""Apply the additive message-feedback and personalization-control schema."""

from app import models  # noqa: F401
from app.db.base import Base
from app.db.session import engine, ensure_runtime_schema
from app.models.message_feedback import MessageFeedback


def migrate() -> None:
    Base.metadata.create_all(bind=engine, tables=[MessageFeedback.__table__])
    ensure_runtime_schema()


if __name__ == "__main__":
    migrate()
    print("Message feedback schema migration completed.")
