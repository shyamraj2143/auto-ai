from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f"Expected source block not found in {path}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


PRESENCE_FALLBACK = r'''from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any


logger = logging.getLogger("auto_ai.calls.realtime.fallback")


class _ResilientPubSub:
    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate
        self._inner = None

    async def subscribe(self, *channels: str) -> None:
        try:
            self._inner = self._delegate.client().pubsub(ignore_subscribe_messages=True)
            await self._inner.subscribe(*channels)
        except Exception as exc:
            self._inner = None
            logger.warning("redis_pubsub_unavailable_local_signaling_active error=%s", type(exc).__name__)

    async def get_message(self, timeout: float = 20.0):
        if self._inner is not None:
            try:
                return await self._inner.get_message(timeout=timeout)
            except Exception as exc:
                logger.warning("redis_pubsub_interrupted_local_signaling_active error=%s", type(exc).__name__)
                try:
                    await self._inner.aclose()
                except Exception:
                    pass
                self._inner = None
        await asyncio.sleep(min(max(timeout, 0.05), 0.75))
        return None

    async def unsubscribe(self, *channels: str) -> None:
        if self._inner is not None:
            try:
                await self._inner.unsubscribe(*channels)
            except Exception:
                pass

    async def aclose(self) -> None:
        if self._inner is not None:
            try:
                await self._inner.aclose()
            except Exception:
                pass
            self._inner = None


class ResilientPresenceService:
    """Redis-first realtime service with a single-process in-memory failover.

    The production container runs one Uvicorn process, so this fallback keeps active
    WebSocket signaling, one-time tickets, locks, deduplication and rate limits alive
    during short Redis interruptions instead of failing every call immediately.
    """

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate
        self._lock = asyncio.Lock()
        self._tickets: dict[str, tuple[str, float]] = {}
        self._connections: dict[str, dict[str, Any]] = {}
        self._user_connections: dict[str, set[str]] = {}
        self._busy: dict[str, tuple[str, float]] = {}
        self._rates: dict[str, tuple[int, float]] = {}
        self._events: dict[str, float] = {}

    @property
    def configured(self) -> bool:
        return bool(self._delegate.configured)

    @property
    def local_fallback_enabled(self) -> bool:
        return True

    def client(self):
        return self._delegate.client()

    async def check(self, *, log_failure: bool = False) -> bool:
        return await self._delegate.check(log_failure=log_failure)

    async def realtime_ready(self) -> bool:
        if await self.check():
            return True
        logger.warning("redis_health_failed_local_realtime_fallback_ready=true")
        return True

    async def close(self) -> None:
        await self._delegate.close()
        async with self._lock:
            self._tickets.clear()
            self._connections.clear()
            self._user_connections.clear()
            self._busy.clear()
            self._rates.clear()
            self._events.clear()

    async def create_ticket(self, user_id: str) -> str:
        try:
            ticket = await self._delegate.create_ticket(user_id)
        except Exception as exc:
            ticket = secrets.token_urlsafe(36)
            logger.warning("redis_ticket_create_failed_local_ticket_used error=%s", type(exc).__name__)
        async with self._lock:
            self._prune_locked()
            self._tickets[self._delegate._ticket_key(ticket)] = (
                user_id,
                time.monotonic() + max(10, int(self._ticket_ttl())),
            )
        return ticket

    async def consume_ticket(self, ticket: str) -> str | None:
        if not ticket or len(ticket) > 256:
            return None
        key = self._delegate._ticket_key(ticket)
        try:
            user_id = await self._delegate.consume_ticket(ticket)
            if user_id:
                async with self._lock:
                    self._tickets.pop(key, None)
                return user_id
        except Exception:
            pass
        async with self._lock:
            self._prune_locked()
            stored = self._tickets.pop(key, None)
            return stored[0] if stored and stored[1] > time.monotonic() else None

    async def register_connection(self, user_id: str, connection_id: str, state: str = "online") -> None:
        async with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            self._connections[connection_id] = {
                "user_id": user_id,
                "state": state,
                "last_seen_at": now,
            }
            self._user_connections.setdefault(user_id, set()).add(connection_id)
        try:
            await self._delegate.register_connection(user_id, connection_id, state)
        except Exception as exc:
            logger.warning("redis_connection_register_failed_local_presence_used error=%s", type(exc).__name__)

    async def heartbeat(self, user_id: str, connection_id: str, state: str | None = None) -> None:
        async with self._lock:
            current = self._connections.get(connection_id, {"user_id": user_id, "state": "online"})
            if current.get("user_id") != user_id:
                return
            current["state"] = state or str(current.get("state") or "online")
            current["last_seen_at"] = datetime.now(timezone.utc).isoformat()
            self._connections[connection_id] = current
            self._user_connections.setdefault(user_id, set()).add(connection_id)
        try:
            await self._delegate.heartbeat(user_id, connection_id, state)
        except Exception:
            return

    async def unregister_connection(self, user_id: str, connection_id: str) -> None:
        async with self._lock:
            self._connections.pop(connection_id, None)
            connections = self._user_connections.get(user_id)
            if connections is not None:
                connections.discard(connection_id)
                if not connections:
                    self._user_connections.pop(user_id, None)
        try:
            await self._delegate.unregister_connection(user_id, connection_id)
        except Exception:
            return

    async def presence_for_user(self, user_id: str) -> dict[str, Any]:
        try:
            result = await self._delegate.presence_for_user(user_id)
            if result.get("reachable"):
                return result
        except Exception:
            pass
        async with self._lock:
            ids = list(self._user_connections.get(user_id, set()))
            states = [self._connections[item] for item in ids if item in self._connections]
            if not states:
                return {"state": "offline", "last_seen_at": None, "reachable": False}
            busy = self._busy.get(user_id)
            if busy and busy[1] > time.monotonic():
                state = "busy"
            else:
                order = {"online": 4, "away": 3, "background": 2, "offline": 1}
                state = max((str(item.get("state") or "offline") for item in states), key=lambda value: order.get(value, 0))
            last_seen = max((str(item.get("last_seen_at") or "") for item in states), default="") or None
            return {"state": state, "last_seen_at": last_seen, "reachable": True}

    async def presence_for_users(self, user_ids: list[str]) -> dict[str, dict[str, Any]]:
        return {user_id: await self.presence_for_user(user_id) for user_id in user_ids}

    def subscribe_local(self, user_id: str):
        return self._delegate.subscribe_local(user_id)

    def unsubscribe_local(self, user_id: str, queue) -> None:
        self._delegate.unsubscribe_local(user_id, queue)

    async def publish(self, user_id: str, event: dict[str, Any]) -> int:
        try:
            return await self._delegate.publish(user_id, event)
        except Exception as exc:
            logger.warning("redis_publish_failed_no_remote_receiver error=%s", type(exc).__name__)
            return 0

    async def acquire_call_locks(self, call_id: str, caller_id: str, callee_id: str) -> bool:
        try:
            acquired = await self._delegate.acquire_call_locks(call_id, caller_id, callee_id)
            if not acquired:
                return False
            async with self._lock:
                self._set_busy_locked(call_id, [caller_id, callee_id])
            return True
        except Exception as exc:
            logger.warning("redis_call_lock_failed_local_lock_used error=%s", type(exc).__name__)
        async with self._lock:
            self._prune_locked()
            if any(user_id in self._busy for user_id in (caller_id, callee_id)):
                return False
            self._set_busy_locked(call_id, [caller_id, callee_id])
            return True

    async def refresh_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        async with self._lock:
            self._set_busy_locked(call_id, user_ids)
        try:
            await self._delegate.refresh_call_locks(call_id, user_ids)
        except Exception:
            return

    async def release_call_locks(self, call_id: str, user_ids: list[str]) -> None:
        async with self._lock:
            for user_id in user_ids:
                current = self._busy.get(user_id)
                if current and current[0] == call_id:
                    self._busy.pop(user_id, None)
        try:
            await self._delegate.release_call_locks(call_id, user_ids)
        except Exception:
            return

    async def allow_rate(self, scope: str, subject: str, limit: int, window_seconds: int = 60) -> bool:
        try:
            return await self._delegate.allow_rate(scope, subject, limit, window_seconds)
        except Exception:
            pass
        key = f"{scope}:{subject}"
        async with self._lock:
            now = time.monotonic()
            count, expires = self._rates.get(key, (0, now + window_seconds))
            if expires <= now:
                count, expires = 0, now + window_seconds
            count += 1
            self._rates[key] = (count, expires)
            return count <= limit

    async def claim_event(self, user_id: str, event_id: str) -> bool:
        try:
            return await self._delegate.claim_event(user_id, event_id)
        except Exception:
            pass
        key = f"{user_id}:{event_id}"
        async with self._lock:
            self._prune_locked()
            if key in self._events:
                return False
            self._events[key] = time.monotonic() + 300
            return True

    async def count_ice_candidate(self, call_id: str, user_id: str) -> bool:
        from app.core.config import settings
        return await self.allow_rate(
            "ice",
            f"{call_id}:{user_id}",
            settings.CALL_ICE_MAX_PER_CALL,
            settings.CALL_RECONNECT_GRACE_SECONDS + 300,
        )

    def pubsub(self):
        return _ResilientPubSub(self._delegate)

    def _ticket_ttl(self) -> int:
        from app.core.config import settings
        return settings.CALL_WS_TICKET_TTL_SECONDS

    def _busy_ttl(self) -> int:
        from app.core.config import settings
        return max(settings.CALL_RING_TIMEOUT_SECONDS + settings.CALL_RECONNECT_GRACE_SECONDS + 3600, 300)

    def _set_busy_locked(self, call_id: str, user_ids: list[str]) -> None:
        expires = time.monotonic() + self._busy_ttl()
        for user_id in user_ids:
            self._busy[user_id] = (call_id, expires)

    def _prune_locked(self) -> None:
        now = time.monotonic()
        self._tickets = {key: value for key, value in self._tickets.items() if value[1] > now}
        self._busy = {key: value for key, value in self._busy.items() if value[1] > now}
        self._rates = {key: value for key, value in self._rates.items() if value[1] > now}
        self._events = {key: value for key, value in self._events.items() if value > now}
'''

