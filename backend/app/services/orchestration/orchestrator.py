from __future__ import annotations

import logging
import os
from time import perf_counter

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.groq_service import groq_service
from app.services.nvidia_text_service import nvidia_text_service
from app.services.orchestration.citation_verifier import citation_verifier
from app.services.orchestration.parallel_executor import parallel_executor
from app.services.orchestration.request_analyzer import request_analyzer
from app.services.orchestration.response_synthesizer import response_synthesizer
from app.services.orchestration.schemas import ActivityCallback, CancelCallback, IntelligenceMode, OrchestrationResult, SynthesisCallback, TaskStatus
from app.services.orchestration.task_planner import task_planner

logger = logging.getLogger("auto_ai.orchestration")


def _direct_fallback(messages: list[dict[str, str]], tasks: list) -> tuple[str, dict[str, int], str, str]:
    """Return a usable answer using only the configured Groq/NVIDIA providers."""
    candidates: list[tuple[str, str]] = []
    for task in tasks:
        provider = task.model.provider
        model = task.model.actual_model_id
        if provider in {"groq", "nvidia"} and model:
            candidates.append((provider, model))

    candidates.extend(
        [
            ("groq", settings.GROQ_MODEL),
            ("groq", "openai/gpt-oss-20b"),
            ("groq", "llama-3.3-70b-versatile"),
            ("groq", "llama-3.1-8b-instant"),
        ]
    )

    try:
        nvidia_models = nvidia_text_service.list_models()
    except Exception:
        nvidia_models = []
    candidates.extend(("nvidia", model) for model in nvidia_models[:8])

    seen: set[tuple[str, str]] = set()
    errors: list[str] = []
    for provider, model in candidates:
        key = (provider, model)
        if key in seen or not model:
            continue
        seen.add(key)
        if provider == "groq" and not settings.groq_api_key:
            continue
        if provider == "nvidia" and not os.getenv("NVIDIA_API_KEY", "").strip():
            continue
        try:
            if provider == "nvidia":
                content, usage, selected = nvidia_text_service.complete(
                    messages,
                    model=model,
                    max_tokens=settings.ORCHESTRATION_MAX_OUTPUT_TOKENS,
                    request_timeout=settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS,
                )
            else:
                content, usage, selected = groq_service.complete(
                    messages,
                    provider="groq",
                    model=model,
                    max_tokens=settings.ORCHESTRATION_MAX_OUTPUT_TOKENS,
                    request_timeout=settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS,
                )
            if content and content.strip():
                return content.strip(), usage, provider, selected
        except Exception as exc:
            if isinstance(exc, HTTPException):
                errors.append(f"{provider}/{model}:{exc.status_code}")
            else:
                errors.append(f"{provider}/{model}:{type(exc).__name__}")

    detail = "All configured Groq/NVIDIA AI providers failed."
    if errors:
        detail += f" Attempts: {', '.join(errors[:12])}."
    raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


