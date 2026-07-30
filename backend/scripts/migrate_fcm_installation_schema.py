"""Apply additive FCM installation diagnostics columns without deleting device data."""

from app import models  # noqa: F401
from app.db.base import Base
from app.db.session import engine, ensure_runtime_schema


if __name__ == "__main__":
    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    print("FCM installation schema migration completed.")