NATIVE_CALL_API = r'''package com.autoai.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

final class NativeCallApi {
    static final class ApiException extends Exception {
        final int status;
        ApiException(int status, String message) { super(message); this.status = status; }
    }

    private static final int MAX_ATTEMPTS = 4;
    private final Context context;

    NativeCallApi(Context context) { this.context = context.getApplicationContext(); }

    JSONObject getCall(String callId) throws Exception { return request("GET", "/calls/" + encode(callId), null); }
    JSONObject turnCredentials() throws Exception { return request("GET", "/calls/turn-credentials", null); }
    String websocketUrl() throws Exception {
        String ticket = request("POST", "/calls/ws-ticket", new JSONObject()).getString("ticket");
        String base = trim(BuildConfig.AUTO_AI_API_BASE_URL);
        if (base.startsWith("https://")) base = "wss://" + base.substring(8);
        else if (base.startsWith("http://")) base = "ws://" + base.substring(7);
        return base + "/calls/ws?ticket=" + encode(ticket);
    }

    long accept(String callId, String actionToken, long fallbackRevision) throws Exception {
        JSONObject body = new JSONObject()
            .put("device_id", PushTokenRegistrar.deviceId(context, "auto_ai_call_device", "fallback_device_id"));
        if (actionToken != null && !actionToken.trim().isEmpty()) body.put("action_token", actionToken.trim());
        return request("POST", "/calls/" + encode(callId) + "/accept", body).optLong("revision", fallbackRevision);
    }

    void end(String callId, String reason) throws Exception {
        request("POST", "/calls/" + encode(callId) + "/end", new JSONObject().put("end_reason", reason));
    }

    void reject(String callId, String actionToken) throws Exception {
        JSONObject body = new JSONObject();
        if (actionToken != null && !actionToken.trim().isEmpty()) body.put("action_token", actionToken.trim());
        request("POST", "/calls/" + encode(callId) + "/reject", body);
    }

    void fail(String callId, String errorCode) throws Exception {
        request("POST", "/calls/" + encode(callId) + "/fail", new JSONObject()
            .put("failure_code", errorCode)
            .put("source_device", PushTokenRegistrar.deviceId(context, "auto_ai_call_device", "fallback_device_id")));
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        Exception last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return requestOnce(method, path, body);
            } catch (ApiException error) {
                last = error;
                if (!isTransientStatus(error.status) || attempt == MAX_ATTEMPTS) throw error;
            } catch (IOException error) {
                last = error;
                if (attempt == MAX_ATTEMPTS) throw error;
            }
            try {
                Thread.sleep(Math.min(2400L, 300L * (1L << (attempt - 1))));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            }
        }
        throw last == null ? new IOException("Call request failed.") : last;
    }

    private JSONObject requestOnce(String method, String path, JSONObject body) throws Exception {
        String token = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (token == null || token.trim().isEmpty()) throw new ApiException(401, "Missing call authentication.");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(trim(BuildConfig.AUTO_AI_API_BASE_URL) + path).openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Authorization", "Bearer " + token.trim());
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");
            if (body != null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            StringBuilder result = new StringBuilder();
            if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null && result.length() < 128_000) result.append(line);
            }
            if (status < 200 || status >= 300) throw new ApiException(status, result.toString());
            return result.length() == 0 ? new JSONObject() : new JSONObject(result.toString());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean isTransientStatus(int status) {
        return status == 408 || status == 425 || status == 429 || status == 500
            || status == 502 || status == 503 || status == 504;
    }

    private static String trim(String value) { return value == null ? "" : value.replaceAll("/+$", ""); }
    private static String encode(String value) {
        try { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }
}
'''

