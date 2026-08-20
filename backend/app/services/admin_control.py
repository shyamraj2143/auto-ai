from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.admin_control import AuditLog, FeatureFlag, PlanLimit, UsageLog, UserSubscription
from app.models.user import User


PLAN_NAMES = {"free", "pro", "premium", "ultra", "pro-plus", "admin"}
TOKEN_LIMIT_EXCEEDED_MESSAGE = "Your token limit is over. Please upgrade or contact admin."
BILLABLE_TOKENS_PER_INPUT = 1
PLAN_PRICES_PAISE = {
    "free": 0,
    "pro": 2000,
    "premium": 5000,
    "ultra": 10000,
}
PLAN_CATALOG: dict[str, dict[str, int | str | list[str]]] = {
    "free": {
        "label": "Free",
        "price_paise": 0,
        "token_quota": 10000,
        "daily_message_limit": 25,
        "upload_limit_mb": 20,
        "model_access": ["Groq basic", "OpenAI basic"],
        "priority_speed": "Standard",
        "features": ["Chat", "Voice input", "Document upload"],
    },
    "pro": {
        "label": "Pro",
        "price_paise": 2000,
        "token_quota": 100000,
        "daily_message_limit": 200,
        "upload_limit_mb": 50,
        "model_access": ["Groq", "OpenAI", "Web search"],
        "priority_speed": "Faster",
        "features": ["Higher monthly quota", "Web search", "Priority queue"],
    },
    "premium": {
        "label": "Premium",
        "price_paise": 5000,
        "token_quota": 300000,
        "daily_message_limit": 600,
        "upload_limit_mb": 100,
        "priority_speed": "High",
        "features": ["Deep research", "Multi-model routing", "Larger uploads"],
    },
    "ultra": {
        "label": "Ultra",
        "price_paise": 10000,
        "token_quota": 1000000,
        "daily_message_limit": 1500,
        "upload_limit_mb": 250,
        "model_access": ["All configured models", "Deep Research", "Multi-model routing"],
        "priority_speed": "Highest",
        "features": ["Largest quota", "Highest priority", "Maximum upload limit"],
    },
}

QUOTA_DEFAULTS: dict[str, dict[str, int | str]] = {
    "free": {
        "plan_name": "Free",
        "token_limit_monthly": 10000,
        "daily_message_limit": 25,
    },
    "pro": {
        "plan_name": "Pro",
        "token_limit_monthly": 100000,
        "daily_message_limit": 200,
    },
    "premium": {
        "plan_name": "Premium",
        "token_limit_monthly": 300000,
        "daily_message_limit": 600,
    },
    "ultra": {
        "plan_name": "Ultra",
        "token_limit_monthly": 1000000,
        "daily_message_limit": 1500,
    },
    "pro-plus": {
        "plan_name": "Pro Plus",
        "token_limit_monthly": 500000,
        "daily_message_limit": 1000,
    },
    "admin": {
        "plan_name": "Admin",
        "token_limit_monthly": 0,
        "daily_message_limit": 0,
    },
}

