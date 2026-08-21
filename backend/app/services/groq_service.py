from __future__ import annotations

import base64
import json
import re
import tempfile
from pathlib import Path
from typing import Any

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
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported AI provider: {selected}")
        return selected

    def selected_model(self, model: str | None = None, *, provider: str | None = None, web_search: bool = False) -> str:
        selected = self.selected_provider(provider)
        if selected == "openai": return model or settings.OPENAI_MODEL
        if selected == "gemini": return model or settings.GEMINI_MODEL
        return settings.GROQ_SEARCH_MODEL if web_search else (model or settings.GROQ_MODEL)

    @staticmethod
    def _handle_groq_error(exc: GroqError) -> None:
        if isinstance(exc, AuthenticationError):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Groq API key is invalid.") from exc
        code = int(getattr(exc, "status_code", 0) or 0)
        if code == 429 or re.search(r"\b(rate limit|tpm|tokens per minute|too many requests|request limit)\b", str(exc), re.I):
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Groq rate limit reached. Please retry later.") from exc
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Groq request failed: {exc}") from exc

    def _client(self) -> Groq:
        key = settings.groq_api_key
        if not key: raise HTTPException(status_code=503, detail="GROQ_API_KEY is not configured.")
        if not self.client or self.client_api_key != key:
            self.client = Groq(api_key=key); self.client_api_key = key
        return self.client

    @classmethod
    def _content_to_text(cls, value: Any) -> str:
        if value is None: return ""
        if isinstance(value, str): return value.replace("[object Object]", "")
        if isinstance(value, (int, float, bool)): return str(value)
        if isinstance(value, list): return "".join(cls._content_to_text(v) for v in value)
        if isinstance(value, dict):
            for key in ("text", "content", "delta", "message", "value", "output"):
                if key in value:
                    text = cls._content_to_text(value[key])
                    if text: return text
            return ""
        for attr in ("text", "content", "delta", "message", "value", "output"):
            if hasattr(value, attr):
                text = cls._content_to_text(getattr(value, attr))
                if text: return text
        return ""

    def _openai_headers(self) -> dict[str, str]:
        if not settings.OPENAI_API_KEY: raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured.")
        return {"Authorization": f"Bearer {settings.OPENAI_API_KEY}", "Content-Type": "application/json"}

    def _gemini_headers(self) -> dict[str, str]:
        if not settings.GEMINI_API_KEY: raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured.")
        return {"Authorization": f"Bearer {settings.GEMINI_API_KEY}", "Content-Type": "application/json"}

    @staticmethod
    def _token_parameter(model: str) -> str:
        return "max_completion_tokens" if model.startswith(("gpt-5", "o1", "o3", "o4")) else "max_tokens"

    def _payload(self, messages, *, model, stream=False, max_tokens=None):
        payload = {"model": model, "messages": messages, self._token_parameter(model): max_tokens or settings.GROQ_MAX_TOKENS}
        if stream: payload.update({"stream": True, "stream_options": {"include_usage": True}})
        return payload

    @staticmethod
    def _raise_http_provider_error(provider: str, response: httpx.Response) -> None:
        detail = response.text
        try:
            body = response.json()
            if isinstance(body.get("error"), dict): detail = body["error"].get("message") or detail
        except Exception: pass
        raise HTTPException(status_code=response.status_code if response.status_code in {400,401,403,429} else 502, detail=f"{provider} request failed: {detail}")

    def _complete_openai_compatible(self, provider, base_url, headers, messages, *, model, max_tokens=None, request_timeout=None):
        try: response = httpx.post(f"{base_url.rstrip('/')}/chat/completions", headers=headers, json=self._payload(messages, model=model, max_tokens=max_tokens), timeout=request_timeout or 90)
        except httpx.HTTPError as exc: raise HTTPException(status_code=502, detail=f"{provider} request failed: {exc}") from exc
        if response.status_code >= 400: self._raise_http_provider_error(provider, response)
        body = response.json()
        return self._content_to_text(body.get("choices", [{}])[0].get("message", {}).get("content")), self.extract_usage(body), model

    def _complete_groq(self, messages, *, model, temperature=None, max_tokens=None, request_timeout=None):
        try:
            client: Any = self._client()
            if request_timeout: client = client.with_options(timeout=request_timeout)
            completion = client.chat.completions.create(model=model, messages=messages, temperature=settings.GROQ_TEMPERATURE if temperature is None else temperature, max_tokens=max_tokens or settings.GROQ_MAX_TOKENS)
        except GroqError as exc: self._handle_groq_error(exc)
        return self._content_to_text(completion.choices[0].message.content), self.extract_usage(completion), model

    def _stream_openai_compatible(self, provider, base_url, headers, messages, *, model):
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream("POST", f"{base_url.rstrip('/')}/chat/completions", headers=headers, json=self._payload(messages, model=model, stream=True)) as response:
                    if response.status_code >= 400: self._raise_http_provider_error(provider, response)
                    for line in response.iter_lines():
                        if not line.startswith("data:"): continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]": break
                        if data: yield json.loads(data)
        except httpx.HTTPError as exc: raise HTTPException(status_code=502, detail=f"{provider} request failed: {exc}") from exc

    def _stream_groq(self, messages, *, model, temperature=None):
        try: return self._client().chat.completions.create(model=model, messages=messages, temperature=settings.GROQ_TEMPERATURE if temperature is None else temperature, max_tokens=settings.GROQ_MAX_TOKENS, stream=True)
        except GroqError as exc: self._handle_groq_error(exc)

    def complete(self, messages, *, model=None, provider=None, web_search=False, temperature=None, max_tokens=None, request_timeout=None, allow_bedrock_fallback=False):
        selected_provider = self.selected_provider(provider); selected_model = self.selected_model(model, provider=selected_provider, web_search=web_search)
        if selected_provider == "openai": return self._complete_openai_compatible("OpenAI", settings.OPENAI_BASE_URL, self._openai_headers(), messages, model=selected_model, max_tokens=max_tokens, request_timeout=request_timeout)
        if selected_provider == "gemini": return self._complete_openai_compatible("Gemini", settings.GEMINI_BASE_URL, self._gemini_headers(), messages, model=selected_model, max_tokens=max_tokens, request_timeout=request_timeout)
        last_error = None
        for candidate in list(dict.fromkeys([selected_model, settings.GROQ_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant"])):
            try: return self._complete_groq(messages, model=candidate, temperature=temperature, max_tokens=max_tokens, request_timeout=request_timeout)
            except HTTPException as exc:
                last_error = exc
                if exc.status_code in {401,403}: raise
        raise last_error or HTTPException(status_code=503, detail="No Groq chat model is available.")

    def stream(self, messages, *, model=None, provider=None, web_search=False, temperature=None, allow_bedrock_fallback=False):
        selected_provider = self.selected_provider(provider); selected_model = self.selected_model(model, provider=selected_provider, web_search=web_search)
        if selected_provider == "openai": return self._stream_openai_compatible("OpenAI", settings.OPENAI_BASE_URL, settings.OPENAI_API_KEY, messages, model=selected_model)
        if selected_provider == "gemini": return self._stream_openai_compatible("Gemini", settings.GEMINI_BASE_URL, settings.GEMINI_API_KEY, messages, model=selected_model)
        def iterator():
            last_error = None
            for candidate in list(dict.fromkeys([selected_model, settings.GROQ_MODEL, "llama-3.3-70b-versatile", "llama-3.1-8b-instant"])):
                try: yield from self._stream_groq(messages, model=candidate, temperature=temperature); return
                except HTTPException as exc:
                    last_error = exc
                    if exc.status_code in {401,403}: raise
            raise last_error or HTTPException(status_code=503, detail="No Groq chat model is available.")
        return iterator()

    def analyze_image(self, image_bytes: bytes, filename: str, prompt: str) -> str:
        suffix = Path(filename).suffix.lower().replace(".", "") or "png"; mime = "jpeg" if suffix == "jpg" else suffix
        encoded = base64.b64encode(image_bytes).decode("ascii")
        messages = [{"role":"user","content":[{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":f"data:image/{mime};base64,{encoded}"}}]}]
        content, _, _ = self._complete_groq(messages, model=settings.GROQ_VISION_MODEL, max_tokens=settings.GROQ_MAX_TOKENS, request_timeout=60)
        return content

    def transcribe_audio(self, audio_bytes: bytes, filename: str, model: str | None = None, *, language: str | None = None, prompt: str | None = None) -> str:
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=Path(filename).suffix or ".webm") as tmp: tmp.write(audio_bytes); temp_path = tmp.name
            with open(temp_path, "rb") as audio_file:
                request = {"file": audio_file, "model": model or settings.GROQ_AUDIO_MODEL, "response_format":"json"}
                if language: request["language"] = language
                if prompt: request["prompt"] = prompt[:800]
                try: transcription = self._client().audio.transcriptions.create(**request)
                except GroqError as exc: self._handle_groq_error(exc)
            return getattr(transcription, "text", "") or ""
        finally:
            if temp_path: Path(temp_path).unlink(missing_ok=True)

    @staticmethod
    def extract_stream_delta(chunk: Any) -> str:
        if isinstance(chunk, dict):
            choices = chunk.get("choices") or []
            return GroqService._content_to_text((choices[0].get("delta") or {}).get("content")) if choices else ""
        if not getattr(chunk, "choices", None): return ""
        return GroqService._content_to_text(getattr(getattr(chunk.choices[0], "delta", None), "content", None))

    @staticmethod
    def _normalize_usage(usage: Any) -> dict[str, int]:
        if not isinstance(usage, dict): return {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
        prompt = int(usage.get("prompt_tokens", usage.get("inputTokens", 0)) or 0); completion = int(usage.get("completion_tokens", usage.get("outputTokens", 0)) or 0); total = int(usage.get("total_tokens", usage.get("totalTokens", 0)) or prompt + completion)
        return {"prompt_tokens":prompt,"completion_tokens":completion,"total_tokens":total}

    @staticmethod
    def extract_usage(completion: Any) -> dict[str, int]:
        usage = completion.get("usage") if isinstance(completion, dict) else getattr(completion, "usage", None)
        if not usage: return {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
        return GroqService._normalize_usage(usage) if isinstance(usage, dict) else {"prompt_tokens":int(getattr(usage,"prompt_tokens",0) or 0),"completion_tokens":int(getattr(usage,"completion_tokens",0) or 0),"total_tokens":int(getattr(usage,"total_tokens",0) or 0)}


groq_service = GroqService()