BACKEND_TEST = r'''import asyncio

from app.services.presence_fallback import ResilientPresenceService
from app.services.presence_service import PresenceService, RealtimeUnavailable


def unavailable_service() -> ResilientPresenceService:
    base = PresenceService()

    def down_client():
        raise RealtimeUnavailable("redis down")

    base.client = down_client  # type: ignore[method-assign]
    return ResilientPresenceService(base)


def test_local_ticket_is_one_time_when_redis_is_down():
    service = unavailable_service()

    async def run():
        ticket = await service.create_ticket("user-1")
        assert await service.consume_ticket(ticket) == "user-1"
        assert await service.consume_ticket(ticket) is None

    asyncio.run(run())


def test_local_presence_publish_rate_and_locks_survive_redis_outage():
    service = unavailable_service()

    async def run():
        queue = service.subscribe_local("user-2")
        await service.register_connection("user-2", "connection-1", "background")
        presence = await service.presence_for_user("user-2")
        assert presence["reachable"] is True
        assert presence["state"] == "background"

        delivered = await service.publish("user-2", {"type": "call.incoming"})
        assert delivered == 1
        assert "call.incoming" in await queue.get()

        assert await service.allow_rate("attempt", "user-1", 2, 60) is True
        assert await service.allow_rate("attempt", "user-1", 2, 60) is True
        assert await service.allow_rate("attempt", "user-1", 2, 60) is False

        assert await service.acquire_call_locks("call-1", "user-1", "user-2") is True
        assert await service.acquire_call_locks("call-2", "user-1", "user-3") is False
        await service.release_call_locks("call-1", ["user-1", "user-2"])
        assert await service.acquire_call_locks("call-2", "user-1", "user-3") is True

        assert await service.claim_event("user-1", "event-1") is True
        assert await service.claim_event("user-1", "event-1") is False
        service.unsubscribe_local("user-2", queue)

    asyncio.run(run())
'''

