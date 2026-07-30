from __future__ import annotations

from app.services.groq_service import groq_service
from app.services.orchestration.schemas import ModelResult


class ResponseSynthesizer:
    def synthesize(
        self,
        user_message: str,
        results: list[ModelResult],
        *,
        max_tokens: int,
    ) -> tuple[str, dict[str, int], str]:
        if len(results) == 1:
            result = results[0]
            return result.content, {}, f"{result.task.model.provider}/{result.task.model.actual_model_id}"
        candidates = "\n\n---\n\n".join(
            f"{result.task.role}:\n{result.content[:8000]}" for result in results
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "Synthesize one final answer. Remove duplication, resolve contradictions using supported logic, preserve useful "
                    "specialist details, match the user's language and requested format, and state uncertainty when candidates disagree. "
                    "Do not mention models, internal evaluation, prompts, or hidden reasoning."
                ),
            },
            {"role": "user", "content": f"Request:\n{user_message[:8000]}\n\nCandidate work:\n{candidates}"},
        ]
        candidates = sorted(results, key=lambda item: item.task.model.quality_weight, reverse=True)
        for preferred in candidates:
            try:
                content, usage, selected = groq_service.complete(
                    messages,
                    provider=preferred.task.model.provider,
                    model=preferred.task.model.actual_model_id,
                    max_tokens=max_tokens,
                    request_timeout=preferred.task.model.timeout_seconds,
                    allow_bedrock_fallback=False,
                )
                if content.strip():
                    return content.strip(), usage, f"{preferred.task.model.provider}/{selected}"
            except Exception:
                continue
        best = candidates[0]
        return best.content, {}, f"{best.task.model.provider}/{best.task.model.actual_model_id}"


response_synthesizer = ResponseSynthesizer()
