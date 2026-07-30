from __future__ import annotations

import threading
from collections import defaultdict
from time import monotonic

from fastapi import HTTPException

from app.core.config import settings


class ResilienceManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._failures: dict[str, int] = defaultdict(int)
        self._opened_at: dict[str, float] = {}

    def available(self, key: str) -> bool:
        with self._lock:
            opened = self._opened_at.get(key)
            if opened is None:
                return True
            if monotonic() - opened >= settings.ORCHESTRATION_CIRCUIT_COOLDOWN_SECONDS:
                self._failures[key] = 0
                self._opened_at.pop(key, None)
                return True
            return False

    def success(self, key: str) -> None:
        with self._lock:
            self._failures[key] = 0
            self._opened_at.pop(key, None)

    def failure(self, key: str) -> None:
        with self._lock:
            self._failures[key] += 1
            if self._failures[key] >= settings.ORCHESTRATION_CIRCUIT_FAILURE_THRESHOLD:
                self._opened_at[key] = monotonic()

    @staticmethod
    def retryable(exc: Exception) -> bool:
        if isinstance(exc, HTTPException):
            return exc.status_code in {408, 429, 500, 502, 503, 504}
        return isinstance(exc, (TimeoutError, ConnectionError))

    @staticmethod
    def classify(exc: Exception) -> str:
        if isinstance(exc, TimeoutError):
            return "timeout"
        if isinstance(exc, HTTPException):
            return {
                401: "authentication",
                403: "permission",
                404: "unsupported_model",
                429: "rate_limited",
                503: "unavailable",
                504: "timeout",
            }.get(exc.status_code, "provider_error")
        return "provider_error"


resilience_manager = ResilienceManager()
