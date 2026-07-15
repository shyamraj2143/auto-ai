import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import admin, ai, auth, calls, chat_sessions, chats, cms, device_monitoring, documents, download, health, human, live, live_websocket, memory, notifications, payments, search, social, user_messages, users, voice
from app.core.config import settings
from app.core.rate_limit import InMemoryRateLimitMiddleware
from app.db.session import SessionLocal, init_db
from app.services.admin_seed import create_admin_from_env
from app.services.apk_service import apk_service
from app.services.call_service import call_timeout_worker
from app.services.cms_service import ensure_cms_defaults
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.websockets import call_signaling, user_chat


logger = logging.getLogger("auto_ai.startup")


class NormalizeRequestPathMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") in {"http", "websocket"}:
            path = scope.get("path", "")
            if "//" in path:
                normalized = path
                while "//" in normalized:
                    normalized = normalized.replace("//", "/")

                scope = dict(scope)
                scope["path"] = normalized
                scope["raw_path"] = normalized.encode("utf-8")

        await self.app(scope, receive, send)


def get_cors_origins() -> list[str]:
    default_origins = {
        "https://autoai.site.je",
        "https://www.autoai.site.je",
        "http://autoai.site.je",
        "https://localhost",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    }
    configured_origins = {str(origin).rstrip("/") for origin in settings.BACKEND_CORS_ORIGINS}
    return sorted(default_origins | configured_origins)


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        version="1.0.0",
        description="Production-ready AI assistant backend powered by Groq.",
    )

    app.add_middleware(NormalizeRequestPathMiddleware)

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_cors_origins(),
        allow_origin_regex=r"^((https?://(localhost|127\.0\.0\.1)(:\d+)?)|((capacitor|ionic)://localhost(:\d+)?))$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["x-request-id", "x-railway-request-id"],
    )

    app.add_middleware(InMemoryRateLimitMiddleware)

    @app.exception_handler(RealtimeUnavailable)
    async def realtime_unavailable_handler(request: Request, exc: RealtimeUnavailable) -> JSONResponse:
        del request
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    @app.on_event("startup")
    def on_startup() -> None:
        logger.info(
            "payment_urls FRONTEND_URL=%s BACKEND_URL=%s RAZORPAY_FAILURE_URL=%s",
            settings.frontend_url,
            settings.backend_url,
            settings.razorpay_failure_url,
        )
        if settings.CALL_FEATURE_ENABLED:
            if not settings.redis_url:
                logger.warning("calling_configuration Redis is not configured; Calls remains isolated from unrelated app features.")
            if settings.is_production and not settings.turn_configured:
                logger.warning("calling_configuration TURN is not configured; production calls are not relay-ready.")
            if settings.is_production and not settings.FIREBASE_PROJECT_ID:
                logger.warning("calling_configuration Firebase is not configured; killed Android apps cannot receive calls.")
        Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        Path(settings.UPLOAD_DIR, "profile").mkdir(parents=True, exist_ok=True)
        Path(settings.APK_STORAGE_DIR).mkdir(parents=True, exist_ok=True)
        init_db()
        with SessionLocal() as db:
            create_admin_from_env(db)
            apk_service.sync_filesystem_release(db)
            ensure_cms_defaults(db)

    @app.on_event("startup")
    async def start_call_workers() -> None:
        logger.info("calling_redis configured=%s", presence_service.configured)
        redis_reachable = await presence_service.check(log_failure=True) if presence_service.configured else False
        if redis_reachable:
            logger.info("calling_redis reachable=true websocket_ready=%s", settings.CALL_FEATURE_ENABLED)
        else:
            logger.warning(
                "calling_redis reachable=false websocket_ready=false calls_rest_available=true"
            )
        stop_event = asyncio.Event()
        app.state.call_stop_event = stop_event
        app.state.call_timeout_task = asyncio.create_task(call_timeout_worker(stop_event))

    @app.on_event("shutdown")
    async def stop_call_workers() -> None:
        stop_event = getattr(app.state, "call_stop_event", None)
        task = getattr(app.state, "call_timeout_task", None)
        if stop_event:
            stop_event.set()
        if task:
            await asyncio.gather(task, return_exceptions=True)
        await presence_service.close()


    app.include_router(health.router)
    app.include_router(health.router, prefix=settings.API_V1_STR)
    app.include_router(auth.router, prefix=settings.API_V1_STR)
    app.include_router(users.router, prefix=settings.API_V1_STR)
    app.include_router(chat_sessions.router, prefix=settings.API_V1_STR)
    app.include_router(chats.router, prefix=settings.API_V1_STR)
    app.include_router(ai.router, prefix=settings.API_V1_STR)
    app.include_router(documents.router, prefix=settings.API_V1_STR)
    app.include_router(voice.router, prefix=settings.API_V1_STR)
    app.include_router(live.router, prefix=settings.API_V1_STR)
    app.include_router(live_websocket.router, prefix=settings.API_V1_STR)
    app.include_router(memory.router, prefix=settings.API_V1_STR)
    app.include_router(human.router, prefix=settings.API_V1_STR)
    app.include_router(search.router, prefix=settings.API_V1_STR)
    app.include_router(notifications.router, prefix=settings.API_V1_STR)
    app.include_router(calls.router, prefix=settings.API_V1_STR)
    app.include_router(social.router, prefix=settings.API_V1_STR)
    app.include_router(call_signaling.router, prefix=settings.API_V1_STR)
    app.include_router(user_messages.router, prefix=settings.API_V1_STR)
    app.include_router(user_chat.router, prefix=settings.API_V1_STR)
    app.include_router(download.router, prefix="/api")
    app.include_router(download.router, prefix=settings.API_V1_STR)
    app.include_router(device_monitoring.router, prefix=settings.API_V1_STR)
    app.include_router(payments.router, prefix="/api")
    app.include_router(payments.router, prefix=settings.API_V1_STR)
    app.include_router(admin.router, prefix=settings.API_V1_STR)
    app.include_router(cms.router, prefix=settings.API_V1_STR)
    app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

    return app


app = create_app()
