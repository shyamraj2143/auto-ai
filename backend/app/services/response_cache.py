from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict
from time import time
from typing import Any

from app.core.config import settings


logger = logging.getLogger("auto_ai.response_cache")


class ResponseCache:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._local: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self._redis = None
        if settings.redis_url:
            try:
                import redis

                self._redis = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=1)
            except Exception as exc:
                logger.warning("response_cache_redis_init_failed error_type=%s", type(exc).__name__)

    @staticmethod
    def key(*, user_id: str, provider: str, model: str, messages: list[dict[str, Any]], settings_payload: dict[str, Any]) -> str:
        canonical = json.dumps(
            {"v": 1, "user_id": user_id, "provider": provider, "model": model, "messages": messages, "settings": settings_payload},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def get(self, key: str) -> dict[str, Any] | None:
        if not settings.RESPONSE_CACHE_ENABLED:
            return None
        if self._redis is not None:
            try:
                raw = self._redis.get(f"autoai:chat-cache:{key}")
                if raw:
                    value = json.loads(raw)
                    return value if isinstance(value, dict) else None
            except Exception as exc:
                logger.warning("response_cache_redis_read_failed error_type=%s", type(exc).__name__)
                self._redis = None
        now = time()
        with self._lock:
            entry = self._local.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if expires_at <= now:
                self._local.pop(key, None)
                return None
            self._local.move_to_end(key)
            return dict(value)

    def set(self, key: str, value: dict[str, Any]) -> None:
        if not settings.RESPONSE_CACHE_ENABLED:
            return
        safe = {
            "content": str(value.get("content") or ""),
            "model": str(value.get("model") or ""),
            "usage": {name: max(0, int(amount or 0)) for name, amount in dict(value.get("usage") or {}).items() if name in {"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"}},
        }
        if not safe["content"] or len(safe["content"]) > settings.RESPONSE_CACHE_MAX_ITEM_CHARS:
            return
        if self._redis is not None:
            try:
                self._redis.setex(f"autoai:chat-cache:{key}", settings.RESPONSE_CACHE_TTL_SECONDS, json.dumps(safe, ensure_ascii=False))
                return
            except Exception as exc:
                logger.warning("response_cache_redis_write_failed error_type=%s", type(exc).__name__)
                self._redis = None
        with self._lock:
            self._local[key] = (time() + settings.RESPONSE_CACHE_TTL_SECONDS, safe)
            self._local.move_to_end(key)
            while len(self._local) > settings.RESPONSE_CACHE_MAX_ENTRIES:
                self._local.popitem(last=False)

    @property
    def backend(self) -> str:
        if not settings.RESPONSE_CACHE_ENABLED:
            return "disabled"
        return "redis" if self._redis is not None else "memory"


response_cache = ResponseCache()
