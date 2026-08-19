from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.services.orchestration.model_registry import model_registry
from app.services.web_search_service import web_search_service

logger = logging.getLogger("auto_ai.self_engine")

RESEARCH_TOPICS = (
    "NVIDIA NIM vision language models API latest documentation model availability",
    "Groq API latest vision models multimodal documentation model availability",
    "FastAPI SQLAlchemy Pydantic security performance latest stable releases",
    "browser mobile PWA WebView chat input accessibility performance latest guidance",
)


class SelfDevelopmentEngine:
    """Bounded autonomous improvement loop.

    It researches public technical changes, refreshes the model registry and records
    improvement candidates. It never executes arbitrary generated source code or
    deploys an unreviewed code change.
    """

    VERSION = "AutoAI-SelfEngine-v1"

    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    @property
    def state_path(self) -> Path:
        return Path(settings.UPLOAD_DIR) / "self-engine" / "state.json"

    def _read_state(self) -> dict[str, Any]:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {"version": self.VERSION, "runs": 0, "findings": [], "proposals": []}

    def _write_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def run_once(self) -> dict[str, Any]:
        state = self._read_state()
        findings: list[dict[str, Any]] = []
        proposals: list[dict[str, Any]] = []

        try:
            model_registry.refresh(force=True)
            registry_status = "refreshed"
        except Exception as exc:
            registry_status = f"refresh_failed: {type(exc).__name__}"
            logger.warning("self_engine model registry refresh failed: %s", exc)

        for topic in RESEARCH_TOPICS:
            try:
                results = web_search_service.search(topic, limit=5, timeout=10)
                for result in results:
                    findings.append({"topic": topic, "title": result.get("title", "")[:240], "url": result.get("url", "")})
            except Exception as exc:
                logger.warning("self_engine research failed for %s: %s", topic, exc)

        if findings:
            proposals.extend([
                {
                    "type": "provider_review",
                    "title": "Review current AI provider/model changes",
                    "reason": f"Self-engine found {len(findings)} current technical sources.",
                    "action": "Validate model IDs, vision capabilities, limits and fallbacks before changing production routing.",
                    "requires_approval": True,
                },
                {
                    "type": "performance_review",
                    "title": "Review mobile chat latency and failure rates",
                    "reason": "Self-engine continuously watches current platform guidance and provider changes.",
                    "action": "Use observed telemetry to tune timeouts, concurrency and healthy-model routing.",
                    "requires_approval": True,
                },
            ])

        state.update({
            "version": self.VERSION,
            "runs": int(state.get("runs", 0)) + 1,
            "last_run_at": datetime.now(timezone.utc).isoformat(),
            "registry_status": registry_status,
            "findings": findings[:40],
            "proposals": proposals[:20],
        })
        self._write_state(state)
        return state

    async def run_loop(self, stop_event: asyncio.Event) -> None:
        interval = max(900, int(getattr(settings, "SELF_ENGINE_INTERVAL_SECONDS", 21600)))
        while not stop_event.is_set():
            try:
                async with self._lock:
                    await asyncio.to_thread(self.run_once)
            except Exception:
                logger.exception("self_engine cycle failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval)
            except TimeoutError:
                continue

    def snapshot(self) -> dict[str, Any]:
        state = self._read_state()
        state["enabled"] = bool(getattr(settings, "SELF_ENGINE_ENABLED", True))
        state["version"] = self.VERSION
        return state


self_development_engine = SelfDevelopmentEngine()
