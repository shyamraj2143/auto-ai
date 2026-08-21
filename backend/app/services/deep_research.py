from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from time import perf_counter
from typing import Literal

from fastapi import HTTPException, status

from app.core.config import settings
from app.schemas.chat import ChatRequest
from app.services.groq_service import groq_service

logger = logging.getLogger(__name__)
ResearchProvider = Literal["groq", "openai"]


@dataclass(frozen=True)
class ResearchModelCall:
    provider: ResearchProvider
    model: str


@dataclass
class ResearchModelResult:
    provider: ResearchProvider
    model: str
    content: str
    usage: dict[str, int]
    latency_ms: int
    success: bool
    error: str | None = None


@dataclass
class DeepResearchResult:
    content: str
    usage: dict[str, int]
    selected_model: str
    metadata: dict


class DeepResearchService:
    def run(self, messages: list[dict[str, str]], *, payload: ChatRequest, user_id: str) -> DeepResearchResult:
        calls = self._select_model_calls(payload)
        if not calls:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No deep research provider is configured.")
        max_tokens = max(256, min(settings.DEEP_RESEARCH_MAX_OUTPUT_TOKENS, settings.GROQ_MAX_TOKENS))
        results: list[ResearchModelResult] = []
        with ThreadPoolExecutor(max_workers=len(calls)) as executor:
            futures = [executor.submit(self._call_model, call, messages, max_tokens) for call in calls]
            for future in as_completed(futures):
                results.append(future.result())
        successes = [r for r in results if r.success and r.content.strip()]
        if not successes:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Deep research models could not complete the request.")
        final_content, final_usage, final_model = self._synthesize(messages, successes, payload, max_tokens)
        usage = self._sum_usage([r.usage for r in successes] + [final_usage])
        return DeepResearchResult(final_content, usage, f"deep_research:{final_model}", {"mode": payload.mode, "models_consulted": [{"provider": r.provider, "model": r.model, "latency_ms": r.latency_ms} for r in successes], "models_failed": [{"provider": r.provider, "model": r.model, "error": r.error} for r in results if not r.success], "verified_sources": 0})

    def model_options(self) -> dict:
        return {"providers": {p: {"enabled": self._provider_configured(p), "models": self._configured_models(p)} for p in ("groq", "openai")}, "defaults": {"max_models": settings.DEEP_RESEARCH_DEFAULT_MAX_MODELS, "timeout_seconds": settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS, "final_judge_model": settings.DEEP_RESEARCH_JUDGE_MODEL}}

    def _select_model_calls(self, payload: ChatRequest) -> list[ResearchModelCall]:
        providers = [p for p in (payload.providers or ["groq"]) if p in {"groq", "openai"}]
        requested = {"groq": payload.groq_models, "openai": payload.openai_models}
        calls: list[ResearchModelCall] = []
        max_models = max(1, min(payload.max_models or settings.DEEP_RESEARCH_DEFAULT_MAX_MODELS, 10))
        for provider in providers:
            if not self._provider_configured(provider):
                continue
            configured = self._configured_models(provider)
            selected = [m for m in (requested[provider] or []) if m in configured] or configured
            for model in selected:
                calls.append(ResearchModelCall(provider, model))
                if len(calls) >= max_models:
                    return calls
        return calls

    def _call_model(self, call: ResearchModelCall, messages: list[dict[str, str]], max_tokens: int) -> ResearchModelResult:
        start = perf_counter()
        try:
            content, usage, selected = groq_service.complete(messages, provider=call.provider, model=call.model, max_tokens=max_tokens, request_timeout=settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS)
            return ResearchModelResult(call.provider, selected, content, usage, int((perf_counter() - start) * 1000), bool(content.strip()))
        except Exception as exc:
            return ResearchModelResult(call.provider, call.model, "", {}, int((perf_counter() - start) * 1000), False, str(exc)[:180])

    def _synthesize(self, messages, results, payload, max_tokens):
        original = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        candidates = "\n\n---\n\n".join(f"{r.provider}/{r.model}:\n{r.content[:7000]}" for r in results)
        judge_provider = settings.DEEP_RESEARCH_JUDGE_PROVIDER if settings.DEEP_RESEARCH_JUDGE_PROVIDER in {"groq", "openai"} else "groq"
        configured = self._configured_models(judge_provider)
        judge_model = payload.final_judge_model or settings.DEEP_RESEARCH_JUDGE_MODEL or configured[0]
        judge_messages = [{"role":"system","content":"You are AutoAI's final research synthesizer. Combine candidate reports into one accurate answer, resolve contradictions conservatively, do not invent facts, and answer in the user's language."},{"role":"user","content":f"Request:\n{original[:8000]}\n\nCandidate reports:\n{candidates}"}]
        try:
            return groq_service.complete(judge_messages, provider=judge_provider, model=judge_model, temperature=.15, max_tokens=max_tokens, request_timeout=settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS)
        except Exception:
            best = max(results, key=lambda r: len(r.content))
            return best.content, best.usage, f"{best.provider}/{best.model}"

    @staticmethod
    def _configured_models(provider: ResearchProvider) -> list[str]:
        return list(dict.fromkeys({"groq": settings.GROQ_RESEARCH_MODELS, "openai": settings.OPENAI_RESEARCH_MODELS}[provider]))

    @staticmethod
    def _provider_configured(provider: ResearchProvider) -> bool:
        key = {"groq": settings.groq_api_key, "openai": settings.OPENAI_API_KEY}[provider]
        return bool(key and str(key).strip())

    @staticmethod
    def _sum_usage(usages) -> dict[str, int]:
        return {k: sum(int(u.get(k, 0) or 0) for u in usages) for k in ("prompt_tokens", "completion_tokens", "total_tokens")}


deep_research_service = DeepResearchService()
