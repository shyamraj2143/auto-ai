import logging
import os

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.user import User
from app.services.admin_control import (
    ensure_user_subscription,
    plan_daily_message_limit,
    plan_monthly_token_limit,
    quota_plan_defaults,
    recalculate_token_balance,
)

logger = logging.getLogger("auto_ai.admin_seed")


def _clean(value: str | None) -> str | None:
    stripped = value.strip() if value else ""
    return stripped or None


def create_admin_from_env(db: Session) -> User | None:
    """Optionally bootstrap an admin without ever preventing API startup.

    Railway environments can contain only part of the ADMIN_* configuration.
    Admin bootstrap is optional, so incomplete credentials must be skipped rather
    than crashing FastAPI's startup lifecycle and making the healthcheck fail.
    """
    email = _clean(os.getenv("ADMIN_EMAIL"))
    password = _clean(os.getenv("ADMIN_PASSWORD"))
    name = _clean(os.getenv("ADMIN_NAME"))

    values = {
        "ADMIN_EMAIL": email,
        "ADMIN_PASSWORD": password,
        "ADMIN_NAME": name,
    }
    configured = [key for key, value in values.items() if value]
    if not configured:
        return None

    missing = [key for key, value in values.items() if not value]
    if missing:
        logger.warning(
            "Skipping optional admin bootstrap because these variables are missing: %s",
            ", ".join(missing),
        )
        return None

    assert email is not None
    assert password is not None
    assert name is not None

    normalized_email = email.lower()
    existing = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if existing:
        if existing.role in {"admin", "super_admin"}:
            return existing
        logger.error(
            "Skipping admin bootstrap: ADMIN_EMAIL belongs to a non-admin user."
        )
        return None

    user = User(
        email=normalized_email,
        name=name,
        hashed_password=get_password_hash(password),
        is_active=True,
        is_admin=True,
        role="admin",
    )

    try:
        db.add(user)
        db.flush()
        subscription = ensure_user_subscription(db, user)
        defaults = quota_plan_defaults("admin")
        subscription.plan = "admin"
        subscription.plan_name = str(defaults["plan_name"])
        subscription.token_limit_monthly = plan_monthly_token_limit(db, "admin")
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.daily_message_limit = plan_daily_message_limit(db, "admin")
        subscription.tokens_used_monthly = 0
        subscription.bonus_tokens = 0
        subscription.messages_used_today = 0
        subscription.is_active = True
        subscription.payment_status = "admin"
        recalculate_token_balance(subscription)
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
        if existing and existing.role in {"admin", "super_admin"}:
            return existing
        logger.exception("Admin bootstrap encountered a database integrity error; continuing startup.")
        return None
    except Exception:
        db.rollback()
        logger.exception("Admin bootstrap failed; continuing API startup without admin bootstrap.")
        return None

    db.refresh(user)
    return user
