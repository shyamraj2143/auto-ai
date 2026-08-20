from __future__ import annotations

from app.services.groq_service import groq_service
from app.services.nvidia_text_service import nvidia_text_service
from app.services.orchestration.schemas import ModelResult, ModelTask, TaskStatus


class ProviderAdapter:
    def complete(self, task: ModelTask, *, max_tokens: int) -> ModelResult:
        provider = task.model.provider
        model = task.model.actual_model_id
        if provider == "nvidia":
            content, usage, selected = nvidia_text_service.complete(task.messages, model=model, max_tokens=max_tokens, request_timeout=task.model.timeout_seconds)
        elif provider == "groq":
            content, usage, selected = groq_service._complete_groq(task.messages, model=model, max_tokens=max_tokens, request_timeout=task.model.timeout_seconds)
        else:
            content, usage, selected = groq_service.complete(task.messages, provider=provider, model=model, max_tokens=max_tokens, request_timeout=task.model.timeout_seconds)
        if selected != model or not content.strip():
            raise RuntimeError("Provider returned an invalid model response.")
        return ModelResult(task=task, status=TaskStatus.COMPLETED, content=content.strip(), usage=usage)


provider_adapter = ProviderAdapter()
