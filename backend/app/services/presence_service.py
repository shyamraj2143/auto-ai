from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import settings

logger = logging.getLogger("auto_ai.calls.realtime")

class RealtimeUnavailable(RuntimeError):
    pass

class PresenceService:
    def __init__(self) -> None:
        self._redis: Redis | None = None
        self._local_subscribers: dict[str, set[asyncio.Queue[str]]] = {}

    @property
    def configured(self) -> bool:
        return bool(settings.redis_url)

    def client(self) -> Redis:
        if not settings.redis_url:
            raise RealtimeUnavailable("Redis is required for calls and online presence.")
        if self._redis is None:
            try:
                self._redis = Redis.from_url(settings.redis_url, decode_responses=True, health_check_interval=30, socket_connect_timeout=5, socket_timeout=5)
            except (TypeError, ValueError) as exc:
                raise RealtimeUnavailable("Redis configuration is invalid.") from exc
        return self._redis

    async def check(self, *, log_failure: bool = False) -> bool:
        try:
            return bool(await self.client().ping())
        except (RedisError, RealtimeUnavailable, OSError) as exc:
            client = self._redis
            self._redis = None
            if client is not None:
                try:
                    await client.aclose()
                except Exception:
                    pass
            if log_failure:
                logger.warning("redis_unavailable_local_fallback_active error=%s", type(exc).__name__)
            return False

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def create_ticket(self, user_id: str) -> str:
        ticket = secrets.token_urlsafe(36); key = self._ticket_key(ticket)
        try:
            await self.client().set(key, user_id, ex=settings.CALL_WS_TICKET_TTL_SECONDS)
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None
            raise RealtimeUnavailable("Realtime authentication is temporarily unavailable.") from exc
        return ticket

    async def consume_ticket(self, ticket: str) -> str | None:
        if not ticket or len(ticket) > 256: return None
        try:
            result = await self.client().getdel(self._ticket_key(ticket))
        except (RedisError, RealtimeUnavailable):
            self._redis = None; return None
        return str(result) if result else None

    async def register_connection(self, user_id: str, connection_id: str, state: str = "online") -> None:
        now = datetime.now(timezone.utc).isoformat(); payload = json.dumps({"user_id": user_id, "state": state, "last_seen_at": now}); redis = self.client()
        try:
            async with redis.pipeline(transaction=True) as pipe:
                pipe.set(self._connection_key(connection_id), payload, ex=settings.CALL_PRESENCE_TTL_SECONDS); pipe.sadd(self._connections_key(user_id), connection_id); pipe.expire(self._connections_key(user_id), settings.CALL_PRESENCE_TTL_SECONDS * 2); await pipe.execute()
            await self._publish_presence_update(redis)
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None; raise RealtimeUnavailable("Presence storage is temporarily unavailable.") from exc

    async def heartbeat(self, user_id: str, connection_id: str, state: str | None = None) -> None:
        redis = self.client(); key = self._connection_key(connection_id)
        try:
            raw = await redis.get(key)
            if not raw:
                await self.register_connection(user_id, connection_id, state or "online"); return
            data = json.loads(raw)
            if data.get("user_id") != user_id: raise RealtimeUnavailable("Invalid presence connection ownership.")
            previous_state = data.get("state") or "online"; data["state"] = state or previous_state; data["last_seen_at"] = datetime.now(timezone.utc).isoformat()
            async with redis.pipeline(transaction=True) as pipe:
                pipe.set(key, json.dumps(data), ex=settings.CALL_PRESENCE_TTL_SECONDS); pipe.expire(self._connections_key(user_id), settings.CALL_PRESENCE_TTL_SECONDS * 2); await pipe.execute()
            if data["state"] != previous_state: await self._publish_presence_update(redis)
        except (RedisError, RealtimeUnavailable, ValueError, TypeError) as exc:
            self._redis = None; raise RealtimeUnavailable("Presence heartbeat failed.") from exc

    async def unregister_connection(self, user_id: str, connection_id: str) -> None:
        try:
            async with self.client().pipeline(transaction=True) as pipe:
                pipe.delete(self._connection_key(connection_id)); pipe.srem(self._connections_key(user_id), connection_id); deleted, _ = await pipe.execute()
            if deleted: await self._publish_presence_update(self.client())
        except (RedisError, RealtimeUnavailable):
            self._redis = None

    async def presence_for_user(self, user_id: str) -> dict[str, Any]:
        redis = self.client()
        try:
            connection_ids = list(await redis.smembers(self._connections_key(user_id)))
            if not connection_ids: return {"state": "offline", "last_seen_at": None, "reachable": False}
            values = await redis.mget([self._connection_key(item) for item in connection_ids]); states: list[dict[str, Any]] = []; stale: list[str] = []
            for connection_id, raw in zip(connection_ids, values):
                if not raw: stale.append(connection_id); continue
                try: states.append(json.loads(raw))
                except (ValueError, TypeError): stale.append(connection_id)
            if stale: await redis.srem(self._connections_key(user_id), *stale)
            if not states: return {"state": "offline", "last_seen_at": None, "reachable": False}
            if await redis.exists(self._busy_key(user_id)): state = "busy"
            else:
                order = {"online": 4, "away": 3, "background": 2, "offline": 1}; state = max((str(item.get("state") or "offline") for item in states), key=lambda item: order.get(item, 0))
            last_seen = max((str(item.get("last_seen_at") or "") for item in states), default="") or None
            return {"state": state, "last_seen_at": last_seen, "reachable": True}
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None; raise RealtimeUnavailable("Presence lookup failed.") from exc

    async def presence_for_users(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        return {user_id: await self.presence_for_user(user_id) for user_id in user_ids}

    def subscribe_local(self, user_id: str) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128); self._local_subscribers.setdefault(user_id, set()).add(queue); return queue

    def unsubscribe_local(self, user_id: str, queue: asyncio.Queue[str]) -> None:
        subscribers = self._local_subscribers.get(user_id)
        if not subscribers: return
        subscribers.discard(queue)
        if not subscribers: self._local_subscribers.pop(user_id, None)

    def _publish_local(self, user_id: str, message: str) -> int:
        subscribers = list(self._local_subscribers.get(user_id, set())); delivered = 0
        for queue in subscribers:
            try: queue.put_nowait(message); delivered += 1
            except asyncio.QueueFull:
                try: queue.get_nowait(); queue.put_nowait(message); delivered += 1
                except asyncio.QueueEmpty: continue
        return delivered

    async def publish(self, user_id: str, event: dict[str, Any]) -> int:
        message = json.dumps(event, separators=(",", ":")); local_receivers = self._publish_local(user_id, message)
        try: return max(local_receivers, int(await self.client().publish(self._user_channel(user_id), message)))
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None
            if local_receivers:
                logger.warning("redis_publish_failed_local_delivery_used error=%s", type(exc).__name__); return local_receivers
            raise RealtimeUnavailable("Signaling delivery failed.") from exc

    async def acquire_call_locks(self, call_id: str, caller_id: str, callee_id: str) -> bool:
        script = "if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2]); return 1"; ttl = max(settings.CALL_RING_TIMEOUT_SECONDS + settings.CALL_RECONNECT_GRACE_SECONDS + 3600, 300)
        try: return bool(await self.client().eval(script, 2, self._busy_key(caller_id), self._busy_key(callee_id), call_id, ttl))
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None; logger.warning("call_lock_acquire_failed_local_fallback_available error=%s", type(exc).__name__); raise RealtimeUnavailable("Call locking failed.") from exc

    async def refresh_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end return 0"; ttl = max(settings.CALL_RECONNECT_GRACE_SECONDS + 3600, 300)
        try:
            for user_id in user_ids: await self.client().eval(script, 1, self._busy_key(user_id), call_id, ttl)
        except RedisError: self._redis = None

    async def release_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        script = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0"
        try:
            for user_id in user_ids: await self.client().eval(script, 1, self._busy_key(user_id), call_id)
        except (RedisError, RealtimeUnavailable): self._redis = None

    async def allow_rate(self, scope: str, subject: str, limit: int, window_seconds: int = 60) -> bool:
        key = f"calls:rate:{scope}:{subject}"
        try:
            value = int(await self.client().incr(key));
            if value == 1: await self.client().expire(key, window_seconds)
            return value <= limit
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None; raise RealtimeUnavailable("Rate limiting is temporarily unavailable.") from exc

    async def claim_event(self, user_id: str, event_id: str) -> bool:
        try: return bool(await self.client().set(f"calls:event:{user_id}:{event_id}", "1", ex=300, nx=True))
        except (RedisError, RealtimeUnavailable) as exc:
            self._redis = None; raise RealtimeUnavailable("Signaling deduplication failed.") from exc

    async def count_ice_candidate(self, call_id: str, user_id: str) -> bool:
        return await self.allow_rate("ice", f"{call_id}:{user_id}", settings.CALL_ICE_MAX_PER_CALL, settings.CALL_RECONNECT_GRACE_SECONDS + 300)

    def pubsub(self): return self.client().pubsub(ignore_subscribe_messages=True)

    async def _publish_presence_update(self, redis: Redis) -> None:
        event = {"schema_version": 1, "event_id": secrets.token_urlsafe(18), "type": "presence.user_updated", "call_id": None, "sender_user_id": None, "timestamp": datetime.now(timezone.utc).isoformat(), "payload": {}}
        await redis.publish(self._presence_channel(), json.dumps(event, separators=(",", ":")))

    @staticmethod
    def _ticket_key(ticket: str) -> str: return f"calls:ws_ticket:{hashlib.sha256(ticket.encode('utf-8')).hexdigest()}"
    @staticmethod
    def _connection_key(connection_id: str) -> str: return f"calls:connection:{connection_id}"
    @staticmethod
    def _connections_key(user_id: str) -> str: return f"calls:user_connections:{user_id}"
    @staticmethod
    def _busy_key(user_id: str) -> str: return f"calls:busy:{user_id}"
    @staticmethod
    def _user_channel(user_id: str) -> str: return f"calls:user:{user_id}"
    @staticmethod
    def _presence_channel() -> str: return "calls:presence"

from app.services.presence_fallback import ResilientPresenceService
presence_service = ResilientPresenceService(PresenceService())