DEFAULT_PLAN_LIMITS: dict[str, dict[str, int | bool]] = {
    "free": {
        "price_paise": 0,
        "daily_prompt_limit": 100,
        "monthly_prompt_limit": 1000,
        "daily_token_limit": 10000,
        "monthly_token_limit": 10000,
        "max_models": 1,
        "allow_deep_research": False,
        "allow_multi_model": False,
        "allow_web_search": True,
    },
    "pro": {
        "price_paise": 2000,
        "daily_prompt_limit": 500,
        "monthly_prompt_limit": 10000,
        "daily_token_limit": 100000,
        "monthly_token_limit": 100000,
        "max_models": 3,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
    "premium": {
        "price_paise": 5000,
        "daily_prompt_limit": 1000,
        "monthly_prompt_limit": 30000,
        "daily_token_limit": 300000,
        "monthly_token_limit": 300000,
        "max_models": 5,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
    "ultra": {
        "price_paise": 10000,
        "daily_prompt_limit": 3000,
        "monthly_prompt_limit": 100000,
        "daily_token_limit": 1000000,
        "monthly_token_limit": 1000000,
        "max_models": 0,
        "allow_deep_research": True,
        "allow_multi_model": True,
        "allow_web_search": True,
    },
    "pro-plus": {
        "price_paise": 0,
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
        "price_paise": 0,
        "daily_prompt_limit": 0,
        "monthly_prompt_limit": 0,
        "daily_token_limit": 0,
        "monthly_token_limit": 0,
        "max_models": 0,
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


def quota_plan_defaults(plan: str) -> dict[str, int | str]:
    return QUOTA_DEFAULTS.get(plan.strip().lower(), QUOTA_DEFAULTS["free"])


def billing_plan(plan: str) -> dict[str, int | str | list[str]]:
    return PLAN_CATALOG.get(plan.strip().lower(), PLAN_CATALOG["free"])


def plan_limit_for(db: Session, plan: str) -> PlanLimit | None:
    normalized = plan.strip().lower()
    return db.scalar(select(PlanLimit).where(PlanLimit.plan == normalized))


def plan_price_paise(db: Session, plan: str) -> int:
    normalized = plan.strip().lower()
    limit = plan_limit_for(db, normalized)
    if limit:
        return int(limit.price_paise)
    return int(PLAN_CATALOG.get(normalized, PLAN_CATALOG["free"])["price_paise"])


def plan_monthly_token_limit(db: Session, plan: str) -> int:
    normalized = plan.strip().lower()
    limit = plan_limit_for(db, normalized)
    if limit:
        return int(limit.monthly_token_limit)
    return int(quota_plan_defaults(normalized)["token_limit_monthly"])


def plan_daily_message_limit(db: Session, plan: str) -> int:
    normalized = plan.strip().lower()
    limit = plan_limit_for(db, normalized)
    if limit:
        return int(limit.daily_prompt_limit)
    return int(quota_plan_defaults(normalized)["daily_message_limit"])


def plan_upload_limit_mb(plan: str) -> int:
    return int(billing_plan(plan)["upload_limit_mb"])


def paid_plan_amount(plan: str, promo_discount_percent: int = 0, db: Session | None = None) -> int:
    amount = plan_price_paise(db, plan) if db else PLAN_PRICES_PAISE.get(plan.strip().lower(), 0)
    if promo_discount_percent <= 0:
        return amount
    discount = min(100, max(0, promo_discount_percent))
    return max(100, round(amount * (100 - discount) / 100))


def promo_codes() -> dict[str, int]:
    from app.core.config import settings

    result: dict[str, int] = {}
    for item in settings.PROMO_CODES.split(","):
        if ":" not in item:
            continue
        code, percent = item.split(":", 1)
        try:
            discount = int(percent.strip())
        except ValueError:
            continue
        if code.strip() and 0 < discount <= 100:
            result[code.strip().upper()] = discount
    return result


def promo_discount_percent(code: str | None) -> int:
    if not code:
        return 0
    return promo_codes().get(code.strip().upper(), 0)


def active_subscription(subscription: UserSubscription) -> bool:
    if not subscription.is_active or subscription.suspended_at is not None:
        return False
    return subscription.is_lifetime or subscription.expires_at is None or subscription.expires_at >= datetime.utcnow()


def activate_subscription_plan(
    db: Session,
    subscription: UserSubscription,
    plan: str,
    *,
    payment_status: str = "active",
    months: int = 1,
) -> None:
    normalized = normalize_plan(plan)
    defaults = quota_plan_defaults(normalized)
    subscription.plan = normalized
    subscription.plan_id = normalized
    subscription.plan_name = str(defaults["plan_name"])
    subscription.token_limit_monthly = plan_monthly_token_limit(db, normalized)
    subscription.tokens_added = subscription.token_limit_monthly
    subscription.daily_message_limit = plan_daily_message_limit(db, normalized)
    subscription.is_active = True
    subscription.status = "active"
    subscription.payment_status = payment_status
    subscription.suspended_at = None
    subscription.suspended_by = None
    subscription.started_at = datetime.utcnow()
    if not subscription.is_lifetime:
        subscription.expires_at = datetime.utcnow() + timedelta(days=30 * max(1, months))
    subscription.updated_at = datetime.utcnow()
    recalculate_token_balance(subscription)


def infer_provider_from_model(model: str) -> str:
    value = (model or "").lower()
    if "gemini" in value:
        return "Gemini"
    if value.startswith("gpt-") or value.startswith("o3") or value.startswith("o4"):
        return "OpenAI"
    return "Groq"


def ensure_admin_defaults(db: Session) -> None:
    changed = False
    for plan, defaults in DEFAULT_PLAN_LIMITS.items():
        existing = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan))
        if existing:
            default_price = int(defaults.get("price_paise", 0))
            if default_price > 0 and existing.price_paise == 0:
                existing.price_paise = default_price
                changed = True
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
        refresh_quota_periods(subscription)
        recalculate_token_balance(subscription)
        return subscription
    plan = "admin" if user.role in {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"} else "free"
    defaults = quota_plan_defaults(plan)
    monthly_token_limit = plan_monthly_token_limit(db, plan)
    daily_message_limit = plan_daily_message_limit(db, plan)
    subscription = UserSubscription(
        user_id=user.id,
        plan=plan,
        plan_id=plan,
        is_active=True,
        status="active",
        payment_status="admin" if plan == "admin" else "free",
        plan_name=str(defaults["plan_name"]),
        token_limit_monthly=monthly_token_limit,
        tokens_added=monthly_token_limit,
        daily_message_limit=daily_message_limit,
        tokens_used_monthly=0,
        bonus_tokens=0,
        messages_used_today=0,
        started_at=datetime.utcnow(),
    )
    recalculate_token_balance(subscription)
    try:
        with db.begin_nested():
            db.add(subscription)
            db.flush()
        return subscription
    except IntegrityError:
        existing = db.scalar(select(UserSubscription).where(UserSubscription.user_id == user.id))
        if not existing:
            raise
        refresh_quota_periods(existing)
        recalculate_token_balance(existing)
        return existing


def current_month_key() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def current_day_key() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def recalculate_token_balance(subscription: UserSubscription) -> None:
    if subscription.token_limit_monthly <= 0:
        subscription.token_balance = 0
        return
    total_quota = subscription.token_limit_monthly + subscription.bonus_tokens
    subscription.tokens_used_monthly = max(0, subscription.tokens_used_monthly)
    subscription.token_balance = max(0, total_quota - subscription.tokens_used_monthly)


def refresh_quota_periods(subscription: UserSubscription) -> bool:
    changed = False
    month_key = current_month_key()
    day_key = current_day_key()
    if subscription.token_usage_month != month_key:
        subscription.tokens_used_monthly = 0
        subscription.token_usage_month = month_key
        changed = True
    if subscription.messages_used_date != day_key:
        subscription.messages_used_today = 0
        subscription.messages_used_date = day_key
        changed = True
    recalculate_token_balance(subscription)
    return changed


def enforce_user_quota(db: Session, user: User, estimated_input_tokens: int = 0) -> UserSubscription:
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    if subscription.suspended_at is not None or not subscription.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Subscription is not active.")
    if subscription.daily_message_limit > 0 and subscription.messages_used_today >= subscription.daily_message_limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Daily message limit reached. Please upgrade or contact admin.",
        )
    if subscription.token_limit_monthly > 0:
        total_quota = subscription.token_limit_monthly + subscription.bonus_tokens
        if subscription.tokens_used_monthly >= total_quota or subscription.token_balance <= 0:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=TOKEN_LIMIT_EXCEEDED_MESSAGE)
        if estimated_input_tokens > 0 and subscription.tokens_used_monthly + BILLABLE_TOKENS_PER_INPUT > total_quota:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=TOKEN_LIMIT_EXCEEDED_MESSAGE)
    return subscription


