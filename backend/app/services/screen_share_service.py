from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
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
GUEST_ID_PREFIX = "guest:"
GUEST_HOST_USER_ID = "f5a1a4bb-4690-5a0e-8a99-64de6f446662"


@dataclass(frozen=True)
class ScreenShareActor:
    identity_id: str
    user: User | None = None

    @property
    def guest_id(self) -> str | None:
        return self.identity_id.removeprefix(GUEST_ID_PREFIX) if self.identity_id.startswith(GUEST_ID_PREFIX) else None


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def guest_identity(guest_id: str) -> str:
    return f"{GUEST_ID_PREFIX}{guest_id}"


def is_guest_identity(identity_id: str) -> bool:
    if not identity_id.startswith(GUEST_ID_PREFIX):
        return False
    try:
        uuid.UUID(identity_id.removeprefix(GUEST_ID_PREFIX))
        return True
    except ValueError:
        return False


def sharer_identity(session: ScreenShareSession) -> str:
    return guest_identity(session.sharer_guest_id) if session.sharer_guest_id else session.sharer_user_id


def viewer_identity(session: ScreenShareSession) -> str | None:
    if session.viewer_guest_id:
        return guest_identity(session.viewer_guest_id)
    return session.viewer_user_id


def participant_identities(session: ScreenShareSession) -> set[str]:
    return {identity for identity in (sharer_identity(session), viewer_identity(session)) if identity}


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_numeric_code() -> str:
    return f"{secrets.randbelow(100_000_000):08d}"


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
        actor: ScreenShareActor,
        *,
        viewer_user_id: str | None,
        invite_link: bool,
        expires_minutes: int,
        code_mode: bool = False,
    ) -> tuple[ScreenShareSession, str | None, str | None]:
        if viewer_user_id == actor.identity_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot share with yourself.")
        if actor.guest_id and viewer_user_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Guest screen sharing requires a code or invite link.")
        if viewer_user_id:
            viewer = db.get(User, viewer_user_id)
            if not viewer or not viewer.is_active:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Viewer is unavailable.")
            if not actor.user or social_service.users_blocked(db, actor.user.id, viewer_user_id):
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Screen sharing is blocked for this user.")

        invite_token = secrets.token_urlsafe(32) if invite_link else None
        share_code: str | None = None
        share_code_hash: str | None = None
        if code_mode:
            for _ in range(20):
                candidate = generate_numeric_code()
                candidate_hash = hash_invite_token(candidate)
                exists = db.scalar(select(ScreenShareSession.session_id).where(ScreenShareSession.screen_code_hash == candidate_hash))
                if not exists:
                    share_code = candidate
                    share_code_hash = candidate_hash
                    break
            if not share_code:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Unable to generate screen share code.")
        sharer_user_id = actor.user.id if actor.user else self._guest_host_user(db).id
        session = ScreenShareSession(
            session_id=str(uuid.uuid4()),
            sharer_user_id=sharer_user_id,
            viewer_user_id=viewer_user_id,
            sharer_guest_id=actor.guest_id,
            invite_token_hash=hash_invite_token(invite_token) if invite_token else None,
            screen_code_hash=share_code_hash,
            status="waiting",
            expires_at=utcnow() + timedelta(minutes=expires_minutes),
        )
        db.add(session)
        db.commit()
        db.refresh(session)
        return session, invite_token, share_code

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

    def serialize(
        self,
        session: ScreenShareSession,
        invite_token: str | None = None,
        share_code: str | None = None,
    ) -> ScreenShareSessionRead:
        invite_link = self.invite_link(session.session_id, invite_token) if invite_token else None
        return ScreenShareSessionRead(
            session_id=session.session_id,
            sharer_user_id=sharer_identity(session),
            viewer_user_id=viewer_identity(session),
            status=session.status,
            created_at=session.created_at,
            started_at=session.started_at,
            ended_at=session.ended_at,
            expires_at=session.expires_at,
            invite_link=invite_link,
            share_code=share_code,
        )

    def claim_by_code(self, db: Session, identity_id: str, code: str) -> ScreenShareSession:
        code_hash = hash_invite_token(code)
        session = db.scalar(select(ScreenShareSession).where(ScreenShareSession.screen_code_hash == code_hash))
        if not session:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Screen share code is invalid.")
        if session.expires_at and session.expires_at < utcnow() and session.status not in TERMINAL_STATUSES:
            session.status = "ended"
            session.ended_at = utcnow()
            session.updated_at = utcnow()
            db.commit()
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="Screen share code has expired.")
        if session.status in TERMINAL_STATUSES:
            raise HTTPException(status_code=status.HTTP_410_GONE, detail="Screen share session has ended.")
        if identity_id == sharer_identity(session):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot view your own screen share.")
        if not session.sharer_guest_id and not is_guest_identity(identity_id) and social_service.users_blocked(db, session.sharer_user_id, identity_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Screen sharing is blocked for this user.")
        current_viewer = viewer_identity(session)
        if current_viewer and current_viewer != identity_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screen share code is already in use.")
        if is_guest_identity(identity_id):
            session.viewer_guest_id = identity_id.removeprefix(GUEST_ID_PREFIX)
            session.viewer_user_id = None
        else:
            session.viewer_user_id = identity_id
            session.viewer_guest_id = None
        session.updated_at = utcnow()
        db.commit()
        db.refresh(session)
        return session

    def invite_link(self, session_id: str, invite_token: str) -> str:
        return f"{settings.frontend_url}/#/screen-share/{session_id}?invite={invite_token}"

    def get_authorized(
        self,
        db: Session,
        session_id: str,
        identity_id: str,
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
        if identity_id in participant_identities(session):
            return session
        if allow_claim and self._valid_invite(session, invite_token):
            current_viewer = viewer_identity(session)
            if current_viewer and current_viewer != identity_id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screen share invite is already in use.")
            if is_guest_identity(identity_id):
                session.viewer_guest_id = identity_id.removeprefix(GUEST_ID_PREFIX)
                session.viewer_user_id = None
            else:
                session.viewer_user_id = identity_id
                session.viewer_guest_id = None
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

    def end(self, db: Session, session_id: str, identity_id: str, final_status: str = "ended") -> ScreenShareSession:
        session = self.get_authorized(db, session_id, identity_id)
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

    def peer_id_for(self, session: ScreenShareSession, identity_id: str) -> str:
        session_sharer = sharer_identity(session)
        session_viewer = viewer_identity(session)
        if identity_id == session_sharer and session_viewer:
            return session_viewer
        if identity_id == session_viewer:
            return session_sharer
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Screen share session is waiting for a viewer.")

    @staticmethod
    def _guest_host_user(db: Session) -> User:
        host = db.get(User, GUEST_HOST_USER_ID)
        if host:
            return host
        host = User(
            id=GUEST_HOST_USER_ID,
            email="screen-share-guest@autoai.site.je",
            name="Screen Share Guest",
            hashed_password=secrets.token_urlsafe(48),
            provider="system",
            is_active=False,
            role="system",
            subscription_status="disabled",
        )
        db.add(host)
        db.flush()
        return host

    def _valid_invite(self, session: ScreenShareSession, invite_token: str | None) -> bool:
        if not invite_token or not session.invite_token_hash:
            return False
        if session.expires_at and session.expires_at < utcnow():
            return False
        return secrets.compare_digest(session.invite_token_hash, hash_invite_token(invite_token))


screen_share_service = ScreenShareService()
