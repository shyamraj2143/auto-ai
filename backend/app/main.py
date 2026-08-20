import asyncio
import logging
from pathlib import Path
from urllib.parse import urlparse
import re
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.routes import admin, ai, alarms, assistant_actions, auth, calls, chat_sessions, chats, cms, demo_chat, device_monitoring, documents, download, form_services, health, human, intent_engine, library, live, live_websocket, memory, notifications, payments, relationship_followups, screen_share, search, service_applications, social, trust_hub, user_data, user_messages, users, voice
from app.core.config import settings
from app.core.rate_limit import InMemoryRateLimitMiddleware
from app.db.session import SessionLocal, init_db
from app.services.admin_seed import create_admin_from_env
from app.services.apk_service import apk_service
from app.services.call_service import call_timeout_worker
from app.services.cms_service import ensure_cms_defaults
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.relationship_followup_scheduler import relationship_followup_worker
from app.services.form_service_registry import ensure_service_registry
from app.services.form_service_service import cleanup_expired_form_service_data
from app.services.autoai_seva_seed import ensure_autoai_seva_demo
from app.services import autoai_seva_review as _autoai_seva_review  # noqa: F401
from app.services.orchestration.model_registry import model_registry
from app.websockets import call_signaling, screen_share as screen_share_signaling, user_chat

logger = logging.getLogger("auto_ai.startup")


class NormalizeRequestPathMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope.get("type") in {"http", "websocket"}:
            path = scope.get("path", "")
            if "//" in path:
                normalized = path
                while "//" in normalized: normalized = normalized.replace("//", "/")
                scope = dict(scope); scope["path"] = normalized; scope["raw_path"] = normalized.encode("utf-8")
        await self.app(scope, receive, send)


class RequestIdMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http": return await self.app(scope, receive, send)
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        candidate = headers.get(b"x-request-id", b"").decode("ascii", errors="ignore")
        request_id = candidate if re.fullmatch(r"[A-Za-z0-9._-]{8,80}", candidate) else str(uuid.uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        async def send_with_request_id(message):
            if message.get("type") == "http.response.start":
                response_headers = list(message.get("headers", [])); response_headers.append((b"x-request-id", request_id.encode("ascii")))
                message = {**message, "headers": response_headers}
            await send(message)
        await self.app(scope, receive, send_with_request_id)


class SecurityHeadersMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http": return await self.app(scope, receive, send)
        async def send_with_security_headers(message):
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", [])); names = {name.lower() for name, _ in headers}
                additions = {b"x-content-type-options": b"nosniff", b"referrer-policy": b"strict-origin-when-cross-origin", b"x-frame-options": b"DENY", b"permissions-policy": b"camera=(), geolocation=(), microphone=()", b"content-security-policy": b"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"}
                forwarded_proto = dict(scope.get("headers", [])).get(b"x-forwarded-proto", b"").lower()
                if scope.get("scheme") == "https" or forwarded_proto == b"https": additions[b"strict-transport-security"] = b"max-age=31536000; includeSubDomains"
                headers.extend((name, value) for name, value in additions.items() if name not in names); message = {**message, "headers": headers}
            await send(message)
        await self.app(scope, receive, send_with_security_headers)


class RequestBodyLimitMiddleware:
    def __init__(self, app): self.app = app; self.max_bytes = settings.MAX_REQUEST_BODY_MB * 1024 * 1024
    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("method", "GET").upper() in {"POST", "PUT", "PATCH"}:
            headers = dict(scope.get("headers", []))
            try: content_length = int(headers.get(b"content-length", b"0"))
            except ValueError: content_length = 0
            if content_length > self.max_bytes:
                response = JSONResponse(status_code=413, content={"detail": "Request body is too large."}); await response(scope, receive, send); return
        await self.app(scope, receive, send)


class RelationshipPayloadLimitMiddleware:
    MAX_BYTES = 32 * 1024
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        path = str(scope.get("path", "")); method = str(scope.get("method", "GET")).upper()
        if scope.get("type") != "http" or "/relationship-followups" not in path or method not in {"POST", "PUT", "PATCH"}: return await self.app(scope, receive, send)
        messages = []; total = 0
        while True:
            message = await receive(); messages.append(message); total += len(message.get("body", b""))
            if total > self.MAX_BYTES:
                request_id = scope.get("state", {}).get("request_id", str(uuid.uuid4())); response = JSONResponse(status_code=413, content={"detail": "Relationship follow-up request is too large.", "request_id": request_id}); await response(scope, receive, send); return
            if not message.get("more_body", False): break
        async def replay_body():
            if messages: return messages.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}
        await self.app(scope, replay_body, send)