def billable_usage() -> dict[str, int]:
    return {
        "prompt_tokens": BILLABLE_TOKENS_PER_INPUT,
        "completion_tokens": 0,
        "total_tokens": BILLABLE_TOKENS_PER_INPUT,
    }


def track_quota_usage(db: Session, user_id: str, total_tokens: int = BILLABLE_TOKENS_PER_INPUT) -> None:
    user = db.get(User, user_id)
    if not user:
        return
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    subscription.tokens_used_monthly = max(0, subscription.tokens_used_monthly + BILLABLE_TOKENS_PER_INPUT)
    subscription.messages_used_today = max(0, subscription.messages_used_today + 1)
    subscription.updated_at = datetime.utcnow()
    recalculate_token_balance(subscription)


def log_quota_action(
    db: Session,
    *,
    actor_user_id: str,
    target_user_id: str,
    action: str,
    reason: str = "",
    metadata: dict | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_user_id=actor_user_id,
            target_user_id=target_user_id,
            action=action,
            reason=reason.strip(),
            audit_metadata=metadata or {},
        )
    )


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


def intelligence_mode_access(db: Session, user: User, mode: str) -> tuple[bool, str | None]:
    canonical_mode = {"normal": "instant", "multi_model": "medium"}.get(mode, mode)
    if canonical_mode == "instant":
        return True, None
    if user.role in {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"}:
        return True, None

    subscription = ensure_user_subscription(db, user)
    subscription_is_active = active_subscription(subscription)
    plan_name = subscription.plan if subscription_is_active else "free"
    limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan_name))
    if not limits:
        limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == "free"))

    if canonical_mode == "deep_research":
        if not subscription_is_active or not limits or not limits.allow_deep_research:
            return False, "Deep Research is not enabled for this plan."
        if not is_feature_enabled(db, "deep_research", user.id):
            return False, "Deep Research is disabled for this account."
    elif canonical_mode in {"medium", "high", "coding"}:
        if not subscription_is_active or not limits or not limits.allow_multi_model:
            return False, "Multi-Model routing is not enabled for this plan."
        if not is_feature_enabled(db, "multi_model_routing", user.id):
            return False, "Multi-Model routing is disabled for this account."
    return True, None


