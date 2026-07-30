from __future__ import annotations

import logging
from time import perf_counter

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.orchestration.citation_verifier import citation_verifier
from app.services.orchestration.parallel_executor import parallel_executor
from app.services.orchestration.request_analyzer import request_analyzer
from app.services.orchestration.response_synthesizer import response_synthesizer
from app.services.orchestration.schemas import (
    ActivityCallback,
    CancelCallback,
    IntelligenceMode,
    OrchestrationResult,
    SynthesisCallback,
    TaskStatus,
)
from app.services.orchestration.task_planner import task_planner


logger = logging.getLogger("auto_ai.orchestration")


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
        emit("orchestration.started", {"mode": canonical.value, "stage": "Understanding your request"})
        emit("request.analysis.started", {"mode": canonical.value, "stage": "Understanding your request"})
        user_message = next((item["content"] for item in reversed(messages) if item.get("role") == "user"), "")
        analysis = request_analyzer.analyze(user_message, canonical)
        emit(
            "request.analysis.completed",
            {"mode": canonical.value, "stage": "Identifying the required expertise", "intent": analysis.intent},
        )
        tasks = task_planner.plan(
            canonical,
            analysis,
            messages,
            providers=providers,
            requested_models=requested_models,
            max_models=max_models,
        )
        if not tasks:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No healthy intelligence model is available.")
        advanced_provider_unavailable = (
            canonical == IntelligenceMode.HIGH
            and not any(task.model.provider == "bedrock" for task in tasks)
        )
        if advanced_provider_unavailable:
            emit(
                "model.progress",
                {
                    "mode": canonical.value,
                    "stage": "Continuing with available intelligence models.",
                    "fallback_used": True,
                },
            )
        for task in tasks:
            emit("task.created", {"mode": canonical.value, "task_id": task.task_id, "role": task.role})
        if canonical == IntelligenceMode.INSTANT:
            results = []
            for task in tasks:
                attempt = parallel_executor.execute(
                    [task],
                    emit=emit,
                    cancelled=cancelled,
                    max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS),
                    total_timeout=min(analysis.latency_budget_seconds, settings.ORCHESTRATION_TOTAL_TIMEOUT_SECONDS),
                )
                results.extend(attempt)
                if any(item.status == TaskStatus.COMPLETED and item.content for item in attempt):
                    break
        else:
            results = parallel_executor.execute(
                tasks,
                emit=emit,
                cancelled=cancelled,
                max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS),
                total_timeout=min(analysis.latency_budget_seconds, settings.ORCHESTRATION_TOTAL_TIMEOUT_SECONDS),
            )
        if cancelled():
            emit("orchestration.cancelled", {"mode": canonical.value, "stage": "Generation cancelled"})
            raise HTTPException(status_code=499, detail="Generation cancelled.")
        successes = [result for result in results if result.status == TaskStatus.COMPLETED and result.content]
        if not successes:
            emit("orchestration.failed", {"mode": canonical.value, "stage": "Generation could not complete"})
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Available intelligence models could not complete the request.")
        emit("evaluation.started", {"mode": canonical.value, "stage": "Comparing successful results"})
        emit("evaluation.completed", {"mode": canonical.value, "stage": "Checking facts and consistency"})
        emit("synthesis.started", {"mode": canonical.value, "stage": "Combining successful results"})
        content, synthesis_usage, selected_model = response_synthesizer.synthesize(
            user_message,
            successes,
            max_tokens=min(analysis.token_budget, settings.ORCHESTRATION_MAX_OUTPUT_TOKENS),
        )
        for result in successes:
            result.contributed = True
            emit(
                "model.completed",
                {
                    "task_id": result.task.task_id,
                    "provider_display_name": "AWS Bedrock" if result.task.model.provider == "bedrock" else result.task.model.provider.title(),
                    "model_display_name": result.task.model.friendly_name,
                    "role": result.task.role,
                    "activity_label": result.task.activity_label,
                    "status": "completed",
                    "duration_ms": result.duration_ms,
                    "contributed_to_final_answer": True,
                },
            )
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
        emit("synthesis.completed", {"mode": canonical.value, "stage": "Preparing the final response"})
        emit(
            "orchestration.completed",
            {
                "mode": canonical.value,
                "stage": "Response ready",
                "duration_ms": elapsed_ms,
                "models_attempted": len(results),
                "models_completed": len(successes),
                "models_contributed": len(successes),
                "verified_sources": verified_citations,
                "fallback_used": advanced_provider_unavailable
                or any(result.status != TaskStatus.COMPLETED for result in results),
            },
        )
        usages = [result.usage for result in successes] + [synthesis_usage]
        usage = {
            key: sum(int(item.get(key, 0) or 0) for item in usages)
            for key in ("prompt_tokens", "completion_tokens", "total_tokens")
        }
        logger.info(
            "orchestration_completed mode=%s models_attempted=%s models_succeeded=%s total_latency_ms=%s "
            "fallback_used=%s verified_sources=%s total_tokens=%s",
            canonical.value,
            len(results),
            len(successes),
            elapsed_ms,
            advanced_provider_unavailable or any(result.status != TaskStatus.COMPLETED for result in results),
            verified_citations,
            usage["total_tokens"],
        )
        return OrchestrationResult(
            content=content,
            usage=usage,
            selected_model=f"orchestration:{selected_model}",
            metadata={
                "mode": canonical.value,
                "models_consulted": [
                    {
                        "provider": result.task.model.provider,
                        "display_name": result.task.model.friendly_name,
                        "role": result.task.role,
                        "latency_ms": result.duration_ms,
                        "contributed": result.contributed,
                    }
                    for result in results
                ],
                "verified_sources": verified_citations,
                "duration_ms": elapsed_ms,
                "fallback_used": advanced_provider_unavailable
                or any(result.status != TaskStatus.COMPLETED for result in results),
            },
        )


intelligence_orchestrator = IntelligenceOrchestrator()