def get_cors_origins() -> list[str]:
    default_origins = {"https://autoai.site.je", "https://www.autoai.site.je", "https://localhost", "http://localhost:5173", "http://127.0.0.1:5173"}
    configured_origins = {str(origin).rstrip("/") for origin in settings.BACKEND_CORS_ORIGINS}
    return sorted(default_origins | configured_origins)


def get_trusted_hosts() -> list[str]:
    hosts = {"localhost", "127.0.0.1", "testserver", "healthcheck.railway.app", "auto-ai-app-download.up.railway.app", "*.up.railway.app"}
    hosts.update(host.strip().lower() for host in settings.TRUSTED_HOSTS if host.strip() and host.strip() != "*")
    for configured_url in (settings.frontend_url, settings.backend_url):
        hostname = urlparse(configured_url).hostname
        if hostname: hosts.add(hostname.lower())
    railway_public_domain = str(settings.RAILWAY_PUBLIC_DOMAIN or "").strip().lower()
    if railway_public_domain:
        parsed = urlparse(railway_public_domain if "://" in railway_public_domain else f"https://{railway_public_domain}")
        if parsed.hostname: hosts.add(parsed.hostname.lower())
    return sorted(hosts)


def _bootstrap_database() -> None:
    try:
        init_db()
        with SessionLocal() as db:
            ensure_service_registry(db)
            ensure_autoai_seva_demo(db)
            cleanup_expired_form_service_data(db)
            create_admin_from_env(db)
            apk_service.sync_filesystem_release(db)
            ensure_cms_defaults(db)
        logger.info("database_bootstrap completed successfully")
    except Exception:
        logger.exception("database_bootstrap failed; HTTP service remains available")


