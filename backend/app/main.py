import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import admin, ai, auth, chat_sessions, chats, documents, download, health, human, live, memory, payments, search, voice
from app.core.config import settings
from app.core.rate_limit import InMemoryRateLimitMiddleware
from app.db.session import SessionLocal, init_db
from app.services.admin_seed import create_admin_from_env
from app.services.apk_service import apk_service


logger = logging.getLogger("auto_ai.startup")


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

    @app.on_event("startup")
    def on_startup() -> None:
        logger.info(
            "payment_urls FRONTEND_URL=%s BACKEND_URL=%s RAZORPAY_FAILURE_URL=%s",
            settings.frontend_url,
            settings.backend_url,
            settings.razorpay_failure_url,
        )
        Path(settings.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        Path(settings.APK_STORAGE_DIR).mkdir(parents=True, exist_ok=True)
        init_db()
        with SessionLocal() as db:
            create_admin_from_env(db)
            apk_service.sync_filesystem_release(db)


    app.include_router(health.router)
    app.include_router(health.router, prefix=settings.API_V1_STR)
    app.include_router(auth.router, prefix=settings.API_V1_STR)
    app.include_router(chat_sessions.router, prefix=settings.API_V1_STR)
    app.include_router(chats.router, prefix=settings.API_V1_STR)
    app.include_router(ai.router, prefix=settings.API_V1_STR)
    app.include_router(documents.router, prefix=settings.API_V1_STR)
    app.include_router(voice.router, prefix=settings.API_V1_STR)
    app.include_router(live.router, prefix=settings.API_V1_STR)
    app.include_router(memory.router, prefix=settings.API_V1_STR)
    app.include_router(human.router, prefix=settings.API_V1_STR)
    app.include_router(search.router, prefix=settings.API_V1_STR)
    app.include_router(download.router, prefix="/api")
    app.include_router(download.router, prefix=settings.API_V1_STR)
    app.include_router(payments.router, prefix="/api")
    app.include_router(payments.router, prefix=settings.API_V1_STR)
    app.include_router(admin.router, prefix=settings.API_V1_STR)

    return app


app = create_app()