class IntelligenceOrchestrator:
    def run(
        self,
        messages: list[dict[str, str]],
        *,
        mode: str,
        emit: ActivityCallback,
        cancelled: CancelCallback,
        evidence: list[dict] | None = None,
        providers: list[str] | None = None,
        requested_models: list[str] | None = None,
        max_models: int | None = None,
        stream_content: SynthesisCallback | None = None,
    ) -> OrchestrationResult:
        started = perf_counter()
        canonical = IntelligenceMode.canonical(mode)
        if canonical == IntelligenceMode.DEEP_RESEARCH and not evidence:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Deep Research requires verified web source context.")
        emit("orchestration.started", {"mode": canonical.value, "stage": "Understanding your request"})
        emit("request.analysis.started", {"mode": canonical.value, "stage": "Understanding your request"})
        user_message = next((item["content"] for item in reversed(messages) if item.get("role") == "user"), "")
        analysis = request_analyzer.analyze(user_message, canonical)
        emit("request.analysis.completed", {"mode": canonical.value, "stage": "Identifying the required expertise", "intent": analysis.intent})
        tasks = task_planner.plan(canonical, analysis, messages, providers=providers, requested_models=requested_models, max_models=max_models)

        if not tasks:
            if canonical == IntelligenceMode.DEEP_RESEARCH:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No healthy Groq/NVIDIA intelligence model is available for Deep Research.")
            emit("orchestration.fallback", {"mode": canonical.value, "stage": "Using direct Groq/NVIDIA provider fallback", "fallback_used": True})
            content, usage, provider, model = _direct_fallback(messages, [])
            emit("model.completed", {"task_id": "direct-fallback", "provider_display_name": provider.title(), "model_display_name": model, "actual_model_id": model, "role": "Direct provider fallback", "activity_label": "Generating the response with an available Groq/NVIDIA provider", "status": "completed", "contributed_to_final_answer": True})
            elapsed_ms = int((perf_counter() - started) * 1000)
            return OrchestrationResult(content=content, usage=usage, selected_model=f"{provider}/{model}", metadata={"mode": canonical.value, "models_attempted": 1, "models_completed": 1, "models_contributed": 1, "models_consulted": [{"provider": provider, "provider_display_name": provider.title(), "display_name": model, "actual_model_id": model, "role": "Direct provider fallback", "activity_label": "Generating the response with an available Groq/NVIDIA provider", "status": "completed", "contributed": True}], "verified_sources": 0, "duration_ms": elapsed_ms, "fallback_used": True})

        task_providers = {task.model.provider for task in tasks}
        preferred_provider = settings.AI_PROVIDER
        provider_fallback_used = preferred_provider not in task_providers or len(task_providers) > 1
        if provider_fallback_used:
            emit("model.progress", {"mode": canonical.value, "stage": "Using available healthy Groq/NVIDIA intelligence models.", "fallback_used": True})
        for task in tasks:
            emit("task.created", {"mode": canonical.value, "task_id": task.task_id, "role": task.role})

        if canonical == IntelligenceMode.INSTANT:
            results = []
            for task in tasks:
                attempt = parallel_executor.execute([task], emit=emit, cancelled=cancelled, max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS), total_timeout=min(analysis.latency_budget_seconds, settings.ORCHESTRATION_TOTAL_TIMEOUT_SECONDS))
                results.extend(attempt)
                if any(item.status == TaskStatus.COMPLETED and item.content for item in attempt):
                    break
        else:
            results = parallel_executor.execute(tasks, emit=emit, cancelled=cancelled, max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS), total_timeout=min(analysis.latency_budget_seconds, settings.ORCHESTRATION_TOTAL_TIMEOUT_SECONDS))
        if cancelled():
            emit("orchestration.cancelled", {"mode": canonical.value, "stage": "Generation cancelled"})
            raise HTTPException(status_code=499, detail="Generation cancelled.")
        successes = [result for result in results if result.status == TaskStatus.COMPLETED and result.content]
        if not successes:
            failure_reasons = [result.error_classification for result in results if result.error_classification]
            if canonical != IntelligenceMode.DEEP_RESEARCH:
                emit("orchestration.fallback", {"mode": canonical.value, "stage": "Groq/NVIDIA model workers failed; using direct Groq/NVIDIA fallback", "failure_reasons": failure_reasons, "fallback_used": True})
                content, usage, provider, model = _direct_fallback(messages, tasks)
                emit("model.completed", {"task_id": "direct-fallback", "provider_display_name": provider.title(), "model_display_name": model, "actual_model_id": model, "role": "Direct provider fallback", "activity_label": "Generating the response with an available Groq/NVIDIA provider", "status": "completed", "contributed_to_final_answer": True})
                elapsed_ms = int((perf_counter() - started) * 1000)
                return OrchestrationResult(content=content, usage=usage, selected_model=f"{provider}/{model}", metadata={"mode": canonical.value, "models_attempted": len(results) + 1, "models_completed": 1, "models_contributed": 1, "models_consulted": [*[{"provider": result.task.model.provider, "provider_display_name": result.task.model.provider.title(), "display_name": result.task.model.friendly_name, "actual_model_id": result.task.model.actual_model_id, "role": result.task.role, "activity_label": result.task.activity_label, "status": result.status.value, "latency_ms": result.duration_ms, "started_at": result.started_at, "completed_at": result.completed_at, "failure_reason": result.error_classification, "contributed": False} for result in results], {"provider": provider, "provider_display_name": provider.title(), "display_name": model, "actual_model_id": model, "role": "Direct provider fallback", "activity_label": "Generating the response with an available Groq/NVIDIA provider", "status": "completed", "contributed": True}], "verified_sources": 0, "duration_ms": elapsed_ms, "fallback_used": True})
            detail = "Available Groq/NVIDIA intelligence models could not complete Deep Research."
            if failure_reasons:
                detail += f" Provider errors: {', '.join(dict.fromkeys(failure_reasons))}."
            emit("orchestration.failed", {"mode": canonical.value, "stage": "Generation could not complete", "failure_reasons": failure_reasons})
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)

        emit("evaluation.started", {"mode": canonical.value, "stage": "Comparing successful results"})
        emit("evaluation.completed", {"mode": canonical.value, "stage": "Checking facts and consistency"})
        emit("synthesis.started", {"mode": canonical.value, "stage": "Combining successful results"})
        content, synthesis_usage, selected_model = response_synthesizer.synthesize(user_message, successes, max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS))
        for result in successes:
            result.contributed = True
            emit("model.completed", {"task_id": result.task.task_id, "provider_display_name": result.task.model.provider.title(), "model_display_name": result.task.model.friendly_name, "actual_model_id": result.task.model.actual_model_id, "role": result.task.role, "activity_label": result.task.activity_label, "status": "completed", "duration_ms": result.duration_ms, "started_at": result.started_at, "completed_at": result.completed_at, "contributed_to_final_answer": True})
        verified_citations = 0
        if canonical == IntelligenceMode.DEEP_RESEARCH:
            content, verified_citations = citation_verifier.verify(content, evidence or [])
        if stream_content:
            emit("synthesis.streaming", {"mode": canonical.value, "stage": "Preparing the final response"})
            for end in range(160, len(content) + 160, 160):
                if cancelled():
                    emit("orchestration.cancelled", {"mode": canonical.value, "stage": "Generation cancelled"})
                    raise HTTPException(status_code=499, detail="Generation cancelled.")
                stream_content(content[:end])
        elapsed_ms = int((perf_counter() - started) * 1000)
        runtime_failure_fallback = any(result.status != TaskStatus.COMPLETED for result in results)
        fallback_used = provider_fallback_used or runtime_failure_fallback
        emit("synthesis.completed", {"mode": canonical.value, "stage": "Preparing the final response"})
        emit("orchestration.completed", {"mode": canonical.value, "stage": "Response ready", "duration_ms": elapsed_ms, "models_attempted": len(results), "models_completed": len(successes), "models_contributed": len(successes), "verified_sources": verified_citations, "fallback_used": fallback_used})
        usages = [result.usage for result in successes] + [synthesis_usage]
        usage = {key: sum(int(item.get(key, 0) or 0) for item in usages) for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
        logger.info("orchestration_completed mode=%s models_attempted=%s models_succeeded=%s total_latency_ms=%s fallback_used=%s verified_sources=%s total_tokens=%s", canonical.value, len(results), len(successes), elapsed_ms, fallback_used, verified_citations, usage["total_tokens"])
        return OrchestrationResult(content=content, usage=usage, selected_model=f"orchestration:{selected_model}", metadata={"mode": canonical.value, "models_attempted": len(results), "models_completed": len(successes), "models_contributed": len(successes), "models_consulted": [{"provider": result.task.model.provider, "provider_display_name": result.task.model.provider.title(), "display_name": result.task.model.friendly_name, "actual_model_id": result.task.model.actual_model_id, "role": result.task.role, "activity_label": result.task.activity_label, "status": result.status.value, "latency_ms": result.duration_ms, "started_at": result.started_at, "completed_at": result.completed_at, "failure_reason": result.error_classification, "contributed": result.contributed} for result in results], "verified_sources": verified_citations, "duration_ms": elapsed_ms, "fallback_used": fallback_used})


intelligence_orchestrator = IntelligenceOrchestrator()