def create_app():
    app = FastAPI(title=settings.PROJECT_NAME, version="1.0.0", description="Production-ready AI assistant backend powered by Groq.")
    app.add_middleware(NormalizeRequestPathMiddleware); app.add_middleware(RequestBodyLimitMiddleware); app.add_middleware(RelationshipPayloadLimitMiddleware); app.add_middleware(RequestIdMiddleware); app.add_middleware(InMemoryRateLimitMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=get_cors_origins(), allow_origin_regex=r"^((https?://(localhost|127\.0\.0\.1)(:\d+)?)|((capacitor|ionic)://localhost(:\d+)?))$", allow_credentials=True, allow_methods=["*"], allow_headers=["*"], expose_headers=["x-request-id", "x-railway-request-id", "content-disposition"])
    if settings.is_production: app.add_middleware(TrustedHostMiddleware, allowed_hosts=get_trusted_hosts())
    app.add_middleware(SecurityHeadersMiddleware)
    @app.exception_handler(RealtimeUnavailable)
    async def realtime_unavailable_handler(request: Request, exc: RealtimeUnavailable):
        del request; return JSONResponse(status_code=503, content={"detail": str(exc)})
    @app.on_event("startup")
    async def on_startup():
        logger.info("payment_urls FRONTEND_URL=%s BACKEND_URL=%s RAZORPAY_FAILURE_URL=%s", settings.frontend_url, settings.backend_url, settings.razorpay_failure_url)
        for directory in (settings.UPLOAD_DIR, Path(settings.UPLOAD_DIR, "profile"), settings.LIBRARY_STORAGE_DIR, settings.APK_STORAGE_DIR, settings.FORM_SERVICE_STORAGE_DIR):
            Path(directory).mkdir(parents=True, exist_ok=True)
        # Do not perform database connections or schema migrations in the
        # Uvicorn lifespan critical path. Railway must receive /health as soon
        # as the HTTP server binds to its assigned PORT.
        app.state.database_bootstrap_task = asyncio.create_task(asyncio.to_thread(_bootstrap_database))
        if settings.CALL_FEATURE_ENABLED:
            if not settings.redis_url: logger.warning("calling_configuration Redis is not configured; Calls remains isolated from unrelated app features.")
            if settings.is_production and not settings.turn_configured: logger.warning("calling_configuration TURN is not configured; production calls are not relay-ready.")
            if settings.is_production and not settings.FIREBASE_PROJECT_ID: logger.warning("calling_configuration Firebase is not configured; killed Android apps cannot receive calls.")
    @app.on_event("startup")
    async def start_call_workers():
        logger.info("calling_redis configured=%s", presence_service.configured); redis_reachable = await presence_service.check(log_failure=True) if presence_service.configured else False
        if redis_reachable: logger.info("calling_realtime redis_reachable=true call_websocket_ready=%s live_websocket_ready=true calls_rest_available=true", settings.CALL_FEATURE_ENABLED)
        else: logger.warning("calling_realtime redis_reachable=false call_websocket_ready=false live_websocket_ready=true calls_rest_available=true")
        stop_event = asyncio.Event(); app.state.call_stop_event = stop_event; app.state.call_timeout_task = asyncio.create_task(call_timeout_worker(stop_event)); registry_stop_event = asyncio.Event(); app.state.registry_stop_event = registry_stop_event
        async def registry_worker():
            while not registry_stop_event.is_set():
                await asyncio.to_thread(model_registry.refresh, force=True)
                try: await asyncio.wait_for(registry_stop_event.wait(), timeout=max(30, settings.ORCHESTRATION_HEALTH_TTL_SECONDS))
                except TimeoutError: continue
        app.state.registry_task = asyncio.create_task(registry_worker())
        if settings.RELATIONSHIP_FOLLOWUP_WORKER_ENABLED:
            relationship_stop_event = asyncio.Event(); app.state.relationship_stop_event = relationship_stop_event; app.state.relationship_worker_task = asyncio.create_task(relationship_followup_worker(relationship_stop_event))
    @app.on_event("shutdown")
    async def stop_call_workers():
        bootstrap_task = getattr(app.state, "database_bootstrap_task", None)
        if bootstrap_task: bootstrap_task.cancel()
        for attr in ("call_stop_event", "registry_stop_event", "relationship_stop_event"):
            event = getattr(app.state, attr, None)
            if event: event.set()
        for attr in ("call_timeout_task", "registry_task", "relationship_worker_task", "database_bootstrap_task"):
            task = getattr(app.state, attr, None)
            if task: await asyncio.gather(task, return_exceptions=True)
        await presence_service.close()
    app.include_router(health.router); app.include_router(health.router, prefix=settings.API_V1_STR)
    for router in (auth, users, chat_sessions, chats, ai, alarms, assistant_actions, intent_engine, form_services, service_applications, trust_hub, demo_chat, documents, library, voice, live, live_websocket, memory, human, search, notifications, relationship_followups, calls, screen_share, social, call_signaling, screen_share_signaling, user_messages, user_data, user_chat, device_monitoring, admin, cms): app.include_router(router.router, prefix=settings.API_V1_STR)
    app.include_router(download.router, prefix="/api"); app.include_router(download.router, prefix=settings.API_V1_STR); app.include_router(payments.router, prefix="/api"); app.include_router(payments.router, prefix=settings.API_V1_STR); app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR, check_dir=False), name="uploads")
    return app

app = create_app()
