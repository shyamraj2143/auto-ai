from collections import Counter
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.human import UserInteractionProfile
from app.models.message import Message
from app.models.message_feedback import MessageFeedback
from app.models.user import User


class MessageFeedbackService:
    def message_for_owner(self, db: Session, *, user_id: str, chat_id: str, message_id: str) -> Message:
        message = db.scalar(
            select(Message)
            .join(Chat, Chat.id == Message.chat_id)
            .where(
                Chat.id == chat_id,
                Chat.user_id == user_id,
                Message.id == message_id,
                Message.chat_id == chat_id,
            )
        )
        if not message:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assistant message not found.")
        if message.role != "assistant":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Feedback is accepted only for assistant responses.",
            )
        return message

    def get(
        self, db: Session, *, user_id: str, chat_id: str, message_id: str
    ) -> MessageFeedback | None:
        self.message_for_owner(db, user_id=user_id, chat_id=chat_id, message_id=message_id)
        return db.scalar(
            select(MessageFeedback).where(
                MessageFeedback.user_id == user_id,
                MessageFeedback.chat_id == chat_id,
                MessageFeedback.message_id == message_id,
            )
        )

    def put(
        self,
        db: Session,
        *,
        user: User,
        chat_id: str,
        message_id: str,
        rating: int,
        reason: str | None,
        comment: str | None,
    ) -> MessageFeedback:
        message = self.message_for_owner(db, user_id=user.id, chat_id=chat_id, message_id=message_id)
        feedback = db.scalar(
            select(MessageFeedback).where(
                MessageFeedback.user_id == user.id,
                MessageFeedback.message_id == message_id,
            )
        )
        generation = db.scalar(
            select(ChatGeneration)
            .where(
                ChatGeneration.user_id == user.id,
                ChatGeneration.chat_id == chat_id,
                ChatGeneration.assistant_message_id == message_id,
            )
            .order_by(ChatGeneration.created_at.desc())
        )
        model_meta = (message.message_metadata or {}).get("model")
        provider = model_meta.get("provider") if isinstance(model_meta, dict) else None
        model_name = model_meta.get("model") if isinstance(model_meta, dict) else message.model
        response_mode = (
            str((generation.request_payload or {}).get("mode"))
            if generation and isinstance(generation.request_payload, dict)
            else None
        )
        if feedback is None:
            feedback = MessageFeedback(
                user_id=user.id,
                chat_id=chat_id,
                message_id=message_id,
                generation_id=generation.id if generation else None,
                rating=rating,
            )
            db.add(feedback)
        feedback.rating = rating
        feedback.reason = reason if rating == -1 else None
        feedback.comment = comment
        feedback.generation_id = generation.id if generation else feedback.generation_id
        feedback.provider = str(provider)[:64] if provider else None
        feedback.model = str(model_name)[:160] if model_name else None
        feedback.response_mode = response_mode[:32] if response_mode else None
        feedback.updated_at = datetime.utcnow()
        if user.feedback_learning_enabled:
            self._update_preference_signal(db, user_id=user.id, rating=rating, reason=reason)
        db.commit()
        db.refresh(feedback)
        return feedback

    def delete(self, db: Session, *, user_id: str, chat_id: str, message_id: str) -> None:
        feedback = self.get(db, user_id=user_id, chat_id=chat_id, message_id=message_id)
        if feedback:
            db.delete(feedback)
            db.commit()

    @staticmethod
    def _update_preference_signal(
        db: Session, *, user_id: str, rating: int, reason: str | None
    ) -> None:
        profile = db.scalar(select(UserInteractionProfile).where(UserInteractionProfile.user_id == user_id))
        if not profile:
            profile = UserInteractionProfile(user_id=user_id)
            db.add(profile)
            db.flush()
        style = dict(profile.communication_style or {})
        feedback = dict(style.get("feedback_signals") or {})
        feedback["sample_count"] = min(int(feedback.get("sample_count", 0)) + 1, 1000)
        feedback["positive_weight"] = round(
            max(0.0, min(1.0, float(feedback.get("positive_weight", 0.5)) * 0.9 + (1 if rating == 1 else 0) * 0.1)),
            4,
        )
        if rating == -1 and reason:
            reasons = dict(feedback.get("dislike_reasons") or {})
            reasons[reason] = min(int(reasons.get(reason, 0)) + 1, 100)
            feedback["dislike_reasons"] = reasons
        feedback["updated_at"] = datetime.utcnow().isoformat()
        style["feedback_signals"] = feedback
        profile.communication_style = style
        profile.updated_at = datetime.utcnow()

    def aggregate(self, db: Session) -> list[dict[str, Any]]:
        if not settings.FEEDBACK_AGGREGATE_ANALYTICS_ENABLED:
            return []
        minimum = max(2, settings.FEEDBACK_ANALYTICS_MIN_GROUP_SIZE)
        rows = db.execute(
            select(
                func.coalesce(MessageFeedback.model, "unknown"),
                func.coalesce(MessageFeedback.provider, "unknown"),
                func.coalesce(MessageFeedback.response_mode, "unknown"),
                func.count(MessageFeedback.id),
                func.sum(case((MessageFeedback.rating == 1, 1), else_=0)),
            )
            .group_by(MessageFeedback.model, MessageFeedback.provider, MessageFeedback.response_mode)
            .having(func.count(MessageFeedback.id) >= minimum)
        ).all()
        result: list[dict[str, Any]] = []
        for model, provider, response_mode, total, likes in rows:
            reason_rows = db.execute(
                select(MessageFeedback.reason, func.count(MessageFeedback.id))
                .where(
                    MessageFeedback.model == (None if model == "unknown" else model),
                    MessageFeedback.provider == (None if provider == "unknown" else provider),
                    MessageFeedback.response_mode == (None if response_mode == "unknown" else response_mode),
                    MessageFeedback.rating == -1,
                    MessageFeedback.reason.is_not(None),
                )
                .group_by(MessageFeedback.reason)
            ).all()
            reason_counts = Counter({str(reason): int(count) for reason, count in reason_rows})
            likes_value = int(likes or 0)
            result.append(
                {
                    "model": str(model),
                    "provider": str(provider),
                    "response_mode": str(response_mode),
                    "total": int(total),
                    "likes": likes_value,
                    "dislikes": int(total) - likes_value,
                    "like_rate": round(likes_value / int(total), 4),
                    "reason_counts": dict(reason_counts),
                }
            )
        return result


message_feedback_service = MessageFeedbackService()
