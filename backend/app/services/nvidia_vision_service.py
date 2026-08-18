import base64
import logging
import os
import time
from typing import Any

import httpx
from fastapi import HTTPException, status

logger = logging.getLogger("auto_ai.nvidia_vision")


class NvidiaVisionService:
    """Reliable NVIDIA NIM VLM client with large-image asset support and retries."""

    def _value(self, name: str, default: str) -> str:
        return os.getenv(name, default).strip()

    def _api_key(self) -> str:
        key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not key:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="NVIDIA_API_KEY is not configured.")
        return key

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key()}", "Accept": "application/json", "Content-Type": "application/json"}

    @staticmethod
    def _mime(filename: str, mime_type: str | None = None) -> str:
        allowed = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
        if mime_type in allowed:
            return "image/jpeg" if mime_type == "image/jpg" else mime_type
        suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else "jpg"
        return {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix, "image/jpeg")

    def _upload_large_image(self, image: bytes, mime: str, filename: str, timeout: float) -> str:
        """NVIDIA hosted VLM requires NVCF assets for sufficiently large images."""
        asset_url = self._value("NVIDIA_ASSET_URL", "https://api.nvcf.nvidia.com/v2/nvcf/assets")
        description = f"Auto-AI vision image: {filename[:120]}"
        try:
            create = httpx.post(
                asset_url,
                headers={"Authorization": f"Bearer {self._api_key()}", "Accept": "application/json", "Content-Type": "application/json"},
                json={"contentType": mime, "description": description},
                timeout=timeout,
            )
            if create.status_code in {401, 403}:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA API key cannot create image assets.")
            create.raise_for_status()
            asset = create.json()
            upload_url = asset.get("uploadUrl")
            asset_id = asset.get("assetId")
            if not upload_url or not asset_id:
                logger.error("NVIDIA asset response missing uploadUrl/assetId")
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA image asset upload could not be initialized.")
            upload = httpx.put(
                upload_url,
                content=image,
                headers={"x-amz-meta-nvcf-asset-description": description, "Content-Type": mime},
                timeout=max(timeout, 120.0),
            )
            upload.raise_for_status()
            # NVIDIA VLM accepts an asset reference as a data URI in image_url.
            return f"data:{mime};asset_id,{asset_id}"
        except HTTPException:
            raise
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.exception("NVIDIA large-image asset upload failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA image upload failed.") from exc

    def _image_reference(self, image: bytes, mime: str, filename: str, timeout: float) -> str:
        # NVIDIA documents an inline-image limit of about 180 KB for this hosted VLM.
        inline_limit = int(os.getenv("NVIDIA_INLINE_IMAGE_LIMIT_BYTES", str(180 * 1024)))
        if len(image) <= inline_limit:
            encoded = base64.b64encode(image).decode("ascii")
            return f"data:{mime};base64,{encoded}"
        return self._upload_large_image(image, mime, filename, timeout)

    @staticmethod
    def _retryable(status_code: int) -> bool:
        return status_code in {408, 409, 425, 429} or status_code >= 500

    def analyze_image(
        self,
        image: bytes,
        filename: str,
        prompt: str,
        *,
        mime_type: str | None = None,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> str:
        if not image:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image is empty.")
        request_timeout = timeout or float(os.getenv("NVIDIA_REQUEST_TIMEOUT_SECONDS", "60"))
        mime = self._mime(filename, mime_type)
        image_ref = self._image_reference(image, mime, filename, request_timeout)
        payload: dict[str, Any] = {
            "model": self._value("NVIDIA_VISION_MODEL", "nvidia/llama-3.1-nemotron-nano-vl-8b-v1"),
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_ref}},
                {"type": "text", "text": prompt},
            ]}],
            "temperature": float(os.getenv("NVIDIA_VISION_TEMPERATURE", "0.2")),
            "top_p": float(os.getenv("NVIDIA_VISION_TOP_P", "0.9")),
            "max_tokens": max_tokens or int(os.getenv("NVIDIA_VISION_MAX_TOKENS", "2048")),
            "stream": False,
        }
        endpoint = f"{self._value('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').rstrip('/')}/chat/completions"
        attempts = max(1, int(os.getenv("NVIDIA_RETRY_ATTEMPTS", "2")))
        last_status = 0
        last_body = ""
        for attempt in range(attempts):
            try:
                response = httpx.post(endpoint, headers=self._headers(), json=payload, timeout=request_timeout)
            except httpx.TimeoutException as exc:
                if attempt + 1 < attempts:
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="NVIDIA vision request timed out.") from exc
            except httpx.HTTPError as exc:
                if attempt + 1 < attempts:
                    time.sleep(0.5 * (2 ** attempt))
                    continue
                logger.exception("NVIDIA vision network failure")
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA vision service is unreachable.") from exc
            last_status = response.status_code
            last_body = response.text[:1000]
            if response.status_code in {401, 403}:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA API key was rejected or lacks permission.")
            if response.status_code == 429:
                if attempt + 1 < attempts:
                    time.sleep(1.0 * (2 ** attempt))
                    continue
                raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="NVIDIA vision rate limit reached. Please retry shortly.")
            if self._retryable(response.status_code) and attempt + 1 < attempts:
                time.sleep(0.5 * (2 ** attempt))
                continue
            break

        if last_status >= 400:
            logger.warning("NVIDIA vision request failed status=%s body=%s", last_status, last_body)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"NVIDIA vision analysis failed (HTTP {last_status}).")

        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            logger.warning("NVIDIA returned unexpected response: %s", last_body)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA returned an invalid vision response.") from exc
        if isinstance(content, list):
            content = "".join(item.get("text", "") if isinstance(item, dict) else str(item) for item in content)
        result = str(content or "").strip()
        if not result:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA returned an empty vision response.")
        return result


nvidia_vision_service = NvidiaVisionService()
