from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, content: str) -> None:
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


# Bedrock is removed as an AI provider, but unrelated AWS/S3 storage support remains.

config = ROOT / "backend/app/core/config.py"
text = read(config)
text = "\n".join(
    line
    for line in text.splitlines()
    if not any(
        token in line
        for token in (
            "BEDROCK_",
            "bedrock_",
            "ORCHESTRATION_BEDROCK",
            "BEDROCK",
        )
    )
)
write(config, text)


# Keep the service focused on Groq/OpenAI/Gemini. Image analysis stays on Groq vision.
groq = ROOT / "backend/app/services/groq_service.py"
write(
    groq,
    '''from __future__ import annotations

import base64
import json
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable

import httpx
from fastapi import HTTPException, status
from groq import AuthenticationError, Groq, GroqError

from app.core.config import settings


class GroqService:
    def __init__(self) -> None:
        self.client: Groq | None = None
        self.client_api_key: str | None = None

    @property
    def provider(self) -> str:
        return settings.AI_PROVIDER.lower()

    def selected_provider(self, provider: str | None = None) -> str:
        selected = (provider or self.provider).lower()
        if selected not in {"openai", "groq", "gemini"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported AI provider: {selected}",
            )
        return selected

    def selected_model(
        self,
        model: str | None = None,
        *,
        provider: str | None = None,
        web_search: bool = False,
    ) -> str:
        selected = self.selected_provider(provider)
        if selected == "openai":
            return model or settings.OPENAI_MODEL
        if selected == "gemini":
            return model or settings.GEMINI_MODEL
        return settings.GROQ_SEARCH_MODEL if web_search else (model or settings.GROQ_MODEL)

    @staticmethod
    def _handle_groq_error(exc: GroqError) -> None:
        if isinstance(exc, AuthenticationError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Groq API key is invalid.",
            ) from exc
        status_code = int(getattr(exc, "status_code", 0) or 0)
        error_text = str(exc)
        if status_code == 429 or re.search(
            r"\\b(rate limit|tpm|tokens per minute|too many requests|request limit)\\b",
            error_text,
            re.IGNORECASE,
        ):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Groq rate limit reached. Please wait a minute, use a smaller prompt, or switch to OpenAI/Gemini.",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Groq request failed: {exc}",
        ) from exc

    def _groq_model_candidates(self, model: str, *, web_search: bool) -> list[str]:
        if web_search:
            return [settings.GROQ_SEARCH_MODEL]
        candidates = [
            model,
            settings.GROQ_MODEL,
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
        ]
        return list(dict.fromkeys(item for item in candidates if item))

    @classmethod
    def _content_to_text(cls, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.replace("[object Object]", "")
        if isinstance(value, (int, float, bool)):
            return str(value)
        if isinstance(value, list):
            return "".join(cls._content_to_text(item) for item in value)
        if isinstance(value, dict):
            for key in ("text", "content", "delta", "message", "value", "output"):
                if key in value:
                    text = cls._content_to_text(value.get(key))
                    if text:
                        return text
            return ""
        for attr in ("text", "content", "delta", "message", "value", "output"):
            if hasattr(value, attr):
                text = cls._content_to_text(getattr(value, attr))
                if text:
                    return text
        return ""

    def _client(self) -> Groq:
        api_key = settings.groq_api_key
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GROQ_API_KEY is not configured.",
            )
        if not self.client or self.client_api_key != api_key:
            self.client = Groq(api_key=api_key)
            self.client_api_key = api_key
        return self.client

    def _openai_headers(self) -> dict[str, str]:
        if not settings.OPENAI_API_KEY:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OPENAI_API_KEY is not configured.",
            )
        return {
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "Content-Type": "application/json",
        }

    def _gemini_headers(self) -> dict[str, str]:
        if not settings.GEMINI_API_KEY:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="GEMINI_API_KEY is not configured.",
            )
        return {
            "Authorization": f"Bearer {settings.GEMINI_API_KEY}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _openai_token_parameter(model: str) -> str:
        reasoning_prefixes = ("gpt-5", "o1", "o3", "o4")
        return "max_completion_tokens" if model.startswith(reasoning_prefixes) else "max_tokens"

    @staticmethod
    def _raise_provider_error(provider: str, status_code: int, body: str) -> None:
        detail = body
        try:
            payload = json.loads(body)
            error = payload.get("error", {})
            if isinstance(error, dict):
                detail = error.get("message") or detail
        except json.JSONDecodeError:
            pass
        raise HTTPException(
            status_code=status_code if status_code in {400, 401, 403, 429} else status.HTTP_502_BAD_GATEWAY,
            detail=f"{provider} request failed: {detail}",
        )

    def _openai_payload(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        stream: bool = False,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            self._openai_token_parameter(model): max_tokens or settings.GROQ_MAX_TOKENS,
        }
        if stream:
            payload["stream"] = True
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _complete_openai(self, messages, *, model, max_tokens=None, request_timeout=None):
        try:
            response = httpx.post(
                f"{settings.OPENAI_BASE_URL.rstrip('/')}/chat/completions",
                headers=self._openai_headers(),
                json=self._openai_payload(messages, model=model, max_tokens=max_tokens),
                timeout=request_timeout or 90,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"OpenAI request failed: {exc}") from exc
        if response.status_code >= 400:
            self._raise_provider_error("OpenAI", response.status_code, response.text)
        completion = response.json()
        content = self._content_to_text(completion.get("choices", [{}])[0].get("message", {}).get("content"))
        return content, self.extract_usage(completion), model

    def _complete_gemini(self, messages, *, model, max_tokens=None, request_timeout=None):
        try:
            response = httpx.post(
                f"{settings.GEMINI_BASE_URL.rstrip('/')}/chat/completions",
                headers=self._gemini_headers(),
                json=self._openai_payload(messages, model=model, max_tokens=max_tokens),
                timeout=request_timeout or 90,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Gemini request failed: {exc}") from exc
        if response.status_code >= 400:
            self._raise_provider_error("Gemini", response.status_code, response.text)
        completion = response.json()
        content = self._content_to_text(completion.get("choices", [{}])[0].get("message", {}).get("content"))
        return content, self.extract_usage(completion), model

    def _complete_groq(self, messages, *, model, temperature=None, max_tokens=None, request_timeout=None):
        try:
            client: Any = self._client()
            if request_timeout:
                client = client.with_options(timeout=request_timeout)
            completion = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=settings.GROQ_TEMPERATURE if temperature is None else temperature,
                max_tokens=max_tokens or settings.GROQ_MAX_TOKENS,
            )
        except GroqError as exc:
            self._handle_groq_error(exc)
        content = self._content_to_text(completion.choices[0].message.content)
        return content, self.extract_usage(completion), model

    def _stream_openai(self, messages, *, model):
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream("POST", f"{settings.OPENAI_BASE_URL.rstrip('/')}/chat/completions", headers=self._openai_headers(), json=self._openai_payload(messages, model=model, stream=True)) as response:
                    if response.status_code >= 400:
                        self._raise_provider_error("OpenAI", response.status_code, response.read().decode("utf-8", errors="replace"))
                    for line in response.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        if data:
                            yield json.loads(data)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"OpenAI request failed: {exc}") from exc

    def _stream_gemini(self, messages, *, model):
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream("POST", f"{settings.GEMINI_BASE_URL.rstrip('/')}/chat/completions", headers=self._gemini_headers(), json=self._openai_payload(messages, model=model, stream=True)) as response:
                    if response.status_code >= 400:
                        self._raise_provider_error("Gemini", response.status_code, response.read().decode("utf-8", errors="replace"))
                    for line in response.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        if data:
                            yield json.loads(data)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Gemini request failed: {exc}") from exc

    def _stream_groq(self, messages, *, model, temperature=None):
        try:
            return self._client().chat.completions.create(
                model=model,
                messages=messages,
                temperature=settings.GROQ_TEMPERATURE if temperature is None else temperature,
                max_tokens=settings.GROQ_MAX_TOKENS,
                stream=True,
            )
        except GroqError as exc:
            self._handle_groq_error(exc)

    def complete(self, messages, *, model=None, provider=None, web_search=False, temperature=None, max_tokens=None, request_timeout=None):
        selected_provider = self.selected_provider(provider)
        selected_model = self.selected_model(model, provider=selected_provider, web_search=web_search)
        if selected_provider == "openai":
            return self._complete_openai(messages, model=selected_model, max_tokens=max_tokens, request_timeout=request_timeout)
        if selected_provider == "gemini":
            return self._complete_gemini(messages, model=selected_model, max_tokens=max_tokens, request_timeout=request_timeout)
        last_error = None
        for candidate_model in self._groq_model_candidates(selected_model, web_search=web_search):
            try:
                return self._complete_groq(messages, model=candidate_model, temperature=temperature, max_tokens=max_tokens, request_timeout=request_timeout)
            except HTTPException as exc:
                last_error = exc
                if exc.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN}:
                    raise
        if last_error:
            raise last_error
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No Groq chat model is available.")

    def stream(self, messages, *, model=None, provider=None, web_search=False, temperature=None):
        selected_provider = self.selected_provider(provider)
        selected_model = self.selected_model(model, provider=selected_provider, web_search=web_search)
        if selected_provider == "openai":
            return self._stream_openai(messages, model=selected_model)
        if selected_provider == "gemini":
            return self._stream_gemini(messages, model=selected_model)

        def iterator():
            last_error = None
            for candidate_model in self._groq_model_candidates(selected_model, web_search=web_search):
                try:
                    yield from self._stream_groq(messages, model=candidate_model, temperature=temperature)
                    return
                except HTTPException as exc:
                    last_error = exc
                    if exc.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN}:
                        raise
            if last_error:
                raise last_error
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No Groq chat model is available.")
        return iterator()

    def analyze_image(self, image_bytes: bytes, filename: str, prompt: str) -> str:
        suffix = Path(filename).suffix.lower().replace(".", "") or "png"
        mime = "jpeg" if suffix == "jpg" else suffix
        encoded = base64.b64encode(image_bytes).decode("ascii")
        messages = [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": f"data:image/{mime};base64,{encoded}"}}]}]
        content, _, _ = self._complete_groq(messages, model=settings.GROQ_VISION_MODEL, max_tokens=settings.GROQ_MAX_TOKENS, request_timeout=60)
        return content

    def transcribe_audio(self, audio_bytes: bytes, filename: str, model: str | None = None, *, language: str | None = None, prompt: str | None = None) -> str:
        suffix = Path(filename).suffix or ".webm"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(audio_bytes)
                temp_path = tmp.name
            with open(temp_path, "rb") as audio_file:
                request: dict[str, object] = {"file": audio_file, "model": model or settings.GROQ_AUDIO_MODEL, "response_format": "json"}
                if language:
                    request["language"] = language
                if prompt:
                    request["prompt"] = prompt[:800]
                try:
                    transcription = self._client().audio.transcriptions.create(**request)
                except GroqError as exc:
                    self._handle_groq_error(exc)
            return getattr(transcription, "text", "") or ""
        finally:
            if temp_path:
                Path(temp_path).unlink(missing_ok=True)

    @staticmethod
    def extract_stream_delta(chunk: Any) -> str:
        if isinstance(chunk, dict):
            choices = chunk.get("choices") or []
            if not choices:
                return ""
            delta = choices[0].get("delta") or {}
            return GroqService._content_to_text(delta.get("content"))
        if not getattr(chunk, "choices", None):
            return ""
        delta = getattr(chunk.choices[0], "delta", None)
        return GroqService._content_to_text(getattr(delta, "content", None))

    @staticmethod
    def _normalize_usage(usage: Any) -> dict[str, int]:
        if not isinstance(usage, dict):
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        prompt_tokens = usage.get("prompt_tokens", usage.get("inputTokens", 0)) or 0
        completion_tokens = usage.get("completion_tokens", usage.get("outputTokens", 0)) or 0
        total_tokens = usage.get("total_tokens", usage.get("totalTokens", 0)) or 0
        if not total_tokens:
            total_tokens = int(prompt_tokens) + int(completion_tokens)
        return {"prompt_tokens": int(prompt_tokens), "completion_tokens": int(completion_tokens), "total_tokens": int(total_tokens)}

    @staticmethod
    def extract_usage(completion: Any) -> dict[str, int]:
        if isinstance(completion, dict):
            usage = completion.get("usage")
            return GroqService._normalize_usage(usage) if usage else {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        usage = getattr(completion, "usage", None)
        if not usage:
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        return {"prompt_tokens": int(getattr(usage, "prompt_tokens", 0) or 0), "completion_tokens": int(getattr(usage, "completion_tokens", 0) or 0), "total_tokens": int(getattr(usage, "total_tokens", 0) or 0)}


groq_service = GroqService()
''',
)


