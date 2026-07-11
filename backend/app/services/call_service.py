from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.call import Call, UserCallSettings
from app.models.user import User
from app.schemas.call import CallRead, PublicCallUser
from app.services.call_notification_service import (
    public_avatar,
    send_call_dismiss_notifications,
    send_incoming_call_notifications,
)
from app.services.call_permission_service import call_allowed, get_or_create_call_settings
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.social_service import social_service


TERMINAL_STATUSES = {"rejected", "cancelled", "busy", "missed", "failed", "ended"}
SIGNALING_STATUSES = {"accepted", "connecting", "active"}
VALID_END_REASONS = {
    "caller_cancelled",
    "callee_rejected",
    "no_answer",
    "user_busy",
    "network_failed",
    "permission_denied",
    "caller_ended",
    "callee_ended",
    "app_closed",
    "server_timeout",
}


def utcnow() -> datetime:
    return datetime.utcnow()


def signal_event(
    event_type: str,
    *,
    sender_user_id: str,
    call_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "type": event_type,
        "call_id": call_id,
        "sender_user_id": sender_user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload or {},
    }


def base_public_user(user: User) -> PublicCallUser:
    return PublicCallUser(
        id=user.id,
        display_name=user.name,
        username=user.username or f"user_{user.id.replace('-', '')[:8]}",
        avatar_url=user.avatar or user.picture,
    )


