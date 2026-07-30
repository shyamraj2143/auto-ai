import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.utils.datetime import utc_now


class MessageFeedback(Base):
    __tablename__ = "message_feedback"
    __table_args__ = (
        CheckConstraint("rating IN (-1, 1)", name="ck_message_feedback_rating"),
        UniqueConstraint("user_id", "message_id", name="uq_message_feedback_user_message"),
        Index("ix_message_feedback_user_rating", "user_id", "rating"),
        Index("ix_message_feedback_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    chat_id: Mapped[str] = mapped_column(ForeignKey("chats.id", ondelete="CASCADE"), index=True, nullable=False)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), index=True, nullable=False)
    generation_id: Mapped[str] = mapped_column(
        ForeignKey("chat_generations.id", ondelete="SET NULL"), index=True, nullable=True
    )
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=True)
    comment: Mapped[str] = mapped_column(Text, nullable=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=True)
    model: Mapped[str] = mapped_column(String(160), nullable=True)
    response_mode: Mapped[str] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )

    message = relationship("Message", back_populates="feedback")
    user = relationship("User", back_populates="message_feedback")