# Remove Bedrock discovery/provider wiring from the registry.
registry = ROOT / "backend/app/services/orchestration/model_registry.py"
text = read(registry)
text = text.replace(
    'discovered = {"groq": self._discover_groq(), "nvidia": self._discover_nvidia(), "bedrock": self._discover_bedrock(), "openai": self._discover_openai_compatible("openai"), "gemini": self._discover_openai_compatible("gemini")}',
    'discovered = {"groq": self._discover_groq(), "nvidia": self._discover_nvidia(), "openai": self._discover_openai_compatible("openai"), "gemini": self._discover_openai_compatible("gemini")}',
)
text = re.sub(r'\n\s*"bedrock": \[[^\n]*\],', '', text)
text = text.replace(',\n                "bedrock": [*settings.ORCHESTRATION_BEDROCK_MODELS, settings.ORCHESTRATION_BEDROCK_CODING_MODEL],', '')
text = text.replace('discovered["bedrock"]', 'set()')
text = text.replace('required_region=settings.bedrock_region if provider == "bedrock" else None,', 'required_region=None,')
text = re.sub(r'(?ms)^    @staticmethod\n    def _discover_bedrock\(\).*?(?=^    @staticmethod\n    def _discover_openai_compatible)', '', text)
write(registry, text)


# Remove Bedrock as a selectable preset provider. Coding uses two healthy Groq models.
policy = ROOT / "backend/app/services/orchestration/preset_policy.py"
text = read(policy)
text = text.replace('frozenset({"groq", "bedrock"})', 'frozenset({"groq"})')
text = re.sub(
    r'(?ms)^def _configured_coding_model\(.*?(?=^def _coding_rank)',
    'def _configured_coding_model(provider: str) -> str | None:\n    return settings.ORCHESTRATION_GROQ_CODING_MODEL if provider == "groq" else None\n\n\n',
    text,
)
text = re.sub(
    r'(?ms)^def coding_model_records\(.*?(?=^def coding_task_records)',
    '''def coding_model_records(records: list[ModelRecord]) -> tuple[ModelRecord | None, ModelRecord | None]:\n    healthy = [record for record in _healthy_chat_records(records) if record.provider == "groq"]\n    healthy.sort(key=lambda record: _coding_rank(record, _configured_coding_model("groq")))\n    return (healthy[0] if healthy else None, healthy[1] if len(healthy) > 1 else None)\n\n\n''',
    text,
)
text = re.sub(
    r'(?ms)^def coding_task_records\(.*?(?=^def coding_configuration_status)',
    '''def coding_task_records(records: list[ModelRecord]) -> list[ModelRecord]:\n    healthy = [record for record in _healthy_chat_records(records) if record.provider == "groq"]\n    healthy.sort(key=lambda record: _coding_rank(record, _configured_coding_model("groq")))\n    return healthy[:2]\n\n\n''',
    text,
)
text = re.sub(
    r'(?ms)^def coding_configuration_status\(.*?(?=^def coding_model_ids)',
    '''def coding_configuration_status(records: list[ModelRecord]) -> tuple[bool, str | None]:\n    selected = coding_task_records(records)\n    if len(selected) >= 2:\n        return True, None\n    return False, "Coding requires two distinct healthy Groq text-chat models."\n\n\n''',
    text,
)
text = re.sub(
    r'(?ms)^def coding_model_ids\(.*?(?=^def coding_fallback_used)',
    '''def coding_model_ids(records: list[ModelRecord]) -> tuple[str | None, str | None]:\n    first, second = coding_model_records(records)\n    return (first.actual_model_id if first else None, second.actual_model_id if second else None)\n\n\n''',
    text,
)
text = re.sub(
    r'(?ms)^def coding_fallback_used\(.*$',
    'def coding_fallback_used(records: list[ModelRecord]) -> bool:\n    return len(coding_task_records(records)) < 2\n',
    text,
)
write(policy, text)


