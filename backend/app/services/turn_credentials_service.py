import base64
import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from app.core.config import settings
from app.schemas.call import TurnCredentials

TURN_UNAVAILABLE_MESSAGE = "Calling network relay is temporarily unavailable."


def _validate_ice_server(raw_server: Any) -> dict[str, Any]:
    if not isinstance(raw_server, dict):
        raise ValueError("Invalid TURN provider response.")
    urls = raw_server.get("urls")
    if isinstance(urls, str):
        normalized_urls = [urls]
    elif isinstance(urls, list) and all(isinstance(url, str) for url in urls):
        normalized_urls = urls
    else:
        raise ValueError("Invalid TURN provider response.")
    normalized_urls = [url.strip() for url in normalized_urls if url.strip()]
    if not normalized_urls or not all(url.startswith(("stun:", "turn:", "turns:")) for url in normalized_urls):
        raise ValueError("Invalid TURN provider response.")
    server: dict[str, Any] = {"urls": urls if isinstance(urls, str) else normalized_urls}
    if any(url.startswith(("turn:", "turns:")) for url in normalized_urls):
        username = raw_server.get("username")
        credential = raw_server.get("credential")
        if not isinstance(username, str) or not username.strip() or not isinstance(credential, str) or not credential:
            raise ValueError("Invalid TURN provider response.")
        server["username"] = username
        server["credential"] = credential
        if isinstance(raw_server.get("credentialType"), str):
            server["credentialType"] = raw_server["credentialType"]
    return server


def _validate_ice_servers(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("Invalid TURN provider response.")
    ice_servers = [_validate_ice_server(server) for server in payload]
    if not ice_servers:
        raise ValueError("Invalid TURN provider response.")
    if not any(
        url.startswith(("turn:", "turns:"))
        for server in ice_servers
        for url in ([server["urls"]] if isinstance(server["urls"], str) else server["urls"])
    ):
        raise ValueError("Invalid TURN provider response.")
    return ice_servers


async def _create_metered_turn_credentials() -> TurnCredentials:
    if not settings.metered_turn_configured or not settings.metered_domain or not settings.metered_turn_api_key:
        raise RuntimeError(TURN_UNAVAILABLE_MESSAGE)
    url = f"https://{settings.metered_domain}/api/v1/turn/credentials"
    try:
        async with httpx.AsyncClient(timeout=settings.METERED_TURN_TIMEOUT_SECONDS) as client:
            response = await client.get(url, params={"apiKey": settings.metered_turn_api_key})
            response.raise_for_status()
        ice_servers = _validate_ice_servers(response.json())
    except (httpx.HTTPError, ValueError):
        raise RuntimeError(TURN_UNAVAILABLE_MESSAGE) from None
    return TurnCredentials(
        configured=True,
        provider="metered",
        ice_servers=ice_servers,
        relay_configured=True,
    )


async def create_turn_credentials(user_id: str) -> TurnCredentials:
    if settings.turn_provider == "metered":
        return await _create_metered_turn_credentials()

    if not settings.turn_configured:
        if settings.is_production:
            raise RuntimeError(TURN_UNAVAILABLE_MESSAGE)
        return TurnCredentials(
            configured=False,
            provider="development",
            ice_servers=[{"urls": ["stun:stun.l.google.com:19302"]}],
            relay_configured=False,
            warning=TURN_UNAVAILABLE_MESSAGE,
        )

    expires_at = int(time.time()) + settings.TURN_CREDENTIAL_TTL
    username = f"{expires_at}:{user_id}"
    digest = hmac.new(
        settings.turn_shared_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1
    ).digest()
    credential = base64.b64encode(digest).decode("ascii")
    return TurnCredentials(
        configured=True,
        provider="coturn",
        ice_servers=[
            {
                "urls": settings.TURN_SERVER_URLS,
                "username": username,
                "credential": credential,
                "credentialType": "password",
            }
        ],
        expires_at=datetime.fromtimestamp(expires_at, tz=timezone.utc),
        relay_configured=True,
    )
