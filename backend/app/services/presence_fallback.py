from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any


logger = logging.getLogger("auto_ai.calls.realtime.fallback")


class _ResilientPubSub:
    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate
        self._inner = None

    async def subscribe(self, *channels: str) -> None:
        try:
            self._inner = self._delegate.client().pubsub(ignore_subscribe_messages=True)
            await self._inner.subscribe(*channels)
        except Exception as exc:
            self._inner = None
            logger.warning("redis_pubsub_unavailable_local_signaling_active error=%s", type(exc).__name__)

    async def get_message(self, timeout: float = 20.0):
        if self._inner is not None:
            try:
                return await self._inner.get_message(timeout=timeout)
            except Exception as exc:
                logger.warning("redis_pubsub_interrupted_local_signaling_active error=%s", type(exc).__name__)
                try:
                    await self._inner.aclose()
                except Exception:
                    pass
                self._inner = None
        await asyncio.sleep(min(max(timeout, 0.05), 0.75))
        return None

    async def unsubscribe(self, *channels: str) -> None:
        if self._inner is not None:
            try:
                await self._inner.unsubscribe(*channels)
            except Exception:
                pass

    async def aclose(self) -> None:
        if self._inner is not None:
            try:
                await self._inner.aclose()
            except Exception:
                pass
            self._inner = None