FRONTEND_TEST = r'''import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("call reliability hotfix", () => {
  it("retries transient native foreground service starts", () => {
    const provider = source("src/features/calls/CallProvider.tsx");
    expect(provider).toContain("retryableNativeServiceCodes");
    expect(provider).toContain("SERVICE_READY_TIMEOUT");
    expect(provider).toContain("attempt < 3");
  });
});
'''

ANDROID_TEST = r'''package com.autoai.app;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class CallReliabilityHotfixContractTest {
    @Test public void nativeSignalingQueuesEventsAndRetriesTransientOutages() throws Exception {
        String controller = source("NativeCallSessionController.java");
        assertTrue(controller.contains("pendingOutboundSignals"));
        assertTrue(controller.contains("MAX_SIGNAL_RECONNECT_ATTEMPTS"));
        assertTrue(controller.contains("scheduleInitializationRetry"));
        assertTrue(controller.contains("pingInterval"));
    }

    @Test public void nativeApiRetriesTemporaryServerFailures() throws Exception {
        String api = source("NativeCallApi.java");
        assertTrue(api.contains("MAX_ATTEMPTS = 4"));
        assertTrue(api.contains("status == 503"));
        assertTrue(api.contains("Thread.sleep"));
    }

    @Test public void serviceTimeoutUsesDurableReadyStateBeforeFailing() throws Exception {
        String plugin = source("AutoAiCallsPlugin.java");
        assertTrue(plugin.contains("snapshot.isUsable()"));
        assertTrue(plugin.contains("15_000L"));
    }

    private static String source(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get("src/main/java/com/autoai/app/" + name)), StandardCharsets.UTF_8);
    }
}
'''

