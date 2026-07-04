from datetime import datetime
import platform
import shutil

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import get_db
from app.models.admin_control import FeatureFlag, PaymentRecord, PlanLimit, UserSubscription
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.document import Document
from app.models.message import Message
from app.models.user import User
from app.schemas.admin import (
    AdminAnalyticsResponse,
    AdminCreateUser,
    AdminFeatureFlagRead,
    AdminFeatureFlagUpdate,
    AdminFeaturesResponse,
    AdminPaymentRecordRead,
    AdminPlanLimitRead,
    AdminPlanLimitUpdate,
    AdminQuotaRead,
    AdminQuotaUpdate,
    AdminStats,
    AdminSubscriptionRead,
    AdminSubscriptionSummary,
    AdminSubscriptionUpdate,
    AdminTokenAdjustment,
    AdminUsageProviderSummary,
    AdminUsageResponse,
    AdminUsageTimeBucket,
    AdminUsageUserSummary,
    AdminUserPasswordReset,
    AdminUserRead,
    AdminUserRoleUpdate,
    AdminUserStatusUpdate,
    AdminUserUsageSummary,
    SystemStatus,
    TokenUsageSummary,
)
from app.services.admin_control import (
    FEATURE_DEFINITIONS,
    ensure_admin_defaults,
    ensure_user_subscription,
    expiry_status,
    infer_provider_from_model,
    log_quota_action,
    normalize_plan,
    quota_plan_defaults,
    recalculate_token_balance,
    refresh_quota_periods,
)


router = APIRouter(prefix="/admin", tags=["admin"])


