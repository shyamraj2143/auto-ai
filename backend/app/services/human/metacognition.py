from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.human import ConversationTurnAnalysis, UserInteractionProfile, UserMemory
from app.models.message import Message
from app.models.user import User
from app.services.human.conversation_manager import conversation_manager
from app.services.human.emotion_detection import emotion_detection_engine
from app.services.human.emotional_state import emotional_state_manager
from app.services.human.humanization import humanization_layer
from app.services.human.memory_service import long_term_memory_engine
from app.services.human.personality import personality_adaptation_engine
from app.services.human.relationship import relationship_engine
from app.services.human.style_mirroring import style_mirroring_engine
from app.services.human.tone_analysis import tone_analysis_engine


class MetaCognitionLayer:
    def prepare_context(
        self,
        db: Session,
        *,
        user_id: str,
        chat_id: str,
        user_message: str,
        history: list[Message],
    ) -> dict[str, Any]:
        profile = emotional_state_manager.get_or_create_profile(db, user_id)
        emotion = emotion_detection_engine.analyze(user_message)
        tone = tone_analysis_engine.analyze(user_message)
        conversation = conversation_manager.analyze(user_message, history)
        personality = personality_adaptation_engine.select(
            intent=conversation["intent"],
            emotion=emotion,
            tone=tone,
        )
        style_directives = style_mirroring_engine.build_directives(emotion, tone)
        user = db.get(User, user_id)
        memory_enabled = user is None or bool(user.memory_enabled)
        memory_candidates = long_term_memory_engine.extract_candidates(user_message) if memory_enabled else []
        relevant_memories = (
            [
                self._memory_snapshot(memory)
                for memory in long_term_memory_engine.retrieve_relevant_memories(
                    db,
                    user_id=user_id,
                    query=user_message,
                )
            ]
            if memory_enabled
            else []
        )
        state_delta = emotional_state_manager.compute_delta(
            emotion=emotion,
            tone=tone,
            conversation=conversation,
        )
        profile_snapshot = self._profile_snapshot(profile)
        prompt_context = humanization_layer.build_prompt_context(
            emotion=emotion,
            tone=tone,
            state_delta=state_delta,
            profile_snapshot=profile_snapshot,
            personality=personality,
            style_directives=style_directives,
            relevant_memories=relevant_memories,
            conversation=conversation,
        )

        return {
            "chat_id": chat_id,
            "emotion": emotion,
            "tone": tone,
            "conversation": conversation,
            "personality": personality,
            "style_directives": style_directives,
            "memory_candidates": memory_candidates,
            "relevant_memories": relevant_memories,
            "state_delta": state_delta,
            "profile_snapshot": profile_snapshot,
            "prompt_context": prompt_context,
            "memory_enabled": memory_enabled,
        }

    def complete_turn(
        self,
        db: Session,
        *,
        user_id: str,
        chat_id: str,
        user_message: str,
        prepared: dict[str, Any],
        user_message_id: str | None,
        assistant_message_id: str | None,
    ) -> ConversationTurnAnalysis:
        existing = db.scalar(
            select(ConversationTurnAnalysis).where(
                ConversationTurnAnalysis.user_id == user_id,
                ConversationTurnAnalysis.chat_id == chat_id,
                ConversationTurnAnalysis.assistant_message_id == assistant_message_id,
            )
        )
        if existing:
            return existing
        profile = emotional_state_manager.get_or_create_profile(db, user_id)
        emotional_state_manager.apply_delta(
            profile,
            delta=prepared["state_delta"],
            tone=prepared["tone"],
            personality=prepared["personality"],
        )
        relationship_engine.update(
            profile,
            user_message=user_message,
            memory_candidates=prepared["memory_candidates"],
        )
        user = db.get(User, user_id)
        if prepared.get("memory_enabled", True) and (user is None or user.memory_enabled):
            long_term_memory_engine.upsert_candidates(
                db,
                user_id=user_id,
                candidates=prepared["memory_candidates"],
            )

        analysis = ConversationTurnAnalysis(
            user_id=user_id,
            chat_id=chat_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            emotion=prepared["emotion"],
            tone=prepared["tone"],
            intent=prepared["conversation"]["intent"],
            language=prepared["tone"].get("language", "english"),
            personality_mode=prepared["personality"],
            state_delta=prepared["state_delta"],
            flags=prepared["conversation"].get("flags", {}),
        )
        db.add(profile)
        db.add(analysis)
        db.flush()
        return analysis

    @staticmethod
    def _memory_snapshot(memory: UserMemory) -> dict[str, Any]:
        return {
            "id": memory.id,
            "category": memory.category,
            "key": memory.key,
            "value": memory.value,
            "confidence": float(memory.confidence or 0),
        }

    @staticmethod
    def _profile_snapshot(profile: UserInteractionProfile) -> dict[str, Any]:
        return {
            "trust_score": profile.trust_score,
            "rapport_score": profile.rapport_score,
            "respect_score": profile.respect_score,
            "curiosity_score": profile.curiosity_score,
            "confidence_score": profile.confidence_score,
            "frustration_score": profile.frustration_score,
            "humor_score": profile.humor_score,
            "communication_style": profile.communication_style or {},
            "personality_blend": profile.personality_blend or {},
            "favorite_topics": profile.favorite_topics or [],
            "current_projects": profile.current_projects or [],
            "long_term_objectives": profile.long_term_objectives or [],
            "learning_style": profile.learning_style,
        }


meta_cognition_layer = MetaCognitionLayer()

