from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.screen_share import ScreenShareSession
from app.models.user import User
from app.schemas.screen_share import ScreenShareSessionRead
from app.services.call_service import base_public_user
from app.services.presence_service import presence_service
from app.services.social_service import social_service


TERMINAL_STATUSES = {"ended", "failed"}
SIGNALING_READY_STATUSES = {"waiting", "active"}


def utcnow() -> datetime:
    return datetime.utcnow()


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def screen_share_event(
    event_type: str,
    *,
    sender_user_id: str,
    session_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "type": event_type,
        "session_id": session_id,
        "sender_user_id": sender_user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload or {},
    }


class ScreenShareService:
    def create(
        self,
        db: Session,
        sharer: User,
        *,
        viewer_user_id: str | None,
        invite_link: bool,
        expires_minutes: int,
    ) -> tuple[ScreenShareSession, str | None]:
        if viewer_user_id == sharer.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot share with yourself.")
        if viewer_user_id:
            viewer = db.get(User, viewer_user_id)
            if not viewer or not viewer.is_active:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Viewer is unavailable.")
            if social_service.users_blocked(db, sharer.id, viewer_user_id):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Screen sharing is blocked for this user.")

        invite_token = secrets.token_urlsafe(32) if invite_link else None
        session = ScreenShareSession(
            session_id=str(uuid.uuid4()),
            sharer_user_id=sharer.id,
            viewer_user_id=viewer_user_id,
            invite_token_hash=hash_invite_token(invite_token) if invite_token else None,
            status="waiting",
            expires_at=utcnow() + timedelta(minutes=expires_minutes),
        )
        db.add(session)
        db.commit()
        db.refresh(session)
        return session, invite_token

    async def notify_created(self, db: Session, session: ScreenShareSession, sharer: User, invite_link: str | None) -> None:
        if not session.viewer_user_id:
            return
        payload = {
            "sessionId": session.session_id,
            "sharer": base_public_user(sharer).model_dump(mode="json"),
            "inviteLink": invite_link,
            "expiresAt": session.expires_at.isoformat() if session.expires_at else None,
            "message": f"{sharer.name} wants to share screen with you",
        }
        await presence_service.publish(
            session.viewer_user_id,
            screen_share_event("screen-share-invite", sender_user_id=sharer.id, session_id=session.session_id, payload=payload),
        )

    def serialize(self, session: ScreenShareSession, invite_token: str | None = None) -> ScreenShareSessionRead:
        invite_link = self.invite_link(session.session_id, invite_token) if invite_token else None
        return ScreenShareSessionRead(
            session_id=session.session_id,
            sharer_user_id=session.sharer_user_id,
            viewer_user_id=session.viewer_user_id,
            status=session.status,
            created_at=session.created_at,
            started_at=session.started_at,
            ended_at=session.ended_at,
            expires_at=session.expires_at,
            invite_link=invite_link,
        )

    def invite_link(self, session_id: str, invite_token: str) -> str:
        return f"{settings.frontend_url}/#/screen-share/{session_id}?invite={invite_token}"

    def get_authorized(
        self,
        db: Session,
        session_id: str,
        user_id: str,
        *,
        invite_token: str | None = None,
        allow_claim: bool = False,
    ) -> ScreenShareSession:
        session = db.get(ScreenShareSession, session_id)
        if not session:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Screen share session not found.")
        if session.expires_at and session.expires_at < utcnow() and session.status not in TERMINAL_STATUSES:
            session.status = "ended"
            session.ended_at = utcnow()
            db.commit()
            db.refresh(session)
        if user_id in {session.sharer_user_id, session.viewer_user_id}:
            return session
        if allow_claim and self._valid_invite(session, invite_token):
            if session.viewer_user_id and session.viewer_user_id != user_id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screen share invite is already in use.")
            session.viewer_user_id = user_id
            session.updated_at = utcnow()
            db.commit()
            db.refresh(session)
            return session
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Screen share session not found.")

    def mark_started(self, db: Session, session: ScreenShareSession) -> ScreenShareSession:
        if session.status in TERMINAL_STATUSES:
            return session
        if session.status != "active":
            session.status = "active"
            session.started_at = session.started_at or utcnow()
            session.updated_at = utcnow()
            db.commit()
            db.refresh(session)
        return session

    def end(self, db: Session, session_id: str, user_id: str, final_status: str = "ended") -> ScreenShareSession:
        session = self.get_authorized(db, session_id, user_id)
        if session.status in TERMINAL_STATUSES:
            return session
        result = db.execute(
            update(ScreenShareSession)
            .where(ScreenShareSession.session_id == session.session_id, ScreenShareSession.status.not_in(list(TERMINAL_STATUSES)))
            .values(status=final_status, ended_at=utcnow(), updated_at=utcnow())
        )
        if result.rowcount != 1:
            db.rollback()
            db.refresh(session)
            return session
        db.commit()
        db.refresh(session)
        return session

    def peer_id_for(self, session: ScreenShareSession, user_id: str) -> str:
        if user_id == session.sharer_user_id and session.viewer_user_id:
            return session.viewer_user_id
        if user_id == session.viewer_user_id:
            return session.sharer_user_id
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screen share session is waiting for a viewer.")

    def _valid_invite(self, session: ScreenShareSession, invite_token: str | None) -> bool:
        if not invite_token or not session.invite_token_hash:
            return False
        if session.expires_at and session.expires_at < utcnow():
            return False
        return secrets.compare_digest(session.invite_token_hash, hash_invite_token(invite_token))


screen_share_service = ScreenShareService()
