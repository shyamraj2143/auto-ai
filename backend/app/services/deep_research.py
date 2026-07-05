from __future__ import annotations

import logging
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError, as_completed
from dataclasses import dataclass
from time import monotonic, perf_counter
from typing import Deque, Literal

from fastapi import HTTPException, status

from app.core.config import settings
from app.schemas.chat import ChatRequest
from app.services.groq_service import groq_service


logger = logging.getLogger(__name__)

ResearchProvider = Literal["groq", "bedrock", "openai", "gemini"]
DEPRECATED_MODEL_REPLACEMENTS = {
    "deepseek-r1-distill-llama-70b": "llama-3.3-70b-versatile",
}
PLACEHOLDER_SECRET_PREFIXES = ("your-", "change-me", "changeme")


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
    def __init__(self) -> None:
        self._requests: dict[str, Deque[float]] = defaultdict(deque)
        self._window_seconds = 60

    def run(
        self,
        messages: list[dict[str, str]],
        *,
        payload: ChatRequest,
        user_id: str,
    ) -> DeepResearchResult:
        self._check_rate_limit(user_id)
        model_calls = self._select_model_calls(payload)
        timeout_seconds = self._timeout_seconds(payload)
        max_output_tokens = self._max_output_tokens()
        messages = self._truncate_messages(
            messages,
            self._input_token_budget(model_calls, max_output_tokens),
        )

        results = self._collect_model_results(
            model_calls,
            messages,
            timeout_seconds=timeout_seconds,
            max_output_tokens=max_output_tokens,
        )
        successes = [result for result in results if result.success and result.content.strip()]
        failures = [result for result in results if not result.success]

        if not successes:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Deep research failed because all configured models were unavailable. Try normal mode or reduce the request size.",
            )

        final_content, judge_usage, judge_model = self._synthesize(
            messages,
            successes,
            payload=payload,
            timeout_seconds=timeout_seconds,
            max_output_tokens=max_output_tokens,
        )
        usage = self._sum_usage([result.usage for result in successes] + [judge_usage])
        selected_model = f"deep_research:{judge_model}"
        metadata = {
            "mode": payload.mode,
            "models_consulted": [
                {
                    "provider": result.provider,
                    "model": result.model,
                    "latency_ms": result.latency_ms,
                }
                for result in successes
            ],
            "model_failures": [
                {
                    "provider": result.provider,
                    "model": result.model,
                    "error": result.error or "Model request failed.",
                }
                for result in failures
            ],
            "judge_model": judge_model,
            "confidence": self._confidence_label(len(successes), len(results)),
        }
        return DeepResearchResult(
            content=final_content,
            usage=usage,
            selected_model=selected_model,
            metadata=metadata,
        )

    def _check_rate_limit(self, user_id: str) -> None:
        now = monotonic()
        bucket = self._requests[user_id]
        while bucket and now - bucket[0] > self._window_seconds:
            bucket.popleft()
        if len(bucket) >= settings.DEEP_RESEARCH_RATE_LIMIT_PER_MINUTE:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Deep research rate limit exceeded. Please wait before trying again.",
            )
        bucket.append(now)

    def _select_model_calls(self, payload: ChatRequest) -> list[ResearchModelCall]:
        providers = payload.providers or ["groq", "bedrock"]
        requested: dict[ResearchProvider, list[str]] = {
            "groq": payload.groq_models,
            "bedrock": payload.bedrock_models,
            "openai": payload.openai_models,
            "gemini": payload.gemini_models,
        }
        grouped_calls: dict[ResearchProvider, list[ResearchModelCall]] = {}

        for provider in providers:
            if provider not in {"groq", "bedrock", "openai", "gemini"}:
                continue
            if not self._provider_configured(provider):
                continue

            configured_models = self._configured_models(provider)
            if not configured_models:
                continue
            selected = self._unique_models(requested[provider])
            allowed = {model for model in configured_models}
            valid_models = [model for model in selected if model in allowed]
            if not valid_models:
                valid_models = configured_models

            provider_calls: list[ResearchModelCall] = []
            for model in selected:
                if model in allowed:
                    provider_calls.append(ResearchModelCall(provider=provider, model=model))
            if not provider_calls:
                provider_calls = [ResearchModelCall(provider=provider, model=model) for model in valid_models]
            grouped_calls[provider] = provider_calls

        limit = settings.DEEP_RESEARCH_MAX_MODELS if payload.all_models else self._max_models(payload)
        calls = self._balanced_model_calls(
            grouped_calls,
            providers,
            max(1, min(limit, settings.DEEP_RESEARCH_MAX_MODELS)),
        )
        if not calls:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="No configured research models are available for Groq, Bedrock, OpenAI, or Gemini.",
            )
        return calls

    def model_options(self) -> dict:
        return {
            "providers": {
                "groq": {
                    "enabled": self._provider_configured("groq"),
                    "models": self._configured_models("groq"),
                },
                "bedrock": {
                    "enabled": self._provider_configured("bedrock"),
                    "models": self._configured_models("bedrock"),
                },
                "openai": {
                    "enabled": self._provider_configured("openai"),
                    "models": self._configured_models("openai"),
                },
                "gemini": {
                    "enabled": self._provider_configured("gemini"),
                    "models": self._configured_models("gemini"),
                },
            },
            "defaults": {
                "max_models": settings.DEEP_RESEARCH_DEFAULT_MAX_MODELS,
                "timeout_seconds": settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS,
                "final_judge_model": settings.DEEP_RESEARCH_JUDGE_MODEL,
            },
        }

    @staticmethod
    def _secret_configured(value: str | None) -> bool:
        normalized = (value or "").strip()
        if not normalized or normalized.lower() in {"none", "null"}:
            return False
        return not normalized.lower().startswith(PLACEHOLDER_SECRET_PREFIXES)

    def _provider_configured(self, provider: ResearchProvider) -> bool:
        if provider == "groq":
            return self._secret_configured(settings.groq_api_key)
        if provider == "bedrock":
            return self._secret_configured(settings.bedrock_api_key) or (
            self._secret_configured(settings.aws_access_key_id)
            and self._secret_configured(settings.aws_secret_access_key)
            )
        if provider == "openai":
            return self._secret_configured(settings.OPENAI_API_KEY)
        return self._secret_configured(settings.GEMINI_API_KEY)

    @staticmethod
    def _unique_models(models: list[str]) -> list[str]:
        selected: list[str] = []
        seen: set[str] = set()
        for raw_model in models:
            model = DEPRECATED_MODEL_REPLACEMENTS.get(raw_model.strip(), raw_model.strip())
            if model and model not in seen:
                selected.append(model)
                seen.add(model)
        return selected

    @classmethod
    def _configured_models(cls, provider: ResearchProvider) -> list[str]:
        models_by_provider = {
            "groq": settings.GROQ_RESEARCH_MODELS,
            "bedrock": settings.BEDROCK_RESEARCH_MODELS,
            "openai": settings.OPENAI_RESEARCH_MODELS,
            "gemini": settings.GEMINI_RESEARCH_MODELS,
        }
        models = models_by_provider[provider]
        return cls._unique_models(models)

    @staticmethod
    def _balanced_model_calls(
        grouped_calls: dict[ResearchProvider, list[ResearchModelCall]],
        providers: list[ResearchProvider],
        limit: int,
    ) -> list[ResearchModelCall]:
        calls: list[ResearchModelCall] = []
        index = 0
        while len(calls) < limit:
            added = False
            for provider in providers:
                provider_calls = grouped_calls.get(provider, [])
                if index >= len(provider_calls):
                    continue
                calls.append(provider_calls[index])
                added = True
                if len(calls) >= limit:
                    return calls
            if not added:
                return calls
            index += 1
        return calls

    @staticmethod
    def _max_models(payload: ChatRequest) -> int:
        configured = payload.max_models or settings.DEEP_RESEARCH_DEFAULT_MAX_MODELS
        return max(1, min(configured, settings.DEEP_RESEARCH_MAX_MODELS))

    @staticmethod
    def _timeout_seconds(payload: ChatRequest) -> int:
        configured = payload.timeout_seconds or settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS
        return max(5, min(configured, 120))

    @staticmethod
    def _max_output_tokens() -> int:
        return max(256, min(settings.DEEP_RESEARCH_MAX_OUTPUT_TOKENS, settings.GROQ_MAX_TOKENS))

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        return max(1, (len(text) + 3) // 4)

    def _message_tokens(self, message: dict[str, str]) -> int:
        return self._estimate_tokens(str(message.get("content") or "")) + 6

    def _input_token_budget(self, model_calls: list[ResearchModelCall], max_output_tokens: int) -> int:
        groq_count = sum(1 for call in model_calls if call.provider == "groq")
        if not groq_count:
            return settings.DEEP_RESEARCH_MAX_INPUT_TOKENS

        available = settings.DEEP_RESEARCH_GROQ_TPM_BUDGET - (groq_count * max_output_tokens)
        per_groq_prompt = max(1200, available // groq_count)
        return max(1200, min(settings.DEEP_RESEARCH_MAX_INPUT_TOKENS, per_groq_prompt))

    @staticmethod
    def _clip_text(text: str, max_chars: int) -> str:
        if len(text) <= max_chars:
            return text
        head = max_chars // 2
        tail = max_chars - head
        return f"{text[:head]}\n\n[...context truncated for deep research token safety...]\n\n{text[-tail:]}"

    def _truncate_messages(self, messages: list[dict[str, str]], max_input_tokens: int) -> list[dict[str, str]]:
        trimmed = [{"role": item["role"], "content": str(item.get("content") or "")} for item in messages]

        while sum(self._message_tokens(item) for item in trimmed) > max_input_tokens and len(trimmed) > 2:
            removable_index = next(
                (
                    index
                    for index, item in enumerate(trimmed[:-1])
                    if index > 0 and item.get("role") != "system"
                ),
                None,
            )
            if removable_index is None:
                break
            trimmed.pop(removable_index)

        if sum(self._message_tokens(item) for item in trimmed) <= max_input_tokens:
            return trimmed

        for index, item in enumerate(trimmed):
            if item["role"] == "system":
                item["content"] = self._clip_text(item["content"], 3000)
            elif index < len(trimmed) - 1:
                item["content"] = self._clip_text(item["content"], 1600)
            else:
                item["content"] = self._clip_text(item["content"], 8000)

        return trimmed

    def _collect_model_results(
        self,
        model_calls: list[ResearchModelCall],
        messages: list[dict[str, str]],
        *,
        timeout_seconds: int,
        max_output_tokens: int,
    ) -> list[ResearchModelResult]:
        executor = ThreadPoolExecutor(max_workers=len(model_calls))
        futures = {
            executor.submit(
                self._call_model,
                call,
                messages,
                timeout_seconds=timeout_seconds,
                max_output_tokens=max_output_tokens,
            ): call
            for call in model_calls
        }
        results: list[ResearchModelResult] = []

        try:
            for future in as_completed(futures, timeout=timeout_seconds + 1):
                results.append(future.result())
        except TimeoutError:
            pass
        finally:
            for future, call in futures.items():
                if future.done():
                    continue
                future.cancel()
                results.append(
                    ResearchModelResult(
                        provider=call.provider,
                        model=call.model,
                        content="",
                        usage={},
                        latency_ms=timeout_seconds * 1000,
                        success=False,
                        error="Timed out.",
                    )
                )
                logger.warning(
                    "deep_research_model_timeout provider=%s model=%s timeout_seconds=%s",
                    call.provider,
                    call.model,
                    timeout_seconds,
                )
            executor.shutdown(wait=False, cancel_futures=True)

        return results

    def _call_model(
        self,
        call: ResearchModelCall,
        messages: list[dict[str, str]],
        *,
        timeout_seconds: int,
        max_output_tokens: int,
    ) -> ResearchModelResult:
        start = perf_counter()
        try:
            content, usage, selected_model = groq_service.complete(
                messages,
                provider=call.provider,
                model=call.model,
                max_tokens=max_output_tokens,
                request_timeout=timeout_seconds,
                allow_bedrock_fallback=False,
            )
            latency_ms = int((perf_counter() - start) * 1000)
            logger.info(
                "deep_research_model_result provider=%s model=%s selected_model=%s latency_ms=%s success=true",
                call.provider,
                call.model,
                selected_model,
                latency_ms,
            )
            return ResearchModelResult(
                provider=call.provider,
                model=selected_model,
                content=content,
                usage=usage,
                latency_ms=latency_ms,
                success=bool(content.strip()),
                error=None if content.strip() else "Empty response.",
            )
        except Exception as exc:
            latency_ms = int((perf_counter() - start) * 1000)
            logger.warning(
                "deep_research_model_result provider=%s model=%s latency_ms=%s success=false error_type=%s",
                call.provider,
                call.model,
                latency_ms,
                type(exc).__name__,
            )
            return ResearchModelResult(
                provider=call.provider,
                model=call.model,
                content="",
                usage={},
                latency_ms=latency_ms,
                success=False,
                error=self._safe_error(exc),
            )

    def _synthesize(
        self,
        messages: list[dict[str, str]],
        successes: list[ResearchModelResult],
        *,
        payload: ChatRequest,
        timeout_seconds: int,
        max_output_tokens: int,
    ) -> tuple[str, dict[str, int], str]:
        judge_provider = self._judge_provider(successes)
        judge_model = self._judge_model(payload, judge_provider, successes)
        judge_messages = self._judge_messages(messages, successes)
        try:
            content, usage, selected_model = groq_service.complete(
                judge_messages,
                provider=judge_provider,
                model=judge_model,
                temperature=0.15,
                max_tokens=max_output_tokens,
                request_timeout=timeout_seconds,
                allow_bedrock_fallback=False,
            )
            logger.info(
                "deep_research_judge_result provider=%s model=%s selected_model=%s success=true",
                judge_provider,
                judge_model,
                selected_model,
            )
            return content.strip(), usage, f"{judge_provider}/{selected_model}"
        except Exception as exc:
            logger.warning(
                "deep_research_judge_result provider=%s model=%s success=false error_type=%s",
                judge_provider,
                judge_model,
                type(exc).__name__,
            )
            best = max(successes, key=lambda result: len(result.content))
            return best.content.strip(), best.usage, f"{best.provider}/{best.model}"

    @staticmethod
    def _judge_provider(successes: list[ResearchModelResult]) -> ResearchProvider:
        configured = settings.DEEP_RESEARCH_JUDGE_PROVIDER.lower()
        if configured in {"groq", "bedrock", "openai", "gemini"}:
            provider = configured
            if any(result.provider == provider for result in successes):
                return provider  # type: ignore[return-value]
        return successes[0].provider

    @staticmethod
    def _judge_model(
        payload: ChatRequest,
        provider: ResearchProvider,
        successes: list[ResearchModelResult],
    ) -> str:
        configured = payload.final_judge_model or settings.DEEP_RESEARCH_JUDGE_MODEL
        allowed_models = DeepResearchService._configured_models(provider)
        if configured and configured in allowed_models:
            return configured
        for result in successes:
            if result.provider == provider:
                return result.model
        return allowed_models[0] if allowed_models else successes[0].model

    def _judge_messages(
        self,
        messages: list[dict[str, str]],
        successes: list[ResearchModelResult],
    ) -> list[dict[str, str]]:
        user_prompt = next((item["content"] for item in reversed(messages) if item["role"] == "user"), "")
        response_blocks = []
        for index, result in enumerate(successes, start=1):
            response_blocks.append(
                "\n".join(
                    [
                        f"Model {index}: {result.provider}/{result.model}",
                        self._clip_text(result.content, 6000),
                    ]
                )
            )
        return [
            {
                "role": "system",
                "content": (
                    "You are Auto-AI's final deep research judge. Compare the candidate model answers for factual correctness, "
                    "remove hallucinations, combine the strongest points, mention uncertainty when needed, and produce one concise, useful final answer. "
                    "Do not expose internal scoring or raw model-by-model notes."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Original user request:\n{self._clip_text(user_prompt, 6000)}\n\n"
                    "Candidate responses:\n\n"
                    + "\n\n---\n\n".join(response_blocks)
                ),
            },
        ]

    @staticmethod
    def _sum_usage(usages: list[dict[str, int]]) -> dict[str, int]:
        return {
            "prompt_tokens": sum(int(usage.get("prompt_tokens", 0) or 0) for usage in usages),
            "completion_tokens": sum(int(usage.get("completion_tokens", 0) or 0) for usage in usages),
            "total_tokens": sum(int(usage.get("total_tokens", 0) or 0) for usage in usages),
        }

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        if isinstance(exc, HTTPException):
            if exc.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
                return "Rate limited."
            if exc.status_code == status.HTTP_401_UNAUTHORIZED:
                return "Authentication failed."
            if exc.status_code == status.HTTP_503_SERVICE_UNAVAILABLE:
                return "Provider not configured."
            if exc.status_code in {status.HTTP_400_BAD_REQUEST, status.HTTP_404_NOT_FOUND}:
                return "Model unavailable or not allowed."
            if exc.status_code == status.HTTP_403_FORBIDDEN:
                return "Provider permission denied."
        if isinstance(exc, TimeoutError):
            return "Timed out."
        return "Model request failed."

    @staticmethod
    def _confidence_label(success_count: int, attempted_count: int) -> str:
        if success_count >= 3:
            return "high"
        if success_count >= 2 or success_count == attempted_count:
            return "medium"
        return "low"


deep_research_service = DeepResearchService()