def enforce_plan_and_feature_access(
    db: Session,
    user: User,
    *,
    mode: str,
    web_search: bool | None,
    search_mode: str | None,
    max_models: int | None = None,
) -> None:
    if user.role in {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"}:
        enforce_user_quota(db, user)
        return

    subscription = ensure_user_subscription(db, user)
    subscription_is_active = active_subscription(subscription)
    plan_name = subscription.plan if subscription_is_active else "free"
    limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan_name))
    if not limits:
        limits = db.scalar(select(PlanLimit).where(PlanLimit.plan == "free"))

    if mode == "deep_research":
        if not subscription_is_active or not limits or not limits.allow_deep_research:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deep Research is not enabled for this plan.")
        if not is_feature_enabled(db, "deep_research", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deep Research is disabled for this account.")

    if mode in {"multi_model", "medium", "high", "coding"}:
        if not subscription_is_active or not limits or not limits.allow_multi_model:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Multi-Model routing is not enabled for this plan.")
        if not is_feature_enabled(db, "multi_model_routing", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Multi-Model routing is disabled for this account.")

    search_requested = bool(web_search) or (search_mode not in {None, "off", "auto"})
    if search_requested:
        if not limits or not limits.allow_web_search:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Web search is not enabled for this plan.")
        if not is_feature_enabled(db, "web_search", user.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Web search is disabled for this account.")

    enforce_user_quota(db, user)


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
