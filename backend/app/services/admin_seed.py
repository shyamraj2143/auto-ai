from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_password_hash
from app.models.user import User
from app.services.admin_control import ensure_user_subscription, quota_plan_defaults, recalculate_token_balance


def _clean(value: str | None) -> str | None:
    stripped = value.strip() if value else ""
    return stripped or None


def create_admin_from_env(db: Session) -> User | None:
    email = _clean(str(settings.ADMIN_EMAIL) if settings.ADMIN_EMAIL else None)
    password = settings.ADMIN_PASSWORD.get_secret_value() if settings.ADMIN_PASSWORD else None
    name = _clean(settings.ADMIN_NAME)
    values = {
        "ADMIN_EMAIL": email,
        "ADMIN_PASSWORD": password,
        "ADMIN_NAME": name,
    }
    if not any(values.values()):
        return None

    missing = [key for key, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"Missing required admin bootstrap environment variables: {', '.join(missing)}")

    assert email is not None
    assert password is not None
    assert name is not None

    normalized_email = email.lower()
    existing = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if existing:
        if existing.role in {"admin", "super_admin"}:
            return existing
        raise RuntimeError("ADMIN_EMAIL belongs to a non-admin user; refusing to promote or overwrite it.")

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
        subscription.token_limit_monthly = int(defaults["token_limit_monthly"])
        subscription.daily_message_limit = int(defaults["daily_message_limit"])
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
        raise

    db.refresh(user)
    return user