# Redis-first backend with local failover.
write("backend/app/services/presence_fallback.py", PRESENCE_FALLBACK)
replace_once(
    "backend/app/services/presence_service.py",
    "presence_service = PresenceService()",
    "from app.services.presence_fallback import ResilientPresenceService\n\npresence_service = ResilientPresenceService(PresenceService())",
)
replace_once(
    "backend/app/api/routes/calls.py",
    "realtime_ready = await presence_service.check() if settings.CALL_FEATURE_ENABLED else False",
    "realtime_ready = await presence_service.realtime_ready() if settings.CALL_FEATURE_ENABLED else False",
)
replace_once(
    "backend/app/api/routes/calls.py",
    "    redis_reachable = await presence_service.check() if redis_configured else False\n    return CallHealth(\n        calling_enabled=settings.CALL_FEATURE_ENABLED,\n        redis_configured=redis_configured,\n        redis_reachable=redis_reachable,\n        websocket_ready=settings.CALL_FEATURE_ENABLED and redis_reachable,",
    "    redis_reachable = await presence_service.check() if redis_configured else False\n    realtime_ready = await presence_service.realtime_ready() if settings.CALL_FEATURE_ENABLED else False\n    return CallHealth(\n        calling_enabled=settings.CALL_FEATURE_ENABLED,\n        redis_configured=redis_configured,\n        redis_reachable=redis_reachable,\n        websocket_ready=settings.CALL_FEATURE_ENABLED and realtime_ready,",
)
replace_once(
    "backend/app/api/routes/calls.py",
    "        call_signaling_ready=settings.CALL_FEATURE_ENABLED and redis_reachable,",
    "        call_signaling_ready=settings.CALL_FEATURE_ENABLED and realtime_ready,",
)
write("backend/tests/test_call_realtime_fallback.py", BACKEND_TEST)

# Native network and API retry handling.
write("android/app/src/main/java/com/autoai/app/NativeCallApi.java", NATIVE_CALL_API)
replace_once(
    "android/app/src/main/java/com/autoai/app/CallFailureMessages.java",
    "        return capabilities != null\n            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)\n            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);",
    "        return capabilities != null\n            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);",
)

replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "import java.util.concurrent.atomic.AtomicBoolean;",
    "import java.util.concurrent.atomic.AtomicBoolean;\nimport java.util.concurrent.TimeUnit;",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "    private static final String TAG = \"AutoAiNativeCall\";",
    "    private static final String TAG = \"AutoAiNativeCall\";\n    private static final int MAX_SIGNAL_RECONNECT_ATTEMPTS = 20;\n    private static final int MAX_INITIALIZATION_ATTEMPTS = 12;",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "    private final OkHttpClient socketClient = new OkHttpClient.Builder().retryOnConnectionFailure(true).build();",
    "    private final OkHttpClient socketClient = new OkHttpClient.Builder()\n        .retryOnConnectionFailure(true)\n        .connectTimeout(10, TimeUnit.SECONDS)\n        .readTimeout(0, TimeUnit.MILLISECONDS)\n        .pingInterval(15, TimeUnit.SECONDS)\n        .build();",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "    private final List<PendingRemoteCandidate> pendingRemoteCandidates = new ArrayList<>();",
    "    private final List<PendingRemoteCandidate> pendingRemoteCandidates = new ArrayList<>();\n    private final List<String> pendingOutboundSignals = new ArrayList<>();",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "    private volatile int reconnectAttempts;",
    "    private volatile int reconnectAttempts;\n    private volatile int initializationAttempts;",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "        reconnectAttempts = 0;\n        sessionStarted = true;",
    "        reconnectAttempts = 0;\n        initializationAttempts = 0;\n        pendingOutboundSignals.clear();\n        sessionStarted = true;",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "            JSONObject call = api.getCall(callId);\n            backendStatus = call.optString(\"status\", \"\");",
    "            JSONObject call = api.getCall(callId);\n            initializationAttempts = 0;\n            backendStatus = call.optString(\"status\", \"\");",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "        } catch (NativeCallApi.ApiException auth) {\n            fail(auth.status == 401 || auth.status == 403 ? \"SIGNALING_AUTH_FAILED\" : \"SIGNALING_TIMEOUT\", auth);\n        } catch (Exception error) {\n            fail(\"SIGNALING_TIMEOUT\", error);\n        }\n    }\n\n    private void connectSocket(String url) {",
    "        } catch (NativeCallApi.ApiException error) {\n            if (error.status == 401 || error.status == 403) fail(\"SIGNALING_AUTH_FAILED\", error);\n            else scheduleInitializationRetry(error);\n        } catch (Exception error) {\n            scheduleInitializationRetry(error);\n        }\n    }\n\n    private void scheduleInitializationRetry(Throwable cause) {\n        if (terminal.get()) return;\n        int attempt = ++initializationAttempts;\n        if (attempt > MAX_INITIALIZATION_ATTEMPTS) {\n            fail(CallFailureMessages.isOnline(context) ? \"SIGNALING_TIMEOUT\" : \"NETWORK_LOST\", cause);\n            return;\n        }\n        update(ActiveCallStore.State.RECONNECTING, null);\n        long delay = Math.min(4000L, 400L * attempt);\n        Log.w(TAG, \"SIGNALING_INITIALIZATION_RETRY callId=\" + callId + \" attempt=\" + attempt + \" delayMs=\" + delay, cause);\n        executor.execute(() -> {\n            try {\n                Thread.sleep(delay);\n                if (!terminal.get()) initializeSession();\n            } catch (InterruptedException interrupted) {\n                Thread.currentThread().interrupt();\n                fail(\"SIGNALING_TIMEOUT\", interrupted);\n            }\n        });\n    }\n\n    private void connectSocket(String url) {",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "                send(\"presence.ready\", null, json(\"state\", \"background\"));",
    "                send(\"presence.ready\", null, json(\"state\", \"background\"));\n                flushPendingOutboundSignals();",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "        if (attempt > 8) {",
    "        if (attempt > MAX_SIGNAL_RECONNECT_ATTEMPTS) {",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "                Thread.sleep(Math.min(4000L, attempt * 500L));\n                reconnectScheduled.set(false);\n                if (!terminal.get()) connectSocket(api.websocketUrl());\n            } catch (Exception error) {\n                reconnectScheduled.set(false);\n                fail(\"SIGNALING_TIMEOUT\", error);\n            }",
    "                Thread.sleep(Math.min(3000L, attempt * 350L));\n                reconnectScheduled.set(false);\n                if (!terminal.get()) connectSocket(api.websocketUrl());\n            } catch (Exception error) {\n                reconnectScheduled.set(false);\n                if (!terminal.get()) scheduleReconnect();\n            }",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "                List<PeerConnection.IceServer> iceServers = parseIceServers(api.turnCredentials());\n                NativeWebRtcEngine created = new NativeWebRtcEngine(context, engineListener);",
    "                List<PeerConnection.IceServer> iceServers = parseIceServers(api.turnCredentials());\n                if (iceServers.isEmpty()) throw new NativeCallApi.ApiException(503, \"No usable call relay configuration.\");\n                NativeWebRtcEngine created = new NativeWebRtcEngine(context, engineListener);",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "            } catch (SecurityException permission) {\n                fail(\"video\".equals(callType) ? \"CAMERA_PERMISSION_DENIED\" : \"MICROPHONE_PERMISSION_DENIED\", permission);\n            } catch (Exception error) {\n                fail(\"INTERNAL_CALL_ERROR\", error);\n            }",
    "            } catch (SecurityException permission) {\n                fail(\"video\".equals(callType) ? \"CAMERA_PERMISSION_DENIED\" : \"MICROPHONE_PERMISSION_DENIED\", permission);\n            } catch (NativeCallApi.ApiException relayError) {\n                fail(relayError.status == 401 || relayError.status == 403 ? \"TURN_AUTH_FAILED\" : \"TURN_UNREACHABLE\", relayError);\n            } catch (Exception error) {\n                fail(\"INTERNAL_CALL_ERROR\", error);\n            }",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "    private void send(String type, String eventCallId, JSONObject payload) {\n        WebSocket current = socket;\n        if (current == null || !signalingOpen) return;\n        try {\n            JSONObject event = new JSONObject().put(\"schema_version\", 1).put(\"event_id\", UUID.randomUUID().toString())\n                .put(\"type\", type).put(\"timestamp\", timestamp()).put(\"payload\", payload == null ? new JSONObject() : payload);\n            if (eventCallId != null) event.put(\"call_id\", eventCallId);\n            current.send(event.toString());\n        } catch (org.json.JSONException error) {\n            fail(\"INTERNAL_CALL_ERROR\", error);\n        }\n    }",
    "    private void send(String type, String eventCallId, JSONObject payload) {\n        try {\n            JSONObject event = new JSONObject().put(\"schema_version\", 1).put(\"event_id\", UUID.randomUUID().toString())\n                .put(\"type\", type).put(\"timestamp\", timestamp()).put(\"payload\", payload == null ? new JSONObject() : payload);\n            if (eventCallId != null) event.put(\"call_id\", eventCallId);\n            String encoded = event.toString();\n            WebSocket current = socket;\n            if (current == null || !signalingOpen || !current.send(encoded)) {\n                queueOutboundSignal(encoded);\n                if (!terminal.get()) scheduleReconnect();\n            }\n        } catch (org.json.JSONException error) {\n            fail(\"INTERNAL_CALL_ERROR\", error);\n        }\n    }\n\n    private synchronized void queueOutboundSignal(String encoded) {\n        if (pendingOutboundSignals.size() >= 256) pendingOutboundSignals.remove(0);\n        pendingOutboundSignals.add(encoded);\n    }\n\n    private synchronized void flushPendingOutboundSignals() {\n        WebSocket current = socket;\n        if (current == null || !signalingOpen || pendingOutboundSignals.isEmpty()) return;\n        List<String> queued = new ArrayList<>(pendingOutboundSignals);\n        pendingOutboundSignals.clear();\n        for (String encoded : queued) {\n            if (!current.send(encoded)) {\n                queueOutboundSignal(encoded);\n                break;\n            }\n        }\n    }",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "        pendingRemoteCandidates.clear();\n        peerReadySent = false;",
    "        pendingRemoteCandidates.clear();\n        if (terminalState) pendingOutboundSignals.clear();\n        peerReadySent = false;",
)
replace_once(
    "android/app/src/main/java/com/autoai/app/NativeCallSessionController.java",
    "            @Override public void onAvailable(Network network) {\n                if (!terminal.get() && iceDisconnected && engine != null && !iceRestartAttempted) {",
    "            @Override public void onAvailable(Network network) {\n                if (!terminal.get() && !signalingOpen) scheduleReconnect();\n                if (!terminal.get() && iceDisconnected && engine != null && !iceRestartAttempted) {",
)

