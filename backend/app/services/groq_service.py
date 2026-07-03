import base64
import datetime as dt
import hashlib
import hmac
import json
import tempfile
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

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
        selected_provider = (provider or self.provider).lower()
        if selected_provider not in {"openai", "groq", "bedrock"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported AI provider: {selected_provider}",
            )
        return selected_provider

    def selected_model(
        self,
        model: str | None = None,
        *,
        provider: str | None = None,
        web_search: bool = False,
    ) -> str:
        selected_provider = self.selected_provider(provider)
        if selected_provider == "openai":
            return model or settings.OPENAI_MODEL
        if selected_provider == "bedrock":
            return model or settings.bedrock_model
        return settings.GROQ_SEARCH_MODEL if web_search else (model or settings.GROQ_MODEL)

    @staticmethod
    def _handle_groq_error(exc: GroqError) -> None:
        if isinstance(exc, AuthenticationError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Groq API key is invalid.",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Groq request failed: {exc}",
        ) from exc

    def _groq_model_for_fallback(self, *, web_search: bool) -> str:
        return settings.GROQ_SEARCH_MODEL if web_search else settings.GROQ_MODEL

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

    @staticmethod
    def _openai_token_parameter(model: str) -> str:
        reasoning_prefixes = ("gpt-5", "o1", "o3", "o4")
        return "max_completion_tokens" if model.startswith(reasoning_prefixes) else "max_tokens"

    @staticmethod
    def _raise_openai_error(status_code: int, body: str) -> None:
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
            detail=f"OpenAI request failed: {detail}",
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

    @staticmethod
    def _bedrock_common_headers() -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _bedrock_api_key_headers(self) -> dict[str, str]:
        if not settings.bedrock_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="BEDROCK_API_KEY is not configured.",
            )
        return {
            **self._bedrock_common_headers(),
            "Authorization": f"Bearer {settings.bedrock_api_key}",
        }

    def _bedrock_mantle_headers(self) -> dict[str, str]:
        if not settings.bedrock_api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="BEDROCK_API_KEY is not configured.",
            )
        return {
            "Authorization": f"Bearer {settings.bedrock_api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _sign_aws(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    def _aws_signature_key(self, date_stamp: str) -> bytes:
        secret_key = settings.aws_secret_access_key
        if not secret_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="AWS_SECRET_ACCESS_KEY is not configured.",
            )
        date_key = self._sign_aws(("AWS4" + secret_key).encode("utf-8"), date_stamp)
        region_key = self._sign_aws(date_key, settings.bedrock_region)
        service_key = self._sign_aws(region_key, "bedrock")
        return self._sign_aws(service_key, "aws4_request")

    def _bedrock_sigv4_headers(self, *, host: str, path: str, body: bytes) -> dict[str, str]:
        access_key = settings.aws_access_key_id
        if not access_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="AWS_ACCESS_KEY_ID is not configured.",
            )

        now = dt.datetime.now(dt.UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if settings.aws_session_token:
            headers["x-amz-security-token"] = settings.aws_session_token

        signed_headers = ";".join(sorted(headers))
        canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in sorted(headers))
        canonical_request = "\n".join(
            ["POST", path, "", canonical_headers, signed_headers, payload_hash]
        )
        credential_scope = f"{date_stamp}/{settings.bedrock_region}/bedrock/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                credential_scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._aws_signature_key(date_stamp),
            string_to_sign.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        headers["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        return headers

    @classmethod
    def _bedrock_messages(cls, messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        system_prompts: list[dict[str, str]] = []
        bedrock_messages: list[dict[str, Any]] = []

        for message in messages:
            content = cls._content_to_text(message.get("content"))
            if not content:
                continue

            role = str(message.get("role") or "user").lower()
            if role == "system":
                system_prompts.append({"text": content})
                continue

            bedrock_role = "assistant" if role == "assistant" else "user"
            bedrock_messages.append(
                {
                    "role": bedrock_role,
                    "content": [{"text": content}],
                }
            )

        return bedrock_messages, system_prompts

    @staticmethod
    def _bedrock_endpoint_parts(model: str) -> tuple[str, str, str]:
        base_url = (
            settings.bedrock_base_url
            or f"https://bedrock-runtime.{settings.bedrock_region}.amazonaws.com"
        ).rstrip("/")
        path = f"/model/{quote(model, safe='')}/converse"
        host = base_url.removeprefix("https://").removeprefix("http://").split("/", 1)[0]
        return f"{base_url}{path}", host, path

    def _bedrock_payload(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        bedrock_messages, system_prompts = self._bedrock_messages(messages)
        payload: dict[str, Any] = {
            "messages": bedrock_messages,
            "inferenceConfig": {
                "maxTokens": max_tokens or settings.GROQ_MAX_TOKENS,
                "temperature": settings.GROQ_TEMPERATURE if temperature is None else temperature,
            },
        }
        if system_prompts:
            payload["system"] = system_prompts
        return payload

    def _bedrock_mantle_payload(
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
            "max_tokens": max_tokens or settings.GROQ_MAX_TOKENS,
        }
        if stream:
            payload["stream"] = True
        return payload

    @staticmethod
    def _bedrock_error_detail(body: str) -> str:
        detail = body
        try:
            payload = json.loads(body)
            detail = payload.get("message") or payload.get("Message") or detail
        except json.JSONDecodeError:
            pass
        return str(detail)

    @classmethod
    def _raise_bedrock_error(cls, status_code: int, body: str, *, auth_label: str) -> None:
        detail = cls._bedrock_error_detail(body)
        if detail.strip().lower() == "operation not allowed":
            detail = (
                "Operation not allowed. Bedrock credentials are valid for account/model lookup, "
                "but AWS is denying runtime model invocation for this key/role. Enable "
                "bedrock:InvokeModel and Converse access for the selected model/region, then retry."
            )

        prefix = f"Bedrock request failed ({auth_label} auth): "
        raise HTTPException(
            status_code=status_code if status_code in {400, 401, 403, 404, 429} else status.HTTP_502_BAD_GATEWAY,
            detail=f"{prefix}{detail}",
        )

    def _bedrock_auth_attempts(self, *, host: str, path: str, body: bytes) -> list[tuple[str, dict[str, str]]]:
        auth_mode = settings.bedrock_auth_mode.lower()
        attempts: list[tuple[str, dict[str, str]]] = []

        if auth_mode in {"auto", "api_key", "api-key", "bearer"} and settings.bedrock_api_key:
            attempts.append(("api_key", self._bedrock_api_key_headers()))

        if auth_mode in {"auto", "aws", "sigv4"} and settings.aws_access_key_id and settings.aws_secret_access_key:
            attempts.append(("aws_sigv4", self._bedrock_sigv4_headers(host=host, path=path, body=body)))

        if not attempts:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Bedrock is not configured. Set BEDROCK_API_KEY or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.",
            )
        return attempts

    def _complete_openai(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> tuple[str, dict[str, int], str]:
        try:
            response = httpx.post(
                f"{settings.OPENAI_BASE_URL.rstrip('/')}/chat/completions",
                headers=self._openai_headers(),
                json=self._openai_payload(messages, model=model, max_tokens=max_tokens),
                timeout=request_timeout or 90,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"OpenAI request failed: {exc}",
            ) from exc

        if response.status_code >= 400:
            self._raise_openai_error(response.status_code, response.text)

        completion = response.json()
        content = self._content_to_text(completion.get("choices", [{}])[0].get("message", {}).get("content"))
        return content, self.extract_usage(completion), model

    def _complete_bedrock_mantle(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> tuple[str, dict[str, int], str]:
        try:
            response = httpx.post(
                f"{settings.bedrock_mantle_base_url}/chat/completions",
                headers=self._bedrock_mantle_headers(),
                json=self._bedrock_mantle_payload(messages, model=model, max_tokens=max_tokens),
                timeout=request_timeout or 90,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Bedrock Mantle request failed: {exc}",
            ) from exc

        if response.status_code >= 400:
            self._raise_bedrock_error(response.status_code, response.text, auth_label="mantle_api_key")

        completion = response.json()
        content = self._content_to_text(completion.get("choices", [{}])[0].get("message", {}).get("content"))
        return content, self.extract_usage(completion), model

    def _complete_bedrock_runtime(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> tuple[str, dict[str, int], str]:
        url, host, path = self._bedrock_endpoint_parts(model)
        body = json.dumps(
            self._bedrock_payload(messages, temperature=temperature, max_tokens=max_tokens),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        last_error: tuple[int, str, str] | None = None
        for auth_label, headers in self._bedrock_auth_attempts(host=host, path=path, body=body):
            try:
                response = httpx.post(
                    url,
                    headers=headers,
                    content=body,
                    timeout=request_timeout or 90,
                )
            except httpx.HTTPError as exc:
                last_error = (status.HTTP_502_BAD_GATEWAY, str(exc), auth_label)
                continue

            if response.status_code < 400:
                completion = response.json()
                content_parts = completion.get("output", {}).get("message", {}).get("content", [])
                content = self._content_to_text(content_parts)
                return content, self.extract_usage(completion), model

            last_error = (response.status_code, response.text, auth_label)
            detail = self._bedrock_error_detail(response.text).strip().lower()
            if detail not in {"operation not allowed"} and response.status_code not in {401, 403}:
                break

        if last_error:
            status_code, body_text, auth_label = last_error
            self._raise_bedrock_error(status_code, body_text, auth_label=auth_label)

        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Bedrock request failed: no auth attempt was executed.",
        )

    def _complete_bedrock(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
        web_search: bool = False,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
        allow_fallback: bool = True,
    ) -> tuple[str, dict[str, int], str]:
        endpoint_mode = settings.bedrock_endpoint_mode.lower()
        attempts: list[Any] = []
        if endpoint_mode in {"runtime", "converse"}:
            attempts.append(
                lambda: self._complete_bedrock_runtime(
                    messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    request_timeout=request_timeout,
                )
            )
            attempts.append(lambda: self._complete_bedrock_mantle(messages, model=model, max_tokens=max_tokens, request_timeout=request_timeout))
        else:
            attempts.append(lambda: self._complete_bedrock_mantle(messages, model=model, max_tokens=max_tokens, request_timeout=request_timeout))
            attempts.append(
                lambda: self._complete_bedrock_runtime(
                    messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    request_timeout=request_timeout,
                )
            )

        last_error: HTTPException | None = None
        for attempt in attempts:
            try:
                return attempt()
            except HTTPException as exc:
                last_error = exc

        if not allow_fallback:
            if last_error:
                raise last_error
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Bedrock request failed before fallback.",
            )

        try:
            return self._complete_groq(
                messages,
                model=self._groq_model_for_fallback(web_search=web_search),
                temperature=temperature,
                max_tokens=max_tokens,
                request_timeout=request_timeout,
            )
        except HTTPException as groq_error:
            if last_error:
                raise HTTPException(
                    status_code=last_error.status_code,
                    detail=f"{last_error.detail} Groq fallback also failed: {groq_error.detail}",
                ) from groq_error
            raise

    def _stream_openai(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
    ) -> Iterable[Any]:
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream(
                    "POST",
                    f"{settings.OPENAI_BASE_URL.rstrip('/')}/chat/completions",
                    headers=self._openai_headers(),
                    json=self._openai_payload(messages, model=model, stream=True),
                ) as response:
                    if response.status_code >= 400:
                        self._raise_openai_error(
                            response.status_code,
                            response.read().decode("utf-8", errors="replace"),
                        )

                    for line in response.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        if data:
                            yield json.loads(data)
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"OpenAI request failed: {exc}",
            ) from exc

    def _stream_bedrock_mantle(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
    ) -> Iterable[Any]:
        try:
            with httpx.Client(timeout=None) as client:
                with client.stream(
                    "POST",
                    f"{settings.bedrock_mantle_base_url}/chat/completions",
                    headers=self._bedrock_mantle_headers(),
                    json=self._bedrock_mantle_payload(messages, model=model, stream=True),
                ) as response:
                    if response.status_code >= 400:
                        self._raise_bedrock_error(
                            response.status_code,
                            response.read().decode("utf-8", errors="replace"),
                            auth_label="mantle_api_key",
                        )

                    for line in response.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line.removeprefix("data:").strip()
                        if data == "[DONE]":
                            break
                        if data:
                            yield json.loads(data)
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Bedrock Mantle request failed: {exc}",
            ) from exc

    def _stream_bedrock_runtime(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
    ) -> Iterable[Any]:
        content, usage, _ = self._complete_bedrock(
            messages,
            model=model,
            temperature=temperature,
        )
        yield {"bedrock_delta": content, "usage": usage}

    def _stream_bedrock(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
        web_search: bool = False,
        allow_fallback: bool = True,
    ) -> Iterable[Any]:
        endpoint_mode = settings.bedrock_endpoint_mode.lower()

        def iterator():
            attempts: list[Any] = []
            if endpoint_mode in {"runtime", "converse"}:
                attempts.append(
                    lambda: self._stream_bedrock_runtime(
                        messages,
                        model=model,
                        temperature=temperature,
                    )
                )
                attempts.append(lambda: self._stream_bedrock_mantle(messages, model=model))
            else:
                attempts.append(lambda: self._stream_bedrock_mantle(messages, model=model))
                attempts.append(
                    lambda: self._stream_bedrock_runtime(
                        messages,
                        model=model,
                        temperature=temperature,
                    )
                )

            last_error: HTTPException | None = None
            for attempt in attempts:
                try:
                    yield from attempt()
                    return
                except HTTPException as exc:
                    last_error = exc

            if not allow_fallback:
                if last_error:
                    raise last_error
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Bedrock request failed before fallback.",
                )

            try:
                yield from self._stream_groq(
                    messages,
                    model=self._groq_model_for_fallback(web_search=web_search),
                    temperature=temperature,
                )
            except HTTPException as groq_error:
                if last_error:
                    raise HTTPException(
                        status_code=last_error.status_code,
                        detail=f"{last_error.detail} Groq fallback also failed: {groq_error.detail}",
                    ) from groq_error
                raise

        return iterator()

    def _complete_groq(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
    ) -> tuple[str, dict[str, int], str]:
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

    def _stream_groq(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str,
        temperature: float | None = None,
    ) -> Iterable[Any]:
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

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        provider: str | None = None,
        web_search: bool = False,
        temperature: float | None = None,
        max_tokens: int | None = None,
        request_timeout: float | None = None,
        allow_bedrock_fallback: bool = True,
    ) -> tuple[str, dict[str, int], str]:
        selected_provider = self.selected_provider(provider)
        selected_model = self.selected_model(
            model,
            provider=selected_provider,
            web_search=web_search,
        )
        if selected_provider == "openai":
            return self._complete_openai(
                messages,
                model=selected_model,
                max_tokens=max_tokens,
                request_timeout=request_timeout,
            )
        if selected_provider == "bedrock":
            return self._complete_bedrock(
                messages,
                model=selected_model,
                temperature=temperature,
                web_search=web_search,
                max_tokens=max_tokens,
                request_timeout=request_timeout,
                allow_fallback=allow_bedrock_fallback,
            )

        return self._complete_groq(
            messages,
            model=selected_model,
            temperature=temperature,
            max_tokens=max_tokens,
            request_timeout=request_timeout,
        )

    def stream(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        provider: str | None = None,
        web_search: bool = False,
        temperature: float | None = None,
        allow_bedrock_fallback: bool = True,
    ) -> Iterable[Any]:
        selected_provider = self.selected_provider(provider)
        selected_model = self.selected_model(
            model,
            provider=selected_provider,
            web_search=web_search,
        )
        if selected_provider == "openai":
            return self._stream_openai(messages, model=selected_model)
        if selected_provider == "bedrock":
            return self._stream_bedrock(
                messages,
                model=selected_model,
                temperature=temperature,
                web_search=web_search,
                allow_fallback=allow_bedrock_fallback,
            )

        return self._stream_groq(messages, model=selected_model, temperature=temperature)

    def analyze_image(self, image_bytes: bytes, filename: str, prompt: str) -> str:
        suffix = Path(filename).suffix.lower().replace(".", "") or "png"
        mime = "jpeg" if suffix == "jpg" else suffix
        encoded = base64.b64encode(image_bytes).decode("ascii")
        try:
            completion = self._client().chat.completions.create(
                model=settings.GROQ_VISION_MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/{mime};base64,{encoded}"},
                            },
                        ],
                    }
                ],
                max_tokens=settings.GROQ_MAX_TOKENS,
            )
        except GroqError as exc:
            self._handle_groq_error(exc)
        return self._content_to_text(completion.choices[0].message.content)

    def transcribe_audio(self, audio_bytes: bytes, filename: str) -> str:
        suffix = Path(filename).suffix or ".webm"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(audio_bytes)
                temp_path = tmp.name

            with open(temp_path, "rb") as audio_file:
                try:
                    transcription = self._client().audio.transcriptions.create(
                        file=audio_file,
                        model=settings.GROQ_AUDIO_MODEL,
                        response_format="json",
                    )
                except GroqError as exc:
                    self._handle_groq_error(exc)
            return getattr(transcription, "text", "") or ""
        finally:
            if temp_path:
                Path(temp_path).unlink(missing_ok=True)

    @staticmethod
    def extract_stream_delta(chunk: Any) -> str:
        if isinstance(chunk, dict):
            if "bedrock_delta" in chunk:
                return GroqService._content_to_text(chunk.get("bedrock_delta"))
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
            total_tokens = int(prompt_tokens or 0) + int(completion_tokens or 0)

        return {
            "prompt_tokens": int(prompt_tokens),
            "completion_tokens": int(completion_tokens),
            "total_tokens": int(total_tokens),
        }

    @staticmethod
    def extract_usage(completion: Any) -> dict[str, int]:
        if isinstance(completion, dict):
            usage = completion.get("usage")
            if not usage:
                return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            return GroqService._normalize_usage(usage)

        usage = getattr(completion, "usage", None)
        if not usage:
            return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        return {
            "prompt_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "completion_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
            "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
        }


groq_service = GroqService()
