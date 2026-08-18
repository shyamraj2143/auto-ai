from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.human import ConversationTurnAnalysis, UserInteractionProfile, UserMemory
from app.models.message_feedback import MessageFeedback
from app.models.user import User


class PersonalModelService:
    """Per-user adaptive model layer built from explicit memory and feedback.

    This learns immediately as a private adapter/profile. It never changes provider
    foundation-model weights and never mixes one user's private data into another user's adapter.
    """

    VERSION = "AutoAI-Personal-v1"

    def snapshot(self, db: Session, *, user: User) -> dict[str, Any]:
        profile = self._profile(db, user.id)
        memories = list(db.scalars(select(UserMemory).where(UserMemory.user_id == user.id).order_by(UserMemory.updated_at.desc()).limit(100)))
        feedback_total = int(db.scalar(select(func.count(MessageFeedback.id)).where(MessageFeedback.user_id == user.id)) or 0)
        positive = int(db.scalar(select(func.count(MessageFeedback.id)).where(MessageFeedback.user_id == user.id, MessageFeedback.rating == 1)) or 0)
        turns = int(db.scalar(select(func.count(ConversationTurnAnalysis.id)).where(ConversationTurnAnalysis.user_id == user.id)) or 0)
        learned = dict(profile.communication_style or {}) if profile else {}
        signals = dict(learned.get("feedback_signals") or {})
        adapter = dict(learned.get("personal_model") or {})
        return {
            "model_name": self.VERSION,
            "status": adapter.get("status", "learning" if memories or feedback_total else "new"),
            "enabled": bool(user.memory_enabled and user.feedback_learning_enabled),
            "memory_learning_enabled": bool(user.memory_enabled),
            "feedback_learning_enabled": bool(user.feedback_learning_enabled),
            "training_samples": int(adapter.get("training_samples", len(memories) + feedback_total)),
            "memory_count": len(memories),
            "conversation_turns": turns,
            "feedback_count": feedback_total,
            "positive_feedback": positive,
            "quality_score": round(positive / feedback_total, 3) if feedback_total else 0.0,
            "learning_version": int(adapter.get("learning_version", 0)),
            "last_trained_at": adapter.get("last_trained_at"),
            "communication_style": profile.communication_style if profile else {},
            "learning_style": profile.learning_style if profile else None,
            "favorite_topics": profile.favorite_topics if profile else [],
            "current_projects": profile.current_projects if profile else [],
            "long_term_objectives": profile.long_term_objectives if profile else [],
            "preferred_models": adapter.get("preferred_models", []),
            "feedback_signals": signals,
            "memories": [{"id": m.id, "category": m.category, "key": m.key, "value": m.value, "confidence": float(m.confidence or 0), "updated_at": m.updated_at.isoformat() if m.updated_at else None} for m in memories],
        }

    def train(self, db: Session, *, user: User) -> dict[str, Any]:
        if not (user.memory_enabled and user.feedback_learning_enabled):
            raise ValueError("Enable memory and feedback learning before training the Personal Model.")
        profile = self._profile(db, user.id)
        if not profile:
            profile = UserInteractionProfile(user_id=user.id)
            db.add(profile)
            db.flush()
        memories = list(db.scalars(select(UserMemory).where(UserMemory.user_id == user.id)))
        feedback = list(db.scalars(select(MessageFeedback).where(MessageFeedback.user_id == user.id).order_by(MessageFeedback.updated_at.desc()).limit(1000)))
        style = dict(profile.communication_style or {})
        signals = dict(style.get("feedback_signals") or {})
        model_scores: dict[str, dict[str, float]] = {}
        for item in feedback:
            if not item.model:
                continue
            key = f"{item.provider or 'unknown'}:{item.model}"
            row = model_scores.setdefault(key, {"likes": 0.0, "dislikes": 0.0})
            row["likes" if item.rating == 1 else "dislikes"] += 1
        for row in model_scores.values():
            total = row["likes"] + row["dislikes"]
            row["score"] = round(row["likes"] / total, 4) if total else 0.0
        previous = dict(style.get("personal_model") or {})
        adapter = {
            "status": "trained",
            "learning_version": int(previous.get("learning_version", 0)) + 1,
            "training_samples": len(memories) + len(feedback),
            "memory_categories": sorted({m.category for m in memories}),
            "preferred_models": sorted(model_scores, key=lambda key: model_scores[key]["score"], reverse=True)[:10],
            "model_scores": model_scores,
            "feedback_signal": signals,
            "last_trained_at": datetime.utcnow().isoformat(),
        }
        style["personal_model"] = adapter
        profile.communication_style = style
        profile.updated_at = datetime.utcnow()
        db.add(profile)
        db.commit(); db.refresh(profile)
        return self.snapshot(db, user=user)

    def build_context(self, db: Session, *, user: User, query: str) -> str:
        if not user.memory_enabled:
            return ""
        profile = self._profile(db, user.id)
        memories = list(db.scalars(select(UserMemory).where(UserMemory.user_id == user.id).order_by(UserMemory.last_seen_at.desc()).limit(12)))
        if not memories and not profile:
            return ""
        lines = ["AUTO-AI PERSONAL MODEL (private user adapter):"]
        if profile:
            if profile.learning_style:
                lines.append(f"Learning style: {profile.learning_style}")
            style = dict(profile.communication_style or {})
            signals = dict(style.get("feedback_signals") or {})
            if signals:
                lines.append(f"Response feedback signal: {signals}")
            adapter = dict(style.get("personal_model") or {})
            if adapter.get("preferred_models"):
                lines.append(f"Preferred model signals: {adapter['preferred_models'][:5]}")
        for memory in memories:
            lines.append(f"{memory.category}/{memory.key}: {memory.value}")
        lines.append("Use these only when relevant. Never reveal private memory or claim it as external fact.")
        return "\n".join(lines)

    @staticmethod
    def _profile(db: Session, user_id: str) -> UserInteractionProfile | None:
        return db.scalar(select(UserInteractionProfile).where(UserInteractionProfile.user_id == user_id))


personal_model_service = PersonalModelService()