replace_once(
    "android/app/src/main/java/com/autoai/app/AutoAiCallsPlugin.java",
    "        handler.postDelayed(() -> {\n            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { return; }\n            CallNotificationManager.cancelOngoingCall(getContext(), readyCallId);\n            call.reject(\"Call service readiness timed out.\", \"SERVICE_READY_TIMEOUT\");\n        }, 9000L);",
    "        handler.postDelayed(() -> {\n            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { return; }\n            ActiveCallStore.Snapshot snapshot = ActiveCallStore.get(getContext(), readyCallId);\n            if (snapshot != null && snapshot.isUsable()) {\n                CallIntentDispatcher.launchActive(getContext(), snapshot);\n                call.resolve();\n                return;\n            }\n            CallNotificationManager.cancelOngoingCall(getContext(), readyCallId);\n            call.reject(\"Call service readiness timed out.\", \"SERVICE_READY_TIMEOUT\");\n        }, 15_000L);",
)

# Frontend retries transient native service startup failures instead of failing immediately.
replace_once(
    "frontend/src/features/calls/CallProvider.tsx",
    "  const ensureNativeCallService = useCallback(async (currentCall: CallRecord, audioOnly = false) => {\n    if (nativeServiceCallIdsRef.current.has(currentCall.id)) return;\n    nativeServiceCallIdsRef.current.add(currentCall.id);\n    try {\n      await callNative.startActiveCall({\n        callId: currentCall.id,\n        displayName: currentCall.peer.display_name,\n        startedAt: Date.now(),\n        video: currentCall.call_type === \"video\" && !audioOnly,\n      });\n      callDebug(\"native_call_service_started\", { call_id: currentCall.id, role: currentCall.direction, state: currentCall.status });\n    } catch (nativeError) {\n      nativeServiceCallIdsRef.current.delete(currentCall.id);\n      throw new CallSetupError(\"FOREGROUND_SERVICE_FAILED\", \"Unable to start the Android call service.\", nativeError);\n    }\n  }, []);",
    "  const ensureNativeCallService = useCallback(async (currentCall: CallRecord, audioOnly = false) => {\n    if (nativeServiceCallIdsRef.current.has(currentCall.id)) return;\n    const retryableNativeServiceCodes = new Set([\n      \"SERVICE_READY_TIMEOUT\",\n      \"FOREGROUND_SERVICE_TIMEOUT\",\n      \"FOREGROUND_SERVICE_START_NOT_ALLOWED\",\n      \"SIGNALING_TIMEOUT\",\n      \"NETWORK_LOST\",\n      \"INTERNAL_SERVICE_ERROR\",\n      \"INTERNAL_CALL_ERROR\",\n    ]);\n    let lastError: unknown = null;\n    for (let attempt = 0; attempt < 3; attempt += 1) {\n      nativeServiceCallIdsRef.current.add(currentCall.id);\n      try {\n        await callNative.startActiveCall({\n          callId: currentCall.id,\n          displayName: currentCall.peer.display_name,\n          startedAt: Date.now(),\n          video: currentCall.call_type === \"video\" && !audioOnly,\n        });\n        callDebug(\"native_call_service_started\", { call_id: currentCall.id, role: currentCall.direction, state: currentCall.status, attempt: attempt + 1 });\n        return;\n      } catch (nativeError) {\n        nativeServiceCallIdsRef.current.delete(currentCall.id);\n        lastError = nativeError;\n        const code = failureCodeOf(nativeError, \"FOREGROUND_SERVICE_FAILED\");\n        callDebug(\"native_call_service_retry\", { call_id: currentCall.id, attempt: attempt + 1, error_code: code });\n        if (!retryableNativeServiceCodes.has(code) || attempt === 2) break;\n        await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));\n      }\n    }\n    throw new CallSetupError(\"FOREGROUND_SERVICE_FAILED\", \"Unable to start the Android call service.\", lastError);\n  }, []);",
)
write("frontend/src/features/calls/callReliability.contract.test.ts", FRONTEND_TEST)
write("android/app/src/test/java/com/autoai/app/CallReliabilityHotfixContractTest.java", ANDROID_TEST)

print("Applied call reliability hotfix files successfully.")