def usage_for_user(db: Session, user_id: str) -> AdminUserUsageSummary:
    rows = db.execute(
        select(
            func.count(APIUsage.id),
            func.coalesce(func.sum(APIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(APIUsage.completion_tokens), 0),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
        ).where(APIUsage.user_id == user_id)
    ).one()
    chats = db.scalar(select(func.count()).select_from(Chat).where(Chat.user_id == user_id)) or 0
    return AdminUserUsageSummary(
        total_prompts=int(rows[0] or 0),
        prompt_tokens=int(rows[1] or 0),
        completion_tokens=int(rows[2] or 0),
        total_tokens=int(rows[3] or 0),
        total_chats=chats,
    )


def to_admin_user(db: Session, user: User) -> AdminUserRead:
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    return AdminUserRead(
        id=user.id,
        email=user.email,
        mobile=user.mobile,
        name=user.name,
        role=user.role,
        status="active" if user.is_active else "blocked",
        is_active=user.is_active,
        is_admin=user.is_admin,
        created_at=user.created_at,
        updated_at=user.updated_at,
        subscription=AdminSubscriptionSummary(
            plan=subscription.plan,
            is_active=subscription.is_active,
            expires_at=subscription.expires_at,
            payment_status=subscription.payment_status,
            expiry_status=expiry_status(subscription.expires_at),
        ),
        quota=to_quota_read(user, subscription),
        usage=usage_for_user(db, user.id),
    )


def to_quota_read(user: User, subscription: UserSubscription) -> AdminQuotaRead:
    recalculate_token_balance(subscription)
    return AdminQuotaRead(
        user_id=user.id,
        user_name=user.name,
        user_email=user.email,
        status="active" if user.is_active else "blocked",
        plan_name=subscription.plan_name,
        token_limit_monthly=subscription.token_limit_monthly,
        tokens_used_monthly=subscription.tokens_used_monthly,
        token_balance=subscription.token_balance,
        bonus_tokens=subscription.bonus_tokens,
        daily_message_limit=subscription.daily_message_limit,
        messages_used_today=subscription.messages_used_today,
        quota_updated_by=subscription.quota_updated_by,
        quota_updated_at=subscription.quota_updated_at,
    )


def get_user_or_404(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def normalized_plan_from_name(plan_name: str) -> str | None:
    value = plan_name.strip().lower().replace("_", "-")
    aliases = {
        "free": "free",
        "pro": "pro",
        "premium": "premium",
        "ultra": "ultra",
        "pro plus": "pro-plus",
        "pro-plus": "pro-plus",
        "admin": "admin",
    }
    return aliases.get(value)


def mark_quota_updated(subscription: UserSubscription, current_admin: User) -> None:
    subscription.quota_updated_by = current_admin.id
    subscription.quota_updated_at = datetime.utcnow()
    subscription.updated_at = datetime.utcnow()


def to_subscription_read(subscription: UserSubscription, user: User) -> AdminSubscriptionRead:
    return AdminSubscriptionRead(
        id=subscription.id,
        user_id=user.id,
        user_name=user.name,
        user_email=user.email,
        plan=subscription.plan,
        is_active=subscription.is_active,
        expires_at=subscription.expires_at,
        payment_status=subscription.payment_status,
        razorpay_customer_id=subscription.razorpay_customer_id,
        razorpay_payment_id=subscription.razorpay_payment_id,
        stripe_customer_id=subscription.stripe_customer_id,
        stripe_payment_id=subscription.stripe_payment_id,
        expiry_status=expiry_status(subscription.expires_at),
        created_at=subscription.created_at,
        updated_at=subscription.updated_at,
    )


def to_feature_read(flag: FeatureFlag, user: User | None = None) -> AdminFeatureFlagRead:
    return AdminFeatureFlagRead(
        id=flag.id,
        key=flag.key,
        scope=flag.scope,
        user_id=flag.user_id,
        user_email=user.email if user else None,
        enabled=flag.enabled,
        description=flag.description,
        created_at=flag.created_at,
        updated_at=flag.updated_at,
    )


def to_plan_limit_read(limit: PlanLimit) -> AdminPlanLimitRead:
    return AdminPlanLimitRead(
        id=limit.id,
        plan=limit.plan,
        daily_prompt_limit=limit.daily_prompt_limit,
        monthly_prompt_limit=limit.monthly_prompt_limit,
        daily_token_limit=limit.daily_token_limit,
        monthly_token_limit=limit.monthly_token_limit,
        max_models=limit.max_models,
        allow_deep_research=limit.allow_deep_research,
        allow_multi_model=limit.allow_multi_model,
        allow_web_search=limit.allow_web_search,
        created_at=limit.created_at,
        updated_at=limit.updated_at,
    )


def stats_payload(db: Session) -> AdminStats:
    usage = db.execute(
        select(
            func.coalesce(func.sum(APIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(APIUsage.completion_tokens), 0),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
            func.count(APIUsage.id),
        )
    ).one()
    total_users = db.scalar(select(func.count()).select_from(User)) or 0
    active_users = db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True))) or 0
    blocked_users = db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(False))) or 0
    total_chats = db.scalar(select(func.count()).select_from(Chat)) or 0
    total_api_usage = int(usage[3] or 0)
    total, _, free = shutil.disk_usage(settings.UPLOAD_DIR)
    paid_statuses = {"paid", "captured", "succeeded", "active"}
    active_subscriptions = db.scalar(
        select(func.count()).select_from(UserSubscription).where(UserSubscription.is_active.is_(True))
    ) or 0
    paid_subscriptions = db.scalar(
        select(func.count()).select_from(UserSubscription).where(
            UserSubscription.is_active.is_(True),
            UserSubscription.plan.in_(["pro", "premium", "ultra", "pro-plus", "admin"]),
        )
    ) or 0
    total_revenue_cents = db.scalar(
        select(func.coalesce(func.sum(PaymentRecord.amount_cents), 0)).where(PaymentRecord.status.in_(paid_statuses))
    ) or 0
    return AdminStats(
        total_users=total_users,
        active_users=active_users,
        blocked_users=blocked_users,
        total_chats=total_chats,
        total_api_usage=total_api_usage,
        active_subscriptions=active_subscriptions,
        paid_subscriptions=paid_subscriptions,
        total_revenue_cents=int(total_revenue_cents or 0),
        user_count=total_users,
        chat_count=total_chats,
        message_count=db.scalar(select(func.count()).select_from(Message)) or 0,
        document_count=db.scalar(select(func.count()).select_from(Document)) or 0,
        api_calls=total_api_usage,
        token_usage=TokenUsageSummary(
            prompt_tokens=int(usage[0] or 0),
            completion_tokens=int(usage[1] or 0),
            total_tokens=int(usage[2] or 0),
        ),
        system=SystemStatus(
            environment=settings.ENVIRONMENT,
            database_backend=settings.DB_BACKEND,
            python_version=platform.python_version(),
            storage_total_gb=round(total / 1024 / 1024 / 1024, 2),
            storage_free_gb=round(free / 1024 / 1024 / 1024, 2),
        ),
    )