class CallService:
    async def public_user(
        self,
        db: Session,
        user: User,
        *,
        viewer_id: str,
        settings_record: UserCallSettings | None = None,
    ) -> PublicCallUser:
        record = settings_record or get_or_create_call_settings(db, user.id)
        public = base_public_user(user)
        try:
            presence = await presence_service.presence_for_user(user.id)
        except RealtimeUnavailable:
            presence = {"state": "offline", "last_seen_at": None, "reachable": False}
        state = str(presence.get("state") or "offline")
        if not record.show_online_status and viewer_id != user.id:
            public.presence = "hidden"
            public.availability = "Calls disabled" if record.call_permission == "nobody" or not (record.allow_audio_calls or record.allow_video_calls) else "Available"
        else:
            public.presence = state if state in {"online", "away", "background", "busy", "offline"} else "offline"
            public.availability = {
                "online": "Online",
                "away": "Away",
                "background": "Reachable",
                "busy": "In another call",
                "offline": "Offline",
            }.get(public.presence, "Available")
            if record.call_permission == "nobody" or not (record.allow_audio_calls or record.allow_video_calls):
                public.availability = "Calls disabled"
        if record.show_last_seen and presence.get("last_seen_at") and viewer_id != user.id:
            try:
                public.last_seen_at = datetime.fromisoformat(str(presence["last_seen_at"]).replace("Z", "+00:00"))
            except ValueError:
                public.last_seen_at = None
        public.can_audio_call = record.allow_audio_calls and record.call_permission != "nobody"
        public.can_video_call = record.allow_video_calls and record.call_permission != "nobody"
        if state == "busy":
            public.can_audio_call = False
            public.can_video_call = False
        return public

    async def serialize_call(
        self,
        db: Session,
        call: Call,
        viewer_id: str,
        *,
        delivery: str | None = None,
        silent: bool = False,
    ) -> CallRead:
        peer_id = call.callee_id if viewer_id == call.caller_id else call.caller_id
        peer = db.get(User, peer_id)
        if not peer:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call participant no longer exists.")
        return CallRead(
            id=call.id,
            caller_id=call.caller_id,
            callee_id=call.callee_id,
            call_type=call.call_type,
            status=call.status,
            created_at=call.created_at,
            ringing_at=call.ringing_at,
            accepted_at=call.accepted_at,
            connected_at=call.connected_at,
            ended_at=call.ended_at,
            duration_seconds=call.duration_seconds,
            ended_by=call.ended_by,
            end_reason=call.end_reason,
            direction="outgoing" if viewer_id == call.caller_id else "incoming",
            peer=await self.public_user(db, peer, viewer_id=viewer_id),
            delivery=delivery,
            silent=silent,
        )

    async def initiate(
        self,
        db: Session,
        caller: User,
        callee_id: str,
        call_type: str,
        caller_device_id: str | None,
    ) -> CallRead:
        if not settings.CALL_FEATURE_ENABLED:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calls are disabled.")
        if caller.id == callee_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot call yourself.")
        callee = db.get(User, callee_id)
        if not callee or not callee.is_active:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User is unavailable.")
        if not await presence_service.allow_rate(
            "attempt", caller.id, settings.CALL_MAX_ATTEMPTS_PER_MINUTE
        ):
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many call attempts. Try again shortly.")
        if not await presence_service.allow_rate("pair", f"{caller.id}:{callee_id}", 3, 60):
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Please wait before calling this user again.")
        allowed, known = call_allowed(db, caller.id, callee_id, call_type)
        if not allowed:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User is unavailable for calls.")
        callee_settings = get_or_create_call_settings(db, callee_id)
        call = Call(
            id=str(uuid.uuid4()),
            caller_id=caller.id,
            callee_id=callee_id,
            call_type=call_type,
            caller_device_id=caller_device_id,
            status="initiated",
        )
        if not await presence_service.acquire_call_locks(call.id, caller.id, callee_id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User is on another call.")
        try:
            db.add(call)
            db.flush()
            silent = bool(callee_settings.silence_unknown_callers and not known)
            incoming_payload = {
                "call_type": call.call_type,
                "caller": {
                    "id": caller.id,
                    "display_name": caller.name,
                    "username": caller.username or f"user_{caller.id.replace('-', '')[:8]}",
                    "avatar_url": public_avatar(caller) or None,
                },
                "expires_at": (
                    datetime.now(timezone.utc) + timedelta(seconds=settings.CALL_RING_TIMEOUT_SECONDS)
                ).isoformat(),
                "silent": silent,
            }
            websocket_receivers = await presence_service.publish(
                callee_id,
                signal_event("call.incoming", sender_user_id=caller.id, call_id=call.id, payload=incoming_payload),
            )
            push_receivers = send_incoming_call_notifications(
                db, call, caller, callee_settings, silent=silent
            )
            social_service.create_notification(
                db,
                user_id=callee_id,
                actor_id=caller.id,
                notification_type="incoming_call",
                target_type="call",
                target_id=call.id,
                title=f"Incoming {call.call_type} call from {caller.name}",
                dedupe_key=f"incoming_call:{call.id}:{callee_id}",
            )
            db.commit()
        except Exception:
            db.rollback()
            await presence_service.release_call_locks(call.id, [caller.id, callee_id])
            raise
        delivery_parts = []
        if websocket_receivers:
            delivery_parts.append("websocket")
        if push_receivers:
            delivery_parts.append("push")
        delivery = "+".join(delivery_parts) or "unreachable"
        return await self.serialize_call(db, call, caller.id, delivery=delivery, silent=silent)

    def get_authorized(self, db: Session, call_id: str, user_id: str) -> Call:
        call = db.get(Call, call_id)
        if not call or user_id not in {call.caller_id, call.callee_id}:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found.")
        return call

    async def ringing(self, db: Session, call_id: str, user_id: str) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if user_id != call.callee_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the receiver can mark a call as ringing.")
        if call.status in {"ringing", "accepted", "connecting", "active"}:
            return call
        result = db.execute(
            update(Call)
            .where(Call.id == call.id, Call.status == "initiated")
            .values(status="ringing", ringing_at=utcnow(), updated_at=utcnow())
        )
        if result.rowcount != 1:
            db.rollback()
            db.expire_all()
            call = self.get_authorized(db, call_id, user_id)
            if call.status in {"ringing", "accepted", "connecting", "active"}:
                return call
            self._require_state(call, {"initiated"})
        db.commit()
        db.expire_all()
        call = self.get_authorized(db, call_id, user_id)
        await presence_service.publish(
            call.caller_id,
            signal_event("call.ringing", sender_user_id=user_id, call_id=call.id),
        )
        return call

    async def accept(self, db: Session, call_id: str, user_id: str, device_id: str | None = None) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if user_id != call.callee_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the receiver can accept this call.")
        if call.status in {"accepted", "connecting", "active"}:
            return call
        self._expire_if_late(call)
        result = db.execute(
            update(Call)
            .where(Call.id == call.id, Call.status.in_(["initiated", "ringing"]))
            .values(
                status="accepted",
                accepted_at=utcnow(),
                callee_device_id=device_id or call.callee_device_id,
                updated_at=utcnow(),
            )
        )
        if result.rowcount != 1:
            db.rollback()
            db.expire_all()
            call = self.get_authorized(db, call_id, user_id)
            if call.status in {"accepted", "connecting", "active"}:
                return call
            self._require_state(call, {"initiated", "ringing"})
        db.commit()
        db.expire_all()
        call = self.get_authorized(db, call_id, user_id)
        await self._publish_both(call, "call.accepted", user_id)
        send_call_dismiss_notifications(db, call, "call_accepted")
        db.commit()
        return call

    async def reject(self, db: Session, call_id: str, user_id: str) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if user_id != call.callee_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the receiver can reject this call.")
        if call.status == "rejected":
            return call
        if call.status in {"accepted", "connecting", "active"}:
            return call
        self._require_state(call, {"initiated", "ringing"})
        return await self._finish(
            db, call, user_id, "rejected", "callee_rejected", "call.rejected", {"initiated", "ringing"}
        )

    async def cancel(self, db: Session, call_id: str, user_id: str) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if user_id != call.caller_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the caller can cancel this call.")
        if call.status == "cancelled":
            return call
        self._require_state(call, {"initiated", "ringing"})
        return await self._finish(
            db, call, user_id, "cancelled", "caller_cancelled", "call.cancelled", {"initiated", "ringing"}
        )

    async def end(self, db: Session, call_id: str, user_id: str, reason: str | None = None) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if call.status in TERMINAL_STATUSES:
            return call
        self._require_state(call, {"accepted", "connecting", "active"})
        default_reason = "caller_ended" if user_id == call.caller_id else "callee_ended"
        selected_reason = reason if reason in VALID_END_REASONS else default_reason
        return await self._finish(
            db, call, user_id, "ended", selected_reason, "call.ended", {"accepted", "connecting", "active"}
        )

    async def connected(self, db: Session, call_id: str, user_id: str) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if call.status == "active":
            return call
        result = db.execute(
            update(Call)
            .where(Call.id == call.id, Call.status.in_(["accepted", "connecting"]))
            .values(status="active", connected_at=call.connected_at or utcnow(), updated_at=utcnow())
        )
        if result.rowcount != 1:
            db.rollback()
            db.expire_all()
            call = self.get_authorized(db, call_id, user_id)
            if call.status == "active":
                return call
            self._require_state(call, {"accepted", "connecting"})
        db.commit()
        db.expire_all()
        call = self.get_authorized(db, call_id, user_id)
        await presence_service.refresh_call_locks(call.id, [call.caller_id, call.callee_id])
        await self._publish_both(call, "call.active", user_id)
        return call

    async def authorize_signaling(self, db: Session, call_id: str, user_id: str, event_type: str) -> tuple[Call, str]:
        call = self.get_authorized(db, call_id, user_id)
        other_id = call.callee_id if user_id == call.caller_id else call.caller_id
        if social_service.users_blocked(db, user_id, other_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Signaling is blocked for this call.")
        if call.status not in SIGNALING_STATUSES:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Call is not ready for WebRTC signaling.")
        if event_type in {"webrtc.offer", "webrtc.renegotiate", "webrtc.ice_restart"} and call.status == "accepted":
            result = db.execute(
                update(Call)
                .where(Call.id == call.id, Call.status == "accepted")
                .values(status="connecting", updated_at=utcnow())
            )
            db.commit()
            if result.rowcount == 1:
                db.expire_all()
                call = self.get_authorized(db, call_id, user_id)
        recipient_id = call.callee_id if user_id == call.caller_id else call.caller_id
        return call, recipient_id

    async def fail_call(self, db: Session, call_id: str, user_id: str, reason: str) -> Call:
        call = self.get_authorized(db, call_id, user_id)
        if call.status in TERMINAL_STATUSES:
            return call
        return await self._finish(
            db,
            call,
            user_id,
            "failed",
            reason,
            "call.ended",
            {"initiated", "ringing", "accepted", "connecting", "active"},
        )

    async def _finish(
        self,
        db: Session,
        call: Call,
        user_id: str,
        final_status: str,
        reason: str,
        event_type: str,
        allowed_statuses: set[str],
    ) -> Call:
        now = utcnow()
        duration = max(0, int((now - call.connected_at).total_seconds())) if call.connected_at else 0
        try:
            result = db.execute(
                update(Call)
                .where(Call.id == call.id, Call.status.in_(allowed_statuses))
                .values(
                    status=final_status,
                    ended_at=now,
                    ended_by=user_id,
                    end_reason=reason,
                    duration_seconds=duration,
                    updated_at=now,
                )
            )
            if result.rowcount != 1:
                db.rollback()
                db.expire_all()
                current = self.get_authorized(db, call.id, user_id)
                if current.status == final_status:
                    return current
                self._require_state(current, allowed_statuses)
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            raise
        db.expire_all()
        call = self.get_authorized(db, call.id, user_id)
        await presence_service.release_call_locks(call.id, [call.caller_id, call.callee_id])
        await self._publish_both(call, event_type, user_id, {"status": final_status, "end_reason": reason})
        send_call_dismiss_notifications(db, call, event_type.replace(".", "_"))
        db.commit()
        return call

    async def _publish_both(
        self,
        call: Call,
        event_type: str,
        sender_user_id: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        event = signal_event(
            event_type, sender_user_id=sender_user_id, call_id=call.id, payload=payload or {"status": call.status}
        )
        await asyncio.gather(
            presence_service.publish(call.caller_id, event),
            presence_service.publish(call.callee_id, event),
        )

    @staticmethod
    def _require_state(call: Call, allowed: set[str]) -> None:
        if call.status not in allowed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Call action is not valid while status is {call.status}.",
            )

    @staticmethod
    def _expire_if_late(call: Call) -> None:
        if utcnow() - call.created_at > timedelta(seconds=settings.CALL_RING_TIMEOUT_SECONDS):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Call is no longer ringing.")


call_service = CallService()


async def expire_stale_calls_once() -> int:
    cutoff = utcnow() - timedelta(seconds=settings.CALL_RING_TIMEOUT_SECONDS)
    with SessionLocal() as db:
        calls = db.scalars(
            select(Call).where(Call.status.in_(["initiated", "ringing"]), Call.created_at <= cutoff).limit(100)
        ).all()
        expired = 0
        for call in calls:
            result = db.execute(
                update(Call)
                .where(Call.id == call.id, Call.status.in_(["initiated", "ringing"]))
                .values(status="missed", ended_at=utcnow(), end_reason="no_answer", updated_at=utcnow())
            )
            if result.rowcount != 1:
                db.rollback()
                continue
            db.commit()
            db.expire_all()
            call = db.get(Call, call.id)
            if not call:
                continue
            await presence_service.release_call_locks(call.id, [call.caller_id, call.callee_id])
            await call_service._publish_both(
                call, "call.missed", call.callee_id, {"status": "missed", "end_reason": "no_answer"}
            )
            send_call_dismiss_notifications(db, call, "call_missed")
            social_service.create_notification(
                db,
                user_id=call.callee_id,
                actor_id=call.caller_id,
                notification_type="missed_call",
                target_type="call",
                target_id=call.id,
                title="Missed call",
                dedupe_key=f"missed_call:{call.id}:{call.callee_id}",
            )
            db.commit()
            expired += 1
        return expired


async def call_timeout_worker(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            if settings.CALL_FEATURE_ENABLED and await presence_service.check():
                await expire_stale_calls_once()
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=5)
        except asyncio.TimeoutError:
            continue