class ResilientPresenceService:
    """Redis-first realtime service with a single-process in-memory failover.

    The production container runs one Uvicorn process, so this fallback keeps active
    WebSocket signaling, one-time tickets, locks, deduplication and rate limits alive
    during short Redis interruptions instead of failing every call immediately.
    """

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate
        self._lock = asyncio.Lock()
        self._tickets: dict[str, tuple[str, float]] = {}
        self._connections: dict[str, dict[str, Any]] = {}
        self._user_connections: dict[str, set[str]] = {}
        self._busy: dict[str, tuple[str, float]] = {}
        self._rates: dict[str, tuple[int, float]] = {}
        self._events: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self._delegate.configured)

    @property
    def _redis(self):
        return self._delegate._redis

    @_redis.setter
    def _redis(self, value) -> None:
        self._delegate._redis = value

    @property
    def local_fallback_enabled(self) -> bool:
        return True

    def client(self):
        return self._delegate.client()

    async def check(self, *, log_failure: bool = False) -> bool:
        return await self._delegate.check(log_failure=log_failure)

    async def realtime_ready(self) -> bool:
        if await self.check():
            return True
        logger.warning("redis_health_failed_local_realtime_fallback_ready=true")
        return True

    async def close(self) -> None:
        await self._delegate.close()
        async with self._lock:
            self._tickets.clear()
            self._connections.clear()
            self._user_connections.clear()
            self._busy.clear()
            self._rates.clear()
            self._events.clear()

    async def create_ticket(self, user_id: str) -> str:
        try:
            ticket = await self._delegate.create_ticket(user_id)
        except Exception as exc:
            ticket = secrets.token_urlsafe(36)
            logger.warning("redis_ticket_create_failed_local_ticket_used error=%s", type(exc).__name__)
        async with self._lock:
            self._prune_locked()
            self._tickets[self._delegate._ticket_key(ticket)] = (
                user_id,
                time.monotonic() + max(10, int(self._ticket_ttl())),
            )
        return ticket

    async def consume_ticket(self, ticket: str) -> str | None:
        if not ticket or len(ticket) > 256:
            return None
        key = self._delegate._ticket_key(ticket)
        try:
            user_id = await self._delegate.consume_ticket(ticket)
            if user_id:
                async with self._lock:
                    self._tickets.pop(key, None)
                return user_id
        except Exception:
            pass
        async with self._lock:
            self._prune_locked()
            stored = self._tickets.pop(key, None)
            return stored[0] if stored and stored[1] > time.monotonic() else None

    async def register_connection(self, user_id: str, connection_id: str, state: str = "online") -> None:
        async with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            self._connections[connection_id] = {
                "user_id": user_id,
                "state": state,
                "last_seen_at": now,
            }
            self._user_connections.setdefault(user_id, set()).add(connection_id)
        try:
            await self._delegate.register_connection(user_id, connection_id, state)
        except Exception as exc:
            logger.warning("redis_connection_register_failed_local_presence_used error=%s", type(exc).__name__)

    async def heartbeat(self, user_id: str, connection_id: str, state: str | None = None) -> None:
        async with self._lock:
            current = self._connections.get(connection_id, {"user_id": user_id, "state": "online"})
            if current.get("user_id") != user_id:
                return
            current["state"] = state or str(current.get("state") or "online")
            current["last_seen_at"] = datetime.now(timezone.utc).isoformat()
            self._connections[connection_id] = current
            self._user_connections.setdefault(user_id, set()).add(connection_id)
        try:
            await self._delegate.heartbeat(user_id, connection_id, state)
        except Exception:
            return

    async def unregister_connection(self, user_id: str, connection_id: str) -> None:
        async with self._lock:
            self._connections.pop(connection_id, None)
            connections = self._user_connections.get(user_id)
            if connections is not None:
                connections.discard(connection_id)
                if not connections:
                    self._user_connections.pop(user_id, None)
        try:
            await self._delegate.unregister_connection(user_id, connection_id)
        except Exception:
            return

    async def presence_for_user(self, user_id: str) -> dict[str, Any]:
        try:
            result = await self._delegate.presence_for_user(user_id)
            if result.get("reachable"):
                return result
        except Exception:
            pass
        async with self._lock:
            ids = list(self._user_connections.get(user_id, set()))
            states = [self._connections[item] for item in ids if item in self._connections]
            if not states:
                return {"state": "offline", "last_seen_at": None, "reachable": False}
            busy = self._busy.get(user_id)
            if busy and busy[1] > time.monotonic():
                state = "busy"
            else:
                order = {"online": 4, "away": 3, "background": 2, "offline": 1}
                state = max((str(item.get("state") or "offline") for item in states), key=lambda value: order.get(value, 0))
            last_seen = max((str(item.get("last_seen_at") or "") for item in states), default="") or None
            return {"state": state, "last_seen_at": last_seen, "reachable": True}

    async def presence_for_users(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        return {user_id: await self.presence_for_user(user_id) for user_id in user_ids}

    def subscribe_local(self, user_id: str):
        return self._delegate.subscribe_local(user_id)

    def unsubscribe_local(self, user_id: str, queue) -> None:
        self._delegate.unsubscribe_local(user_id, queue)

    async def publish(self, user_id: str, event: dict[str, Any]) -> int:
        try:
            return await self._delegate.publish(user_id, event)
        except Exception as exc:
            logger.warning("redis_publish_failed_no_remote_receiver error=%s", type(exc).__name__)
            return 0

    async def acquire_call_locks(self, call_id: str, caller_id: str, callee_id: str) -> bool:
        try:
            acquired = await self._delegate.acquire_call_locks(call_id, caller_id, callee_id)
            if not acquired:
                return False
            async with self._lock:
                self._set_busy_locked(call_id, [caller_id, callee_id])
            return True
        except Exception as exc:
            logger.warning("redis_call_lock_failed_local_lock_used error=%s", type(exc).__name__)
        async with self._lock:
            self._prune_locked()
            if any(user_id in self._busy for user_id in (caller_id, callee_id)):
                return False
            self._set_busy_locked(call_id, [caller_id, callee_id])
            return True

    async def refresh_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        async with self._lock:
            self._set_busy_locked(call_id, user_ids)
        try:
            await self._delegate.refresh_call_locks(call_id, user_ids)
        except Exception:
            return

    async def release_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        async with self._lock:
            for user_id in user_ids:
                current = self._busy.get(user_id)
                if current and current[0] == call_id:
                    self._busy.pop(user_id, None)
        try:
            await self._delegate.release_call_locks(call_id, user_ids)
        except Exception:
            return

    async def allow_rate(self, scope: str, subject: str, limit: int, window_seconds: int = 60) -> bool:
        try:
            return await self._delegate.allow_rate(scope, subject, limit, window_seconds)
        except Exception:
            pass
        key = f"{scope}:{subject}"
        async with self._lock:
            now = time.monotonic()
            count, expires = self._rates.get(key, (0, now + window_seconds))
            if expires <= now:
                count, expires = 0, now + window_seconds
            count += 1
            self._rates[key] = (count, expires)
            return count <= limit

    async def claim_event(self, user_id: str, event_id: str) -> bool:
        try:
            return await self._delegate.claim_event(user_id, event_id)
        except Exception:
            pass
        key = f"{user_id}:{event_id}"
        async with self._lock:
            self._prune_locked()
            if key in self._events:
                return False
            self._events[key] = time.monotonic() + 300
            return True

    async def count_ice_candidate(self, call_id: str, user_id: str) -> bool:
        from app.core.config import settings
        return await self.allow_rate(
            "ice",
            f"{call_id}:{user_id}",
            settings.CALL_ICE_MAX_PER_CALL,
            settings.CALL_RECONNECT_GRACE_SECONDS + 300,
        )

    def pubsub(self):
        return _ResilientPubSub(self._delegate)

    def _ticket_ttl(self) -> int:
        from app.core.config import settings
        return settings.CALL_WS_TICKET_TTL_SECONDS

    def _busy_ttl(self) -> int:
        from app.core.config import settings
        return max(settings.CALL_RING_TIMEOUT_SECONDS + settings.CALL_RECONNECT_GRACE_SECONDS + 3600, 300)

    def _set_busy_locked(self, call_id: str, user_ids: list[str]) -> None:
        expires = time.monotonic() + self._busy_ttl()
        for user_id in user_ids:
            self._busy[user_id] = (call_id, expires)

    def _prune_locked(self) -> None:
        now = time.monotonic()
        self._tickets = {key: value for key, value in self._tickets.items() if value[1] > now}
        self._busy = {key: value for key, value in self._busy.items() if value[1] > now}
        self._rates = {key: value for key, value in self._rates.items() if value[1] > now}
        self._events = {key: value for key, value in self._events.items() if value > now}