@router.get("/stats", response_model=AdminStats)
def stats(_: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> AdminStats:
    return stats_payload(db)


@router.post("/users/create-admin", response_model=AdminUserRead, status_code=status.HTTP_201_CREATED)
def create_admin_user(
    payload: AdminCreateUser,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    if payload.role == "super_admin" and current_admin.role != "super_admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a super admin can create super admin accounts")
    email = str(payload.email).strip().lower()
    existing = db.scalar(select(User).where(User.email == email))
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A user with this email already exists.")
    user = User(
        email=email,
        name=payload.name.strip(),
        hashed_password=get_password_hash(payload.password),
        is_active=True,
        is_admin=True,
        role=payload.role,
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
        mark_quota_updated(subscription, current_admin)
        recalculate_token_balance(subscription)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A user with this email already exists.") from exc
    db.refresh(user)
    return to_admin_user(db, user)


@router.get("/users", response_model=list[AdminUserRead])
def list_users(
    search: str | None = Query(default=None),
    role: str | None = Query(default=None, pattern="^(user|admin|super_admin)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(active|blocked)$"),
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> list[AdminUserRead]:
    query = select(User)
    if search:
        term = f"%{search.strip().lower()}%"
        query = query.where(or_(func.lower(User.name).like(term), func.lower(User.email).like(term), User.mobile.like(term)))
    if role:
        query = query.where(User.role == role)
    if status_filter == "active":
        query = query.where(User.is_active.is_(True))
    if status_filter == "blocked":
        query = query.where(User.is_active.is_(False))
    users = db.scalars(query.order_by(User.created_at.desc())).all()
    result = [to_admin_user(db, user) for user in users]
    db.commit()
    return result


@router.get("/users/{user_id}", response_model=AdminUserRead)
def get_user(user_id: str, _: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> AdminUserRead:
    user = get_user_or_404(db, user_id)
    result = to_admin_user(db, user)
    db.commit()
    return result


@router.get("/users/{user_id}/quota", response_model=AdminQuotaRead)
def get_user_quota(
    user_id: str,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminQuotaRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    result = to_quota_read(user, subscription)
    db.commit()
    return result


@router.patch("/users/{user_id}/quota", response_model=AdminQuotaRead)
def update_user_quota(
    user_id: str,
    payload: AdminQuotaUpdate,
    force: bool = Query(default=False),
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminQuotaRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    force_update = force or payload.force
    before = to_quota_read(user, subscription).model_dump(mode="json")

    if payload.token_limit_monthly is not None:
        next_limit = payload.token_limit_monthly
        if next_limit > 0 and next_limit + subscription.bonus_tokens < subscription.tokens_used_monthly and not force_update:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Token limit cannot be less than tokens already used unless force=true.",
            )
        subscription.token_limit_monthly = next_limit
    if payload.daily_message_limit is not None:
        subscription.daily_message_limit = payload.daily_message_limit
    if payload.bonus_tokens is not None:
        if subscription.token_limit_monthly > 0 and subscription.token_limit_monthly + payload.bonus_tokens < subscription.tokens_used_monthly and not force_update:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Total token quota cannot be less than tokens already used unless force=true.",
            )
        subscription.bonus_tokens = payload.bonus_tokens
    if payload.plan_name is not None:
        subscription.plan_name = payload.plan_name
        normalized_plan = normalized_plan_from_name(payload.plan_name)
        if normalized_plan:
            subscription.plan = normalized_plan

    mark_quota_updated(subscription, current_admin)
    recalculate_token_balance(subscription)
    after = to_quota_read(user, subscription).model_dump(mode="json")
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="quota.update",
        metadata={"before": before, "after": after, "force": force_update},
    )
    db.commit()
    db.refresh(subscription)
    return to_quota_read(user, subscription)


@router.post("/users/{user_id}/tokens/add", response_model=AdminQuotaRead)
def add_user_tokens(
    user_id: str,
    payload: AdminTokenAdjustment,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminQuotaRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    before = to_quota_read(user, subscription).model_dump(mode="json")
    subscription.bonus_tokens += payload.amount
    mark_quota_updated(subscription, current_admin)
    recalculate_token_balance(subscription)
    after = to_quota_read(user, subscription).model_dump(mode="json")
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="quota.tokens.add",
        reason=payload.reason,
        metadata={"amount": payload.amount, "before": before, "after": after},
    )
    db.commit()
    db.refresh(subscription)
    return to_quota_read(user, subscription)


@router.post("/users/{user_id}/tokens/deduct", response_model=AdminQuotaRead)
def deduct_user_tokens(
    user_id: str,
    payload: AdminTokenAdjustment,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminQuotaRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    if subscription.token_limit_monthly <= 0 and payload.amount > 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot deduct tokens from an unlimited quota.")
    if payload.amount > subscription.token_balance:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot deduct more than the user's token balance.")
    before = to_quota_read(user, subscription).model_dump(mode="json")
    subscription.tokens_used_monthly = max(0, subscription.tokens_used_monthly + payload.amount)
    mark_quota_updated(subscription, current_admin)
    recalculate_token_balance(subscription)
    after = to_quota_read(user, subscription).model_dump(mode="json")
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="quota.tokens.deduct",
        reason=payload.reason,
        metadata={"amount": payload.amount, "before": before, "after": after},
    )
    db.commit()
    db.refresh(subscription)
    return to_quota_read(user, subscription)


@router.post("/users/{user_id}/tokens/reset", response_model=AdminQuotaRead)
def reset_user_tokens(
    user_id: str,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminQuotaRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    before = to_quota_read(user, subscription).model_dump(mode="json")
    subscription.tokens_used_monthly = 0
    subscription.messages_used_today = 0
    subscription.token_usage_month = datetime.utcnow().strftime("%Y-%m")
    subscription.messages_used_date = datetime.utcnow().strftime("%Y-%m-%d")
    mark_quota_updated(subscription, current_admin)
    recalculate_token_balance(subscription)
    after = to_quota_read(user, subscription).model_dump(mode="json")
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="quota.tokens.reset",
        metadata={"before": before, "after": after},
    )
    db.commit()
    db.refresh(subscription)
    return to_quota_read(user, subscription)


@router.patch("/users/{user_id}/status", response_model=AdminUserRead)
def update_user_status(
    user_id: str,
    payload: AdminUserStatusUpdate,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    user = get_user_or_404(db, user_id)
    if user.id == current_admin.id and not payload.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot block your own admin account")
    user.is_active = payload.is_active
    user.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(user)
    return to_admin_user(db, user)


@router.patch("/users/{user_id}/role", response_model=AdminUserRead)
def update_user_role(
    user_id: str,
    payload: AdminUserRoleUpdate,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.id == current_admin.id and payload.role not in {"admin", "super_admin"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot remove your own admin role")
    if (user.role == "super_admin" or payload.role == "super_admin") and current_admin.role != "super_admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only a super admin can manage super admin roles")
    user.role = payload.role
    user.is_admin = payload.role in {"admin", "super_admin"}
    user.updated_at = datetime.utcnow()
    subscription = ensure_user_subscription(db, user)
    if payload.role in {"admin", "super_admin"}:
        defaults = quota_plan_defaults("admin")
        subscription.plan = "admin"
        subscription.plan_name = str(defaults["plan_name"])
        subscription.token_limit_monthly = int(defaults["token_limit_monthly"])
        subscription.daily_message_limit = int(defaults["daily_message_limit"])
        subscription.is_active = True
        subscription.payment_status = "admin"
        mark_quota_updated(subscription, current_admin)
        recalculate_token_balance(subscription)
    db.commit()
    db.refresh(user)
    return to_admin_user(db, user)


def reset_user_password_record(db: Session, user_id: str, payload: AdminUserPasswordReset) -> AdminUserRead:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.hashed_password = get_password_hash(payload.new_password)
    user.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(user)
    return to_admin_user(db, user)


@router.patch("/users/{user_id}/reset-password", response_model=AdminUserRead)
def reset_user_password(
    user_id: str,
    payload: AdminUserPasswordReset,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    return reset_user_password_record(db, user_id, payload)


@router.patch("/users/{user_id}/password", response_model=AdminUserRead)
def reset_user_password_legacy(
    user_id: str,
    payload: AdminUserPasswordReset,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    return reset_user_password_record(db, user_id, payload)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: str, current_admin: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.id == current_admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own admin account")
    db.delete(user)
    db.commit()


@router.get("/subscriptions", response_model=list[AdminSubscriptionRead])
def list_subscriptions(
    plan: str | None = Query(default=None, pattern="^(free|pro|premium|ultra|pro-plus|admin)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(active|inactive)$"),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> list[AdminSubscriptionRead]:
    users = db.scalars(select(User).order_by(User.created_at.desc())).all()
    result: list[AdminSubscriptionRead] = []
    for user in users:
        subscription = ensure_user_subscription(db, user)
        if plan and subscription.plan != plan:
            continue
        if status_filter == "active" and not subscription.is_active:
            continue
        if status_filter == "inactive" and subscription.is_active:
            continue
        result.append(to_subscription_read(subscription, user))
    db.commit()
    return result


@router.patch("/subscriptions/{user_id}", response_model=AdminSubscriptionRead)
def update_subscription(
    user_id: str,
    payload: AdminSubscriptionUpdate,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminSubscriptionRead:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    subscription = ensure_user_subscription(db, user)
    updates = payload.model_dump(exclude_unset=True)
    if "plan" in updates and updates["plan"] is not None:
        subscription.plan = normalize_plan(updates["plan"])
        defaults = quota_plan_defaults(subscription.plan)
        subscription.plan_name = str(defaults["plan_name"])
        subscription.token_limit_monthly = int(defaults["token_limit_monthly"])
        subscription.daily_message_limit = int(defaults["daily_message_limit"])
        mark_quota_updated(subscription, current_admin)
        recalculate_token_balance(subscription)
    for field in (
        "is_active",
        "expires_at",
        "payment_status",
        "razorpay_customer_id",
        "razorpay_payment_id",
        "stripe_customer_id",
        "stripe_payment_id",
    ):
        if field in updates:
            setattr(subscription, field, updates[field])
    subscription.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(subscription)
    return to_subscription_read(subscription, user)


@router.get("/subscriptions/payments", response_model=list[AdminPaymentRecordRead])
def list_payments(_: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> list[AdminPaymentRecordRead]:
    rows = db.execute(
        select(PaymentRecord, User)
        .outerjoin(User, PaymentRecord.user_id == User.id)
        .order_by(PaymentRecord.created_at.desc())
    ).all()
    return [
        AdminPaymentRecordRead(
            id=payment.id,
            user_id=payment.user_id,
            user_name=user.name if user else None,
            user_email=user.email if user else None,
            provider=payment.provider,
            customer_id=payment.customer_id,
            payment_id=payment.payment_id,
            subscription_id=payment.subscription_id,
            plan=payment.plan,
            amount_cents=payment.amount_cents,
            currency=payment.currency,
            status=payment.status,
            created_at=payment.created_at,
        )
        for payment, user in rows
    ]


def provider_summaries(rows: list[tuple[str, int, int, int, int]]) -> list[AdminUsageProviderSummary]:
    providers: dict[str, dict[str, int]] = {}
    for model, requests, prompt_tokens, completion_tokens, total_tokens in rows:
        provider = infer_provider_from_model(model)
        item = providers.setdefault(
            provider,
            {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        )
        item["requests"] += int(requests or 0)
        item["prompt_tokens"] += int(prompt_tokens or 0)
        item["completion_tokens"] += int(completion_tokens or 0)
        item["total_tokens"] += int(total_tokens or 0)
    return [
        AdminUsageProviderSummary(provider=provider, **values)
        for provider, values in sorted(providers.items(), key=lambda item: item[0])
    ]


def usage_time_buckets(db: Session, date_format: str, limit: int) -> list[AdminUsageTimeBucket]:
    rows = db.execute(
        select(
            func.strftime(date_format, APIUsage.created_at),
            func.count(APIUsage.id),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
        )
        .group_by(func.strftime(date_format, APIUsage.created_at))
        .order_by(func.strftime(date_format, APIUsage.created_at).desc())
        .limit(limit)
    ).all()
    return [
        AdminUsageTimeBucket(period=str(period), requests=int(requests or 0), total_tokens=int(total_tokens or 0))
        for period, requests, total_tokens in reversed(rows)
    ]


@router.get("/usage", response_model=AdminUsageResponse)
def usage(_: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> AdminUsageResponse:
    users = db.scalars(select(User).order_by(User.created_at.desc())).all()
    user_summaries: list[AdminUsageUserSummary] = []
    for user in users:
        subscription = ensure_user_subscription(db, user)
        model_rows = db.execute(
            select(
                APIUsage.model,
                func.count(APIUsage.id),
                func.coalesce(func.sum(APIUsage.prompt_tokens), 0),
                func.coalesce(func.sum(APIUsage.completion_tokens), 0),
                func.coalesce(func.sum(APIUsage.total_tokens), 0),
            )
            .where(APIUsage.user_id == user.id)
            .group_by(APIUsage.model)
        ).all()
        providers = provider_summaries(model_rows)
        user_summaries.append(
            AdminUsageUserSummary(
                user_id=user.id,
                user_name=user.name,
                user_email=user.email,
                plan=subscription.plan,
                total_prompts=sum(item.requests for item in providers),
                prompt_tokens=sum(item.prompt_tokens for item in providers),
                completion_tokens=sum(item.completion_tokens for item in providers),
                total_tokens=sum(item.total_tokens for item in providers),
                providers=providers,
            )
        )
    all_model_rows = db.execute(
        select(
            APIUsage.model,
            func.count(APIUsage.id),
            func.coalesce(func.sum(APIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(APIUsage.completion_tokens), 0),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
        ).group_by(APIUsage.model)
    ).all()
    db.commit()
    return AdminUsageResponse(
        users=user_summaries,
        providers=provider_summaries(all_model_rows),
        daily=usage_time_buckets(db, "%Y-%m-%d", 31),
        monthly=usage_time_buckets(db, "%Y-%m", 12),
    )


@router.get("/features", response_model=AdminFeaturesResponse)
def features(
    user_id: str | None = Query(default=None),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminFeaturesResponse:
    ensure_admin_defaults(db)
    query = select(FeatureFlag, User).outerjoin(User, FeatureFlag.user_id == User.id)
    if user_id:
        query = query.where(or_(FeatureFlag.user_id == user_id, FeatureFlag.scope == "global"))
    rows = db.execute(query.order_by(FeatureFlag.scope, FeatureFlag.key)).all()
    plan_limits = db.scalars(select(PlanLimit).order_by(PlanLimit.plan)).all()
    return AdminFeaturesResponse(
        flags=[to_feature_read(flag, user) for flag, user in rows],
        plan_limits=[to_plan_limit_read(limit) for limit in plan_limits],
    )


@router.patch("/features", response_model=AdminFeatureFlagRead)
def update_feature(
    payload: AdminFeatureFlagUpdate,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminFeatureFlagRead:
    if payload.key not in FEATURE_DEFINITIONS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown feature flag")
    user = db.get(User, payload.user_id) if payload.user_id else None
    if payload.user_id and not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    scope = "user" if payload.user_id else "global"
    query = select(FeatureFlag).where(FeatureFlag.key == payload.key, FeatureFlag.scope == scope)
    query = query.where(FeatureFlag.user_id == payload.user_id) if payload.user_id else query.where(FeatureFlag.user_id.is_(None))
    flag = db.scalar(query)
    if not flag:
        flag = FeatureFlag(
            key=payload.key,
            scope=scope,
            user_id=payload.user_id,
            enabled=payload.enabled,
            description=FEATURE_DEFINITIONS[payload.key],
        )
        db.add(flag)
    else:
        flag.enabled = payload.enabled
        flag.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(flag)
    return to_feature_read(flag, user)


@router.patch("/features/plan-limits/{plan}", response_model=AdminPlanLimitRead)
def update_plan_limit(
    plan: str,
    payload: AdminPlanLimitUpdate,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminPlanLimitRead:
    plan = normalize_plan(plan)
    limit = db.scalar(select(PlanLimit).where(PlanLimit.plan == plan))
    if not limit:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plan limit not found")
    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(limit, field, value)
    limit.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(limit)
    return to_plan_limit_read(limit)


@router.get("/analytics", response_model=AdminAnalyticsResponse)
def analytics(_: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> AdminAnalyticsResponse:
    stats = stats_payload(db)
    subscription_rows = db.execute(
        select(UserSubscription.plan, func.count(UserSubscription.id)).group_by(UserSubscription.plan)
    ).all()
    payment_rows = db.execute(
        select(PaymentRecord.status, func.count(PaymentRecord.id)).group_by(PaymentRecord.status)
    ).all()
    model_rows = db.execute(
        select(
            APIUsage.model,
            func.count(APIUsage.id),
            func.coalesce(func.sum(APIUsage.prompt_tokens), 0),
            func.coalesce(func.sum(APIUsage.completion_tokens), 0),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
        ).group_by(APIUsage.model)
    ).all()
    return AdminAnalyticsResponse(
        stats=stats,
        subscriptions_by_plan={str(plan): int(count or 0) for plan, count in subscription_rows},
        users_by_status={"active": stats.active_users, "blocked": stats.blocked_users},
        usage_by_provider=provider_summaries(model_rows),
        payments_by_status={str(name): int(count or 0) for name, count in payment_rows},
        daily_usage=usage_time_buckets(db, "%Y-%m-%d", 31),
    )
