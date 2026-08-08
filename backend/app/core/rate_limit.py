from __future__ import annotations

import hashlib
import json
import logging
from collections import defaultdict, deque
from math import ceil
from time import monotonic, time
from typing import Deque

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.core.config import settings


logger = logging.getLogger("auto_ai.rate_limit")


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Route-aware per-IP and per-session limiter with optional shared Redis counters."""

    def __init__(self, app, limit_per_minute: int | None = None) -> None:
        super().__init__(app)
        self.window_seconds = 60
        self.limit_override = limit_per_minute
        self.requests: dict[str, Deque[float]] = defaultdict(deque)
        self._redis = None
        if settings.redis_url:
            try:
                import redis.asyncio as redis

                self._redis = redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=1)
            except Exception as exc:
                logger.warning("rate_limit_redis_init_failed error_type=%s", type(exc).__name__)

    @staticmethod
    def _policy(path: str, method: str) -> tuple[str, int]:
        normalized = path.rstrip("/")
        policies = (
            ("auth_login", settings.RATE_LIMIT_LOGIN_PER_MINUTE, normalized.endswith("/auth/login") or normalized.endswith("/agent/login")),
            ("auth_register", settings.RATE_LIMIT_REGISTER_PER_MINUTE, normalized.endswith("/auth/register")),
            ("password_reset", settings.RATE_LIMIT_PASSWORD_RESET_PER_MINUTE, "/auth/password/" in normalized),
            ("ai_generation", settings.RATE_LIMIT_AI_PER_MINUTE, method == "POST" and ("/ai/" in normalized or normalized.endswith("/ai/chat"))),
            ("payments", settings.RATE_LIMIT_PAYMENT_PER_MINUTE, method != "GET" and ("/payments" in normalized or "/billing/" in normalized)),
            ("admin", settings.RATE_LIMIT_ADMIN_PER_MINUTE, method != "GET" and "/admin" in normalized),
            ("backup_restore", settings.RATE_LIMIT_RESTORE_PER_MINUTE, method == "POST" and "/user-data/restore" in normalized),
            ("uploads", settings.RATE_LIMIT_UPLOAD_PER_MINUTE, method == "POST" and any(part in normalized for part in ("/documents", "/upload", "/image-analysis"))),
        )
        for name, limit, matched in policies:
            if matched:
                return name, limit
        return "default", settings.RATE_LIMIT_PER_MINUTE

    @staticmethod
    def _identity(request: Request) -> tuple[str, str]:
        # Uvicorn resolves trusted proxy headers into request.client. Reading a
        # caller-supplied X-Forwarded-For value here would make limits spoofable.
        ip = request.client.host if request.client else "unknown"
        auth = request.headers.get("authorization", "")
        session = hashlib.sha256(auth.encode("utf-8")).hexdigest()[:20] if auth else "anonymous"
        return ip[:80], session

    async def _redis_count(self, key: str) -> tuple[int, int] | None:
        if self._redis is None:
            return None
        try:
            redis_key = f"autoai:rate:{int(time()) // self.window_seconds}:{key}"
            count = int(await self._redis.incr(redis_key))
            if count == 1:
                await self._redis.expire(redis_key, self.window_seconds + 2)
            ttl = int(await self._redis.ttl(redis_key))
            return count, max(ttl, 1)
        except Exception as exc:
            logger.warning("rate_limit_redis_unavailable error_type=%s", type(exc).__name__)
            self._redis = None
            return None

    def _local_count(self, key: str) -> tuple[int, int]:
        now = monotonic()
        bucket = self.requests[key]
        while bucket and now - bucket[0] >= self.window_seconds:
            bucket.popleft()
        bucket.append(now)
        retry_after = ceil(self.window_seconds - (now - bucket[0])) if bucket else self.window_seconds
        if len(self.requests) > 20_000:
            for stale_key in list(self.requests)[:2_000]:
                if not self.requests[stale_key] or now - self.requests[stale_key][-1] >= self.window_seconds:
                    self.requests.pop(stale_key, None)
        return len(bucket), max(retry_after, 1)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method == "OPTIONS" or request.url.path in {"/health", "/ready", "/api/v1/health", "/api/v1/ready"}:
            return await call_next(request)
        category, limit = self._policy(request.url.path, request.method.upper())
        if self.limit_override is not None:
            limit = self.limit_override
        ip, session = self._identity(request)
        keys = (f"{category}:ip:{ip}", f"{category}:session:{session}") if session != "anonymous" else (f"{category}:ip:{ip}",)
        results = []
        for key in keys:
            result = await self._redis_count(key)
            results.append(result if result is not None else self._local_count(key))
        count, retry_after = max(results, key=lambda item: item[0])
        remaining = max(limit - count, 0)
        headers = {
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": str(remaining),
            "X-RateLimit-Policy": category,
        }
        if count > limit:
            headers["Retry-After"] = str(retry_after)
            request_id = getattr(request.state, "request_id", None)
            return Response(
                content=json.dumps({"detail": "Too many requests. Try again after the indicated delay.", "retry_after": retry_after, "request_id": request_id}),
                status_code=429,
                media_type="application/json",
                headers=headers,
            )
        response = await call_next(request)
        response.headers.update(headers)
        return response


InMemoryRateLimitMiddleware = RateLimitMiddleware
