import re
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.human import UserMemory


class LongTermMemoryEngine:
    MEMORY_PATTERNS: tuple[tuple[str, str, str, float], ...] = (
        ("identity", "preferred_name", r"\b(?:call me|my name is)\s+(?P<value>[a-zA-Z][a-zA-Z .'-]{1,60})", 0.9),
        ("communication_style", "response_preference", r"\bi prefer\s+(?P<value>[^.!?\n]{3,180})", 0.85),
        ("career_goal", "goal", r"\bmy goal is\s+(?P<value>[^.!?\n]{3,220})", 0.8),
        ("career_goal", "objective", r"\bi want to\s+(?P<value>[^.!?\n]{3,220})", 0.65),
        ("identity", "role", r"\bi(?:'m| am)\s+(?:a|an)\s+(?P<value>[^.!?\n]{3,120})", 0.72),
        ("learning_goal", "learning", r"\bi(?:'m| am)?\s*learning\s+(?P<value>[^.!?\n]{3,160})", 0.78),
        ("project", "current_project", r"\bi(?:'m| am)\s+(?:building|working on|creating)\s+(?P<value>[^.!?\n]{3,220})", 0.82),
        ("project", "current_project", r"\bmy project is\s+(?P<value>[^.!?\n]{3,220})", 0.85),
        ("favorite_topic", "likes", r"\bi\s+(?:like|love|enjoy)\s+(?P<value>[^.!?\n]{3,160})", 0.65),
        ("explicit_note", "remembered_note", r"\bremember that\s+(?P<value>[^.!?\n]{3,240})", 0.95),
    )
    TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9+#-]*")
    SENSITIVE_PATTERNS = (
        re.compile(r"\b(?:password|passcode|otp|one[- ]time password|private key|access token|api key|secret key)\b", re.I),
        re.compile(r"\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b", re.I),
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        re.compile(r"\b(?:\d[ -]*?){13,19}\b"),
        re.compile(r"\b(?:aadhaar|aadhar|social security|passport number|pan number)\b", re.I),
    )

    def extract_candidates(self, text: str) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for category, base_key, pattern, confidence in self.MEMORY_PATTERNS:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                value = self._clean_value(match.group("value"))
                if not self._is_useful_value(value):
                    continue
                key = base_key if base_key in {"preferred_name", "response_preference"} else f"{base_key}_{self._slug(value)}"
                candidates.append(
                    {
                        "category": category,
                        "key": key[:160],
                        "value": value[:2000],
                        "source": "conversation",
                        "confidence": confidence,
                    }
                )

        unique: dict[tuple[str, str], dict[str, Any]] = {}
        for candidate in candidates:
            unique[(candidate["category"], candidate["key"])] = candidate
        return list(unique.values())

    def retrieve_relevant_memories(
        self,
        db: Session,
        *,
        user_id: str,
        query: str,
        limit: int = 8,
    ) -> list[UserMemory]:
        memories = list(
            db.scalars(
                select(UserMemory)
                .where(UserMemory.user_id == user_id)
                .order_by(UserMemory.last_seen_at.desc())
            )
        )
        if not memories:
            return []

        query_tokens = set(self.TOKEN_RE.findall(query.lower()))
        scored: list[tuple[float, UserMemory]] = []
        for memory in memories:
            memory_tokens = set(self.TOKEN_RE.findall(f"{memory.category} {memory.key} {memory.value}".lower()))
            overlap = len(query_tokens & memory_tokens)
            preference_boost = 1.25 if memory.category in {"communication_style", "identity"} else 0.0
            score = overlap + preference_boost + float(memory.confidence or 0)
            scored.append((score, memory))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [memory for score, memory in scored[:limit] if score > 0]

    def upsert_candidates(
        self,
        db: Session,
        *,
        user_id: str,
        candidates: list[dict[str, Any]],
    ) -> list[UserMemory]:
        saved: list[UserMemory] = []
        for candidate in candidates:
            value = self._clean_value(str(candidate.get("value") or ""))
            if not self._is_useful_value(value):
                continue
            candidate = {**candidate, "value": value[:2000]}
            memory = db.scalar(
                select(UserMemory).where(
                    UserMemory.user_id == user_id,
                    UserMemory.category == candidate["category"],
                    UserMemory.key == candidate["key"],
                )
            )
            if memory:
                memory.value = candidate["value"]
                memory.source = candidate.get("source", memory.source)
                memory.confidence = max(float(memory.confidence or 0), float(candidate.get("confidence", 0.65)))
                memory.last_seen_at = datetime.utcnow()
                memory.updated_at = datetime.utcnow()
            else:
                memory = UserMemory(user_id=user_id, **candidate)
                db.add(memory)
            saved.append(memory)
        db.flush()
        return saved

    def list_memories(self, db: Session, *, user_id: str, category: str | None = None) -> list[UserMemory]:
        statement = select(UserMemory).where(UserMemory.user_id == user_id)
        if category:
            statement = statement.where(UserMemory.category == category)
        return list(db.scalars(statement.order_by(UserMemory.updated_at.desc())))

    def create_memory(self, db: Session, *, user_id: str, payload: dict[str, Any]) -> UserMemory:
        memories = self.upsert_candidates(db, user_id=user_id, candidates=[payload])
        if not memories:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Sensitive or temporary information cannot be saved as memory.",
            )
        memory = memories[0]
        db.commit()
        db.refresh(memory)
        return memory

    def update_memory(self, db: Session, *, user_id: str, memory_id: str, updates: dict[str, Any]) -> UserMemory:
        memory = self._get_memory(db, user_id=user_id, memory_id=memory_id)
        if "value" in updates and updates["value"] is not None:
            cleaned = self._clean_value(str(updates["value"]))
            if not self._is_useful_value(cleaned):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Sensitive or temporary information cannot be saved as memory.",
                )
            updates["value"] = cleaned
        for key, value in updates.items():
            if value is not None:
                setattr(memory, key, value)
        memory.updated_at = datetime.utcnow()
        memory.last_seen_at = datetime.utcnow()
        db.add(memory)
        db.commit()
        db.refresh(memory)
        return memory

    def delete_memory(self, db: Session, *, user_id: str, memory_id: str) -> None:
        memory = self._get_memory(db, user_id=user_id, memory_id=memory_id)
        db.delete(memory)
        db.commit()

    def clear_memories(self, db: Session, *, user_id: str) -> int:
        memories = list(db.scalars(select(UserMemory).where(UserMemory.user_id == user_id)))
        for memory in memories:
            db.delete(memory)
        db.commit()
        return len(memories)

    def _get_memory(self, db: Session, *, user_id: str, memory_id: str) -> UserMemory:
        memory = db.scalar(select(UserMemory).where(UserMemory.id == memory_id, UserMemory.user_id == user_id))
        if not memory:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found")
        return memory

    @staticmethod
    def _clean_value(value: str) -> str:
        return " ".join(value.strip(" .,!?\n\t").split())

    @staticmethod
    def _slug(value: str) -> str:
        normalized = re.sub(r"[^a-zA-Z0-9]+", "_", value.lower()).strip("_")
        return normalized[:48] or "item"

    @classmethod
    def _is_useful_value(cls, value: str) -> bool:
        lowered = value.lower()
        if len(value) < 3:
            return False
        noisy_prefixes = {"do this", "help me", "generate complete", "create interactions"}
        return not any(lowered.startswith(prefix) for prefix in noisy_prefixes) and not any(
            pattern.search(value) for pattern in cls.SENSITIVE_PATTERNS
        )


long_term_memory_engine = LongTermMemoryEngine()

