from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.admin_control import FeatureFlag, PlanLimit, UsageLog, UserSubscription
from app.models.api_usage import APIUsage
from app.models.user import User


PLAN_NAMES = {"free", "pro", "pro-plus", "admin"}

DEFAULT_PLAN_LIMITS: dict[str, dict[str, int | bool]] = {
    "free": {
        "daily_prompt_limit": 100,
        "monthly_prompt_limit": 1000,
        "daily_token_limit": 50000,
        "monthly_token_limit": 500000,
        "max_models": 1,
        "allow_deep_research": False,
        "allow_multi_model": False,
        "allow_web_search": True,
    },
    "pro": {
        "daily_prompt_limit": 500,
        "monthly_prompt_limit": 10000,
        "daily_token_limit": 250000,
        "monthly_token_limit": 5000000,
        "max_models": 3,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
    "pro-plus": {
        "daily_prompt_limit": 2000,
        "monthly_prompt_limit": 50000,
        "daily_token_limit": 1000000,
        "monthly_token_limit": 25000000,
        "max_models": 6,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
    "admin": {
        "daily_prompt_limit": 0,
        "monthly_prompt_limit": 0,
        "daily_token_limit": 0,
        "monthly_token_limit": 0,
        "max_models": 12,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
}

FEATURE_DEFINITIONS: dict[str, str] = {
    "deep_research": "Allow premium deep research responses.",
    "multi_model_routing": "Allow multiple models in one response.",
    "web_search": "Allow web search in chat.",
    "chat_backup": "Allow chat backup features.",
    "apk_auto_update": "Allow APK auto-update features.",
    "firebase_notifications": "Allow Firebase notification features.",
    "streaming": "Allow streaming chat responses.",
    "cache": "Allow response/search caching.",
}


def normalize_plan(plan: str) -> str:
    value = plan.strip().lower()
    if value not in PLAN_NAMES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid subscription plan")
    return value


def infer_provider_from_model(model: str) -> str:
    value = (model or "").lower()
    if "gemini" in value:
        return "Gemini"
    if value.startswith(("amazon.", "anthropic.")) or "/bedrock" in value:
        return "Bedrock"
    if value.startswith("gpt-") or value.startswith("o3") or value.startswith("o4"):
        return "OpenAI"
    return "Groq"


def ensure_admin_defaults(db: Session) -> None:
    changed = False
    for plan, defaults in DEFAULT_PLAN_LIMITS.items():
        existing = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan))
        if existing:
            continue
        db.add(PlanLimit(plan=plan, **defaults))
        changed = True

    for key, description in FEATURE_DEFINITIONS.items():
        existing = db.scalar(
            select(FeatureFlag).where(
                FeatureFlag.key == key,
                FeatureFlag.scope == "global",
                FeatureFlag.user_id.is_(None),
            )
        )
        if existing:
            continue
        db.add(FeatureFlag(key=key, scope="global", enabled=True, description=description))
        changed = True

    if changed:
        db.commit()


def ensure_user_subscription(db: Session, user: User) -> UserSubscription:
    subscription = db.scalar(select(UserSubscription).where(UserSubscription.user_id == user.id))
    if subscription:
        return subscription
    plan = "admin" if user.role in {"admin", "super_admin"} else "free"
    subscription = UserSubscription(
        user_id=user.id,
        plan=plan,
        is_active=True,
        payment_status="admin" if plan == "admin" else "free",
    )
    db.add(subscription)
    db.flush()
    return subscription


def is_feature_enabled(db: Session, key: str, user_id: str | None = None) -> bool:
    if user_id:
        user_flag = db.scalar(
            select(FeatureFlag).where(
                FeatureFlag.key == key,
                FeatureFlag.scope == "user",
                FeatureFlag.user_id == user_id,
            )
        )
        if user_flag:
            return bool(user_flag.enabled)
    global_flag = db.scalar(
        select(FeatureFlag).where(
            FeatureFlag.key == key,
            FeatureFlag.scope == "global",
            FeatureFlag.user_id.is_(None),
        )
    )
    return True if global_flag is None else bool(global_flag.enabled)


def enforce_plan_and_feature_access(
    db: Session,
    user: User,
    *,
    mode: str,
    web_search: bool | None,
    search_mode: str | None,
    max_models: int | None = None,
) -> None:
    if user.role in {"admin", "super_admin"}:
        return

    subscription = ensure_user_subscription(db, user)
    active_subscription = subscription.is_active and (
        subscription.expires_at is None or subscription.expires_at >= datetime.utcnow()
    )
    plan_name = subscription.plan if active_subscription else "free"
    limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan_name))
    if not limits:
        limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == "free"))

    if mode == "deep_research":
        if not active_subscription or not limits or not limits.allow_deep_research:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deep Research is not enabled for this plan.")
        if not is_feature_enabled(db, "deep_research", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deep Research is disabled for this account.")

    if mode == "multi_model":
        if not active_subscription or not limits or not limits.allow_multi_model:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Multi-Model routing is not enabled for this plan.")
        if not is_feature_enabled(db, "multi_model_routing", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Multi-Model routing is disabled for this account.")

    if max_models and limits and limits.max_models > 0 and max_models > limits.max_models:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"This plan allows up to {limits.max_models} models per request.",
        )

    search_requested = bool(web_search) or (search_mode not in {None, "off", "auto"})
    if search_requested:
        if not limits or not limits.allow_web_search:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Web search is not enabled for this plan.")
        if not is_feature_enabled(db, "web_search", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Web search is disabled for this account.")

    now = datetime.utcnow()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    daily_usage = db.execute(
        select(func.count(APIUsage.id), func.coalesce(func.sum(APIUsage.total_tokens), 0)).where(
            APIUsage.user_id == user.id,
            APIUsage.created_at >= day_start,
        )
    ).one()
    monthly_usage = db.execute(
        select(func.count(APIUsage.id), func.coalesce(func.sum(APIUsage.total_tokens), 0)).where(
            APIUsage.user_id == user.id,
            APIUsage.created_at >= month_start,
        )
    ).one()

    if limits:
        if limits.daily_prompt_limit > 0 and int(daily_usage[0] or 0) >= limits.daily_prompt_limit:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Daily prompt limit reached.")
        if limits.monthly_prompt_limit > 0 and int(monthly_usage[0] or 0) >= limits.monthly_prompt_limit:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Monthly prompt limit reached.")
        if limits.daily_token_limit > 0 and int(daily_usage[1] or 0) >= limits.daily_token_limit:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Daily token limit reached.")
        if limits.monthly_token_limit > 0 and int(monthly_usage[1] or 0) >= limits.monthly_token_limit:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Monthly token limit reached.")


def record_usage_log(db: Session, user_id: str, endpoint: str, model: str, usage: dict[str, int]) -> None:
    db.add(
        UsageLog(
            user_id=user_id,
            endpoint=endpoint,
            model=model,
            provider=infer_provider_from_model(model),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
            request_count=1,
        )
    )


def expiry_status(expires_at: datetime | None) -> str:
    if not expires_at:
        return "no_expiry"
    if expires_at < datetime.utcnow():
        return "expired"
    if expires_at < datetime.utcnow() + timedelta(days=7):
        return "expiring_soon"
    return "active"
