import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ScreenShareSession(Base):
    __tablename__ = "screen_share_sessions"

    session_id: Mapped[str] = mapped_column("sessionId", String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    sharer_user_id: Mapped[str] = mapped_column(
        "sharerUserId", String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    viewer_user_id: Mapped[str] = mapped_column(
        "viewerUserId", String(36), ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True
    )
    invite_token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="waiting", index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime, default=datetime.utcnow, nullable=False)
    started_at: Mapped[datetime] = mapped_column("startedAt", DateTime, nullable=True)
    ended_at: Mapped[datetime] = mapped_column("endedAt", DateTime, nullable=True)
    expires_at: Mapped[datetime] = mapped_column("expiresAt", DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