# Clean remaining references in source/docs/config examples without touching unrelated AWS/S3 code.
for path in ROOT.rglob("*"):
    if not path.is_file() or ".git" in path.parts or path in {config, groq, registry, policy}:
        continue
    if "node_modules" in path.parts:
        continue
    try:
        text = read(path)
    except (UnicodeDecodeError, OSError):
        continue
    if "bedrock" not in text.lower():
        continue
    lines = []
    for line in text.splitlines():
        lower = line.lower()
        if any(token in lower for token in ("bedrock", "aws4-hmac-sha256", "aws_secret_access_key")):
            # Keep generic AWS/S3 references unless they are explicitly Bedrock-related.
            if "s3" not in lower and "library_s3" not in lower:
                continue
        line = line.replace("allow_bedrock_fallback=False,", "")
        line = line.replace("allow_bedrock_fallback=True,", "")
        line = line.replace('provider="bedrock"', 'provider="groq"')
        lines.append(line)
    write(path, "\n".join(lines))

# Delete Bedrock-only tests/artifacts and this one-shot script after it has done its job.
for path in list(ROOT.rglob("*")):
    if not path.is_file() or ".git" in path.parts:
        continue
    if "bedrock" in path.name.lower() and path.name != "remove_bedrock.py":
        path.unlink()

print("Bedrock cleanup completed")
''