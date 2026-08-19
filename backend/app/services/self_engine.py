from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.db.session import SessionLocal
from app.services.orchestration.model_registry import model_registry
from app.services.web_search import web_search_service

logger = logging.getLogger("auto_ai.self_engine")

RESEARCH_TOPICS = (
    "NVIDIA NIM vision language models API latest documentation model availability",
    "Groq API latest vision models multimodal documentation model availability",
    "FastAPI SQLAlchemy Pydantic security performance latest stable releases",
    "browser mobile PWA WebView chat input accessibility performance latest guidance",
)


class SelfDevelopmentEngine:
    """Bounded autonomous improvement loop.

    It continuously researches public technical changes, refreshes the model registry,
    records improvement candidates, and adapts routing/profile signals. It deliberately
    does not execute arbitrary generated source code or deploy unreviewed code changes.
    """

    VERSION = "AutoAI-SelfEngine-v1"

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._last_run: str | None = None

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

        # Keep model metadata fresh without waiting for a user request.
        try:
            model_registry.refresh(force=True)
            registry_status = "refreshed"
        except Exception as exc:  # pragma: no cover - provider/registry dependent
            registry_status = f"refresh_failed: {type(exc).__name__}"
            logger.warning("self_engine model registry refresh failed: %s", exc)

        with SessionLocal() as db:
            for topic in RESEARCH_TOPICS:
                try:
                    bundle = web_search_service.execute(
                        db,
                        user_id="self-engine",
                        query=topic,
                        mode="research",
                        record_history=False,
                    )
                    for source in bundle.sources[:5]:
                        findings.append({
                            "topic": topic,
                            "title": source.title,
                            "url": source.url,
                            "source": source.source,
                            "confidence": source.credibility_score,
                            "snippet": source.snippet[:700],
                        })
                except Exception as exc:  # keep one provider/search failure from stopping the loop
                    logger.warning("self_engine research failed for %s: %s", topic, exc)

        if findings:
            domains = sorted({item["source"] for item in findings if item.get("source")})
            proposals.extend([
                {
                    "type": "dependency_or_api_review",
                    "title": "Review current AI provider/model changes",
                    "reason": f"Self-engine found {len(findings)} current technical sources across {len(domains)} domains.",
                    "action": "Validate provider model IDs, vision capabilities, limits and fallbacks before changing production routing.",
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
        self._last_run = state["last_run_at"]
        return state

    async def run_loop(self, stop_event: asyncio.Event) -> None:
        interval = max(900, int(settings.SELF_ENGINE_INTERVAL_SECONDS))
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
        state["enabled"] = bool(settings.SELF_ENGINE_ENABLED)
        state["version"] = self.VERSION
        return state


self_development_engine = SelfDevelopmentEngine()
