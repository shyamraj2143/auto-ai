from datetime import datetime, timedelta
import platform
import shutil

import razorpay
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import Response
from razorpay.errors import BadRequestError, GatewayError, ServerError
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import ValidationError

from app.api.deps import get_current_admin
from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import get_db
from app.models.admin_control import AuditLog, FeatureFlag, PaymentRecord, PlanLimit, UserSubscription
from app.models.api_usage import APIUsage
from app.models.apk import ApkRelease
from app.models.chat import Chat
from app.models.document import Document
from app.models.message import Message
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User
from app.schemas.admin import (
    AdminAnalyticsResponse,
    AdminAuditLogPage,
    AdminAuditLogRead,
    AdminCreateUser,
    AdminFeatureFlagRead,
    AdminFeatureFlagUpdate,
    AdminFeaturesResponse,
    AdminPaymentRecordRead,
    AdminPaymentPage,
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
from app.schemas.download import ApkReleaseRead, ApkVersionUpsert
from app.schemas.promo import (
    PromoArchiveRequest,
    PromoCodeCreate,
    PromoCodePage,
    PromoCodeRead,
    PromoCodeUpdate,
    PromoRedemptionPage,
    PromoRedemptionRead,
    PromoStatusFilter,
)
from app.services.admin_control import (
    FEATURE_DEFINITIONS,
    activate_subscription_plan,
    ensure_admin_defaults,
    ensure_user_subscription,
    expiry_status,
    infer_provider_from_model,
    log_quota_action,
    normalize_plan,
    quota_plan_defaults,
    plan_daily_message_limit,
    plan_monthly_token_limit,
    recalculate_token_balance,
    refresh_quota_periods,
)
from app.services.apk_service import apk_service
from app.services.firebase_notifications import firebase_notification_service
from app.services.orchestration.model_registry import model_registry
from app.services.response_cache import response_cache
from app.api.routes.notifications import dispatch_apk_update_notifications
from app.services.promo_service import SUCCESS_PAYMENT_STATUSES, promo_status


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/audit-logs", response_model=AdminAuditLogPage)
def audit_logs(
    search: str | None = Query(default=None, max_length=120),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminAuditLogPage:
    query = select(AuditLog)
    count_query = select(func.count(AuditLog.id))
    if search:
        term = f"%{search.strip().lower()}%"
        condition = or_(func.lower(AuditLog.action).like(term), func.lower(AuditLog.reason).like(term), AuditLog.actor_user_id.like(term), AuditLog.target_user_id.like(term))
        query = query.where(condition)
        count_query = count_query.where(condition)
    total = int(db.scalar(count_query) or 0)
    rows = db.scalars(query.order_by(AuditLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return AdminAuditLogPage(items=[AdminAuditLogRead(id=item.id, actor_user_id=item.actor_user_id, target_user_id=item.target_user_id, action=item.action, reason=item.reason, metadata_payload=item.audit_metadata or {}, created_at=item.created_at) for item in rows], page=page, page_size=page_size, total=total, total_pages=max(1, (total + page_size - 1) // page_size))


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
    sync_user_subscription_status(user, subscription)
    return AdminUserRead(
        id=user.id,
        email=user.email,
        mobile=user.mobile,
        name=user.name,
        picture=user.picture,
        avatar=user.avatar,
        provider=user.provider,
        google_id=user.google_id,
        role=user.role,
        subscription_status=user.subscription_status,
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
    identifier = user_id.strip()
    user = db.get(User, identifier)
    if not user:
        lowered = identifier.lower()
        user = db.scalar(
            select(User).where(
                or_(
                    func.lower(User.email) == lowered,
                    User.mobile == identifier,
                    User.username == identifier,
                )
            )
        )
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


def sync_user_subscription_status(user: User, subscription: UserSubscription) -> None:
    user.subscription_status = "suspended" if subscription.suspended_at else (subscription.status or subscription.payment_status or "free")
    user.updated_at = datetime.utcnow()


def admin_razorpay_client() -> razorpay.Client:
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay credentials are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
        )
    return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET.get_secret_value()))


def admin_razorpay_error_detail(error: Exception) -> str:
    message = str(error).lower()
    if "expired" in message and "api key" in message:
        return "Razorpay API key has expired. Update RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
    if "auth" in message or "unauthorized" in message or "invalid api key" in message or "api key" in message:
        return "Razorpay authentication failed. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
    return "Razorpay refund failed."


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
        auto_renewal=subscription.auto_renewal,
        is_lifetime=subscription.is_lifetime,
        suspended_at=subscription.suspended_at,
        token_limit_monthly=subscription.token_limit_monthly,
        tokens_used_monthly=subscription.tokens_used_monthly,
        token_balance=subscription.token_balance,
        daily_message_limit=subscription.daily_message_limit,
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


def to_payment_read(
    payment: PaymentRecord,
    user: User | None = None,
    subscription: UserSubscription | None = None,
) -> AdminPaymentRecordRead:
    amount = int(payment.amount or payment.amount_cents or 0)
    return AdminPaymentRecordRead(
        id=payment.id,
        user_id=payment.user_id,
        user_name=user.name if user else None,
        user_email=user.email if user else payment.user_email,
        provider=payment.provider,
        customer_id=payment.customer_id,
        payment_id=payment.razorpay_payment_id or payment.payment_id,
        subscription_id=payment.razorpay_order_id or payment.subscription_id,
        plan=payment.plan_id or payment.plan,
        plan_id=payment.plan_id or payment.plan,
        amount=amount,
        amount_cents=amount,
        currency=payment.currency,
        status=payment.status,
        razorpay_order_id=payment.razorpay_order_id,
        razorpay_payment_id=payment.razorpay_payment_id or payment.payment_id,
        paid_at=payment.paid_at,
        subscription_status=subscription.status if subscription else None,
        receipt_number=payment.receipt_number,
        receipt_url=(
            f"/api/v1/admin/subscriptions/payments/{payment.id}/receipt"
            if payment.status in SUCCESS_PAYMENT_STATUSES and payment.verified_at is not None
            else None
        ),
        original_amount_paise=payment.original_amount_paise or amount,
        discount_amount_paise=payment.discount_amount_paise or 0,
        promo_code=payment.promo_code_snapshot,
        created_at=payment.created_at,
        updated_at=payment.updated_at,
    )


def to_promo_read(promo: PromoCode) -> PromoCodeRead:
    return PromoCodeRead(
        id=promo.id,
        code=promo.normalized_code,
        description=promo.description,
        discount_type=promo.discount_type,
        discount_value=promo.discount_value,
        currency=promo.currency,
        eligible_plans=list(promo.eligible_plans or []),
        minimum_amount=promo.minimum_amount,
        maximum_discount=promo.maximum_discount,
        starts_at=promo.starts_at,
        expires_at=promo.expires_at,
        total_usage_limit=promo.total_usage_limit,
        per_user_limit=promo.per_user_limit,
        usage_count=promo.usage_count,
        is_active=promo.is_active,
        is_archived=promo.is_archived,
        new_users_only=promo.new_users_only,
        created_by=promo.created_by,
        created_at=promo.created_at,
        updated_at=promo.updated_at,
        status=promo_status(promo),
    )


def log_promo_action(db: Session, admin: User, promo: PromoCode, action: str, metadata: dict | None = None) -> None:
    db.add(
        AuditLog(
            actor_user_id=admin.id,
            action=action,
            reason=f"Promo {promo.normalized_code}",
            audit_metadata={"promo_code_id": promo.id, "code": promo.normalized_code, **(metadata or {})},
        )
    )


@router.get("/promo-codes", response_model=PromoCodePage)
def list_promo_codes(
    query: str = Query(default="", max_length=80),
    status_filter: PromoStatusFilter = Query(default="all", alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoCodePage:
    now = datetime.utcnow()
    statement = select(PromoCode)
    term = query.strip()
    if term:
        pattern = f"%{term}%"
        statement = statement.where(or_(PromoCode.normalized_code.ilike(pattern), PromoCode.description.ilike(pattern)))
    if status_filter == "active":
        statement = statement.where(
            PromoCode.is_archived.is_(False),
            PromoCode.is_active.is_(True),
            or_(PromoCode.starts_at.is_(None), PromoCode.starts_at <= now),
            or_(PromoCode.expires_at.is_(None), PromoCode.expires_at > now),
        )
    elif status_filter == "inactive":
        statement = statement.where(PromoCode.is_archived.is_(False), PromoCode.is_active.is_(False))
    elif status_filter == "archived":
        statement = statement.where(PromoCode.is_archived.is_(True))
    elif status_filter == "expired":
        statement = statement.where(PromoCode.is_archived.is_(False), PromoCode.expires_at <= now)
    elif status_filter == "scheduled":
        statement = statement.where(PromoCode.is_archived.is_(False), PromoCode.starts_at > now)
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    promos = db.scalars(
        statement.order_by(PromoCode.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return PromoCodePage(
        items=[to_promo_read(promo) for promo in promos],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=max(1, (total + page_size - 1) // page_size),
    )


@router.post("/promo-codes", response_model=PromoCodeRead, status_code=status.HTTP_201_CREATED)
def create_promo_code(
    payload: PromoCodeCreate,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoCodeRead:
    promo = PromoCode(
        normalized_code=payload.code,
        description=payload.description.strip(),
        discount_type=payload.discount_type,
        discount_value=payload.discount_value,
        currency=payload.currency,
        eligible_plans=list(payload.eligible_plans),
        minimum_amount=payload.minimum_amount,
        maximum_discount=payload.maximum_discount,
        starts_at=payload.starts_at,
        expires_at=payload.expires_at,
        total_usage_limit=payload.total_usage_limit,
        per_user_limit=payload.per_user_limit,
        is_active=payload.is_active,
        new_users_only=payload.new_users_only,
        created_by=current_admin.id,
    )
    try:
        db.add(promo)
        db.flush()
        log_promo_action(db, current_admin, promo, "promo.created")
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Promo code already exists.") from exc
    db.refresh(promo)
    return to_promo_read(promo)


@router.get("/promo-codes/{promo_id}", response_model=PromoCodeRead)
def get_promo_code(
    promo_id: str,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoCodeRead:
    promo = db.get(PromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promo code not found.")
    return to_promo_read(promo)


@router.patch("/promo-codes/{promo_id}", response_model=PromoCodeRead)
def update_promo_code(
    promo_id: str,
    payload: PromoCodeUpdate,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoCodeRead:
    promo = db.get(PromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promo code not found.")
    changes = payload.model_dump(exclude_unset=True)
    merged = {
        "code": promo.normalized_code,
        "description": changes.get("description", promo.description),
        "discount_type": changes.get("discount_type", promo.discount_type),
        "discount_value": changes.get("discount_value", promo.discount_value),
        "currency": changes.get("currency", promo.currency),
        "eligible_plans": changes.get("eligible_plans", promo.eligible_plans),
        "minimum_amount": changes.get("minimum_amount", promo.minimum_amount),
        "maximum_discount": changes.get("maximum_discount", promo.maximum_discount),
        "starts_at": changes.get("starts_at", promo.starts_at),
        "expires_at": changes.get("expires_at", promo.expires_at),
        "total_usage_limit": changes.get("total_usage_limit", promo.total_usage_limit),
        "per_user_limit": changes.get("per_user_limit", promo.per_user_limit),
        "is_active": changes.get("is_active", promo.is_active),
        "new_users_only": changes.get("new_users_only", promo.new_users_only),
    }
    try:
        validated = PromoCodeCreate.model_validate(merged)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.errors()) from exc
    for field, value in validated.model_dump(exclude={"code"}).items():
        setattr(promo, field, value)
    promo.updated_at = datetime.utcnow()
    action = "promo.status_changed" if set(changes) == {"is_active"} else "promo.edited"
    log_promo_action(db, current_admin, promo, action, {"fields": sorted(changes)})
    db.commit()
    db.refresh(promo)
    return to_promo_read(promo)


@router.patch("/promo-codes/{promo_id}/archive", response_model=PromoCodeRead)
def archive_promo_code(
    promo_id: str,
    payload: PromoArchiveRequest,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoCodeRead:
    promo = db.get(PromoCode, promo_id)
    if not promo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promo code not found.")
    promo.is_archived = payload.archived
    if payload.archived:
        promo.is_active = False
    promo.updated_at = datetime.utcnow()
    log_promo_action(db, current_admin, promo, "promo.archived" if payload.archived else "promo.restored")
    db.commit()
    db.refresh(promo)
    return to_promo_read(promo)


@router.get("/promo-codes/{promo_id}/redemptions", response_model=PromoRedemptionPage)
def promo_redemptions(
    promo_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> PromoRedemptionPage:
    if not db.get(PromoCode, promo_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Promo code not found.")
    statement = (
        select(PromoRedemption, User)
        .outerjoin(User, PromoRedemption.user_id == User.id)
        .where(PromoRedemption.promo_code_id == promo_id)
    )
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    rows = db.execute(
        statement.order_by(PromoRedemption.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return PromoRedemptionPage(
        items=[
            PromoRedemptionRead(
                id=redemption.id,
                user_id=redemption.user_id,
                user_email=user.email if user else None,
                payment_id=redemption.payment_id,
                original_amount=redemption.original_amount,
                discount_amount=redemption.discount_amount,
                final_amount=redemption.final_amount,
                status=redemption.status,
                redeemed_at=redemption.redeemed_at,
                created_at=redemption.created_at,
            )
            for redemption, user in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=max(1, (total + page_size - 1) // page_size),
    )


def to_plan_limit_read(limit: PlanLimit) -> AdminPlanLimitRead:
    return AdminPlanLimitRead(
        id=limit.id,
        plan=limit.plan,
        price_paise=limit.price_paise,
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


def sync_plan_limit_subscriptions(db: Session, limit: PlanLimit, current_admin: User) -> None:
    subscriptions = db.scalars(
        select(UserSubscription).where(or_(UserSubscription.plan == limit.plan, UserSubscription.plan_id == limit.plan))
    ).all()
    for subscription in subscriptions:
        refresh_quota_periods(subscription)
        subscription.daily_message_limit = limit.daily_prompt_limit
        subscription.token_limit_monthly = limit.monthly_token_limit
        subscription.tokens_added = limit.monthly_token_limit
        recalculate_token_balance(subscription)
        mark_quota_updated(subscription, current_admin)
        log_quota_action(
            db,
            actor_user_id=current_admin.id,
            target_user_id=subscription.user_id,
            action="plan_limit_sync",
            metadata={
                "plan": limit.plan,
                "price_paise": limit.price_paise,
                "daily_message_limit": limit.daily_prompt_limit,
                "token_limit_monthly": limit.monthly_token_limit,
            },
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
    paid_statuses = {"paid", "verified", "captured", "succeeded", "active", "restored", "lifetime"}
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
        subscription.token_limit_monthly = plan_monthly_token_limit(db, "admin")
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.daily_message_limit = plan_daily_message_limit(db, "admin")
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
    role: str | None = Query(default=None, pattern="^(user|admin|super_admin|content_admin|content_editor|content_viewer)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(active|blocked)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=200),
    sort_by: str = Query(default="created_at", pattern="^(created_at|name|email|role)$"),
    sort_order: str = Query(default="desc", pattern="^(asc|desc)$"),
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
    sort_column = {"created_at": User.created_at, "name": User.name, "email": User.email, "role": User.role}[sort_by]
    ordering = sort_column.asc() if sort_order == "asc" else sort_column.desc()
    users = db.scalars(query.order_by(ordering).offset((page - 1) * page_size).limit(page_size)).all()
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
    before = user.is_active
    user.is_active = payload.is_active
    user.updated_at = datetime.utcnow()
    db.add(AuditLog(actor_user_id=current_admin.id, target_user_id=user.id, action="admin.user.status", reason="Administrator changed account state", audit_metadata={"before": before, "after": payload.is_active, "target_email": user.email}))
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
    before = user.role
    user.role = payload.role
    user.is_admin = payload.role in {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"}
    user.updated_at = datetime.utcnow()
    subscription = ensure_user_subscription(db, user)
    if payload.role in {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"}:
        defaults = quota_plan_defaults("admin")
        subscription.plan = "admin"
        subscription.plan_name = str(defaults["plan_name"])
        subscription.token_limit_monthly = plan_monthly_token_limit(db, "admin")
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.daily_message_limit = plan_daily_message_limit(db, "admin")
        subscription.is_active = True
        subscription.payment_status = "admin"
        mark_quota_updated(subscription, current_admin)
        recalculate_token_balance(subscription)
    db.add(AuditLog(actor_user_id=current_admin.id, target_user_id=user.id, action="admin.user.role", reason="Administrator changed account role", audit_metadata={"before": before, "after": payload.role, "target_email": user.email}))
    db.commit()
    db.refresh(user)
    return to_admin_user(db, user)


def reset_user_password_record(db: Session, user_id: str, payload: AdminUserPasswordReset, current_admin: User) -> AdminUserRead:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.hashed_password = get_password_hash(payload.new_password)
    user.updated_at = datetime.utcnow()
    db.add(AuditLog(actor_user_id=current_admin.id, target_user_id=user.id, action="admin.user.password_reset", reason="Administrator reset the target account password", audit_metadata={"target_email": user.email}))
    db.commit()
    db.refresh(user)
    return to_admin_user(db, user)


@router.patch("/users/{user_id}/reset-password", response_model=AdminUserRead)
def reset_user_password(
    user_id: str,
    payload: AdminUserPasswordReset,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    return reset_user_password_record(db, user_id, payload, current_admin)


@router.patch("/users/{user_id}/password", response_model=AdminUserRead)
def reset_user_password_legacy(
    user_id: str,
    payload: AdminUserPasswordReset,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminUserRead:
    return reset_user_password_record(db, user_id, payload, current_admin)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: str, current_admin: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.id == current_admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own admin account")
    db.add(AuditLog(actor_user_id=current_admin.id, target_user_id=user.id, action="admin.user.delete", reason="Administrator deleted the target account", audit_metadata={"target_email": user.email, "target_role": user.role}))
    db.flush()
    db.delete(user)
    db.commit()


@router.get("/subscriptions", response_model=list[AdminSubscriptionRead])
def list_subscriptions(
    plan: str | None = Query(default=None, pattern="^(free|pro|premium|ultra|pro-plus|admin)$"),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(active|inactive)$"),
    search: str | None = Query(default=None, max_length=120),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=200),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> list[AdminSubscriptionRead]:
    query = select(User).outerjoin(UserSubscription, UserSubscription.user_id == User.id)
    if search:
        term = f"%{search.strip().lower()}%"
        query = query.where(or_(func.lower(User.name).like(term), func.lower(User.email).like(term)))
    if plan:
        query = query.where(UserSubscription.plan == plan)
    if status_filter == "active":
        query = query.where(UserSubscription.is_active.is_(True))
    if status_filter == "inactive":
        query = query.where(UserSubscription.is_active.is_(False))
    users = db.scalars(query.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    result: list[AdminSubscriptionRead] = []
    for user in users:
        subscription = ensure_user_subscription(db, user)
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
    before = {"plan": subscription.plan, "status": subscription.status, "is_active": subscription.is_active, "auto_renewal": subscription.auto_renewal, "is_lifetime": subscription.is_lifetime, "expires_at": subscription.expires_at.isoformat() if subscription.expires_at else None}
    if "plan" in updates and updates["plan"] is not None:
        subscription.plan = normalize_plan(updates["plan"])
        subscription.plan_id = subscription.plan
        defaults = quota_plan_defaults(subscription.plan)
        subscription.plan_name = str(defaults["plan_name"])
        subscription.token_limit_monthly = plan_monthly_token_limit(db, subscription.plan)
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.daily_message_limit = plan_daily_message_limit(db, subscription.plan)
        subscription.status = "active" if subscription.is_active else "inactive"
        mark_quota_updated(subscription, current_admin)
        recalculate_token_balance(subscription)
    for field in (
        "is_active",
        "auto_renewal",
        "is_lifetime",
        "expires_at",
        "payment_status",
        "razorpay_customer_id",
        "razorpay_payment_id",
        "stripe_customer_id",
        "stripe_payment_id",
    ):
        if field in updates:
            setattr(subscription, field, updates[field])
    if "is_active" in updates:
        subscription.status = "active" if subscription.is_active else "inactive"
    if subscription.is_lifetime:
        subscription.expires_at = None
        subscription.is_active = True
        subscription.status = "active"
        subscription.suspended_at = None
        subscription.suspended_by = None
    subscription.updated_at = datetime.utcnow()
    sync_user_subscription_status(user, subscription)
    db.add(AuditLog(actor_user_id=current_admin.id, target_user_id=user.id, action="admin.subscription.update", reason="Administrator modified subscription", audit_metadata={"before": before, "changed_fields": sorted(updates), "target_email": user.email}))
    db.commit()
    db.refresh(subscription)
    return to_subscription_read(subscription, user)


@router.post("/subscriptions/{user_id}/lifetime", response_model=AdminSubscriptionRead)
def activate_lifetime_subscription(
    user_id: str,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminSubscriptionRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    activate_subscription_plan(db, subscription, subscription.plan if subscription.plan != "free" else "ultra", payment_status="lifetime")
    subscription.is_lifetime = True
    subscription.expires_at = None
    mark_quota_updated(subscription, current_admin)
    sync_user_subscription_status(user, subscription)
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="subscription.lifetime",
        metadata={"plan": subscription.plan},
    )
    db.commit()
    db.refresh(subscription)
    return to_subscription_read(subscription, user)


@router.post("/subscriptions/{user_id}/suspend", response_model=AdminSubscriptionRead)
def suspend_subscription(
    user_id: str,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminSubscriptionRead:
    user = get_user_or_404(db, user_id)
    subscription = ensure_user_subscription(db, user)
    subscription.is_active = False
    subscription.status = "suspended"
    subscription.payment_status = "suspended"
    subscription.suspended_at = datetime.utcnow()
    subscription.suspended_by = current_admin.id
    subscription.updated_at = datetime.utcnow()
    sync_user_subscription_status(user, subscription)
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=user.id,
        action="subscription.suspend",
        metadata={"plan": subscription.plan},
    )
    db.commit()
    db.refresh(subscription)
    return to_subscription_read(subscription, user)


@router.get("/subscriptions/payments", response_model=AdminPaymentPage)
def list_payments(
    query: str = Query(default="", max_length=120),
    payment_status: str = Query(default="all", alias="status", pattern="^(all|success|failed)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminPaymentPage:
    statement = (
        select(PaymentRecord, User, UserSubscription)
        .outerjoin(User, PaymentRecord.user_id == User.id)
        .outerjoin(UserSubscription, UserSubscription.user_id == PaymentRecord.user_id)
    )
    term = query.strip()
    if payment_status == "success":
        statement = statement.where(PaymentRecord.status.in_(SUCCESS_PAYMENT_STATUSES))
    elif payment_status == "failed":
        statement = statement.where(PaymentRecord.status == "failed")
    if date_from:
        statement = statement.where(PaymentRecord.created_at >= date_from)
    if date_to:
        statement = statement.where(PaymentRecord.created_at <= date_to)
    if term:
        pattern = f"%{term}%"
        statement = statement.where(
            or_(
                User.name.ilike(pattern),
                User.email.ilike(pattern),
                PaymentRecord.user_email.ilike(pattern),
                PaymentRecord.receipt_number.ilike(pattern),
                PaymentRecord.payment_id.ilike(pattern),
                PaymentRecord.razorpay_payment_id.ilike(pattern),
                PaymentRecord.subscription_id.ilike(pattern),
                PaymentRecord.razorpay_order_id.ilike(pattern),
                PaymentRecord.plan.ilike(pattern),
                PaymentRecord.plan_id.ilike(pattern),
                cast(PaymentRecord.amount, String).ilike(pattern),
            )
        )
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    rows = db.execute(
        statement.order_by(PaymentRecord.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return AdminPaymentPage(
        items=[to_payment_read(payment, user, subscription) for payment, user, subscription in rows],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=max(1, (total + page_size - 1) // page_size),
    )


@router.get("/subscriptions/payments/{payment_id}/invoice", include_in_schema=False)
@router.get("/subscriptions/payments/{payment_id}/receipt")
def download_admin_receipt(
    payment_id: str,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> Response:
    from app.api.routes.payments import download_receipt

    return download_receipt(payment_id, _, db)


@router.post("/subscriptions/payments/{payment_id}/refund", response_model=AdminPaymentRecordRead)
def refund_payment(
    payment_id: str,
    current_admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminPaymentRecordRead:
    payment = db.get(PaymentRecord, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found")
    if payment.status == "refunded":
        user = db.get(User, payment.user_id) if payment.user_id else None
        subscription = db.scalar(select(UserSubscription).where(UserSubscription.user_id == payment.user_id)) if payment.user_id else None
        return to_payment_read(payment, user, subscription)
    razorpay_payment_id = payment.razorpay_payment_id or payment.payment_id
    if payment.provider != "razorpay" or not razorpay_payment_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only Razorpay payments with a payment ID can be refunded.")
    try:
        refund = admin_razorpay_client().payment.refund(razorpay_payment_id, {"amount": int(payment.amount or payment.amount_cents or 0)})
    except (BadRequestError, GatewayError, ServerError) as exc:
        error_detail = admin_razorpay_error_detail(exc)
        error_status = status.HTTP_401_UNAUTHORIZED if "Razorpay API key" in error_detail or "authentication" in error_detail else status.HTTP_502_BAD_GATEWAY
        raise HTTPException(status_code=error_status, detail=error_detail) from exc
    payment.status = "refunded"
    payment.raw_metadata = {
        **(payment.raw_metadata or {}),
        "refund": refund,
        "refunded_by": current_admin.id,
        "refunded_at": datetime.utcnow().isoformat(),
    }
    log_quota_action(
        db,
        actor_user_id=current_admin.id,
        target_user_id=payment.user_id or "",
        action="payment.refund",
        metadata={"payment_id": payment.id, "razorpay_payment_id": razorpay_payment_id},
    )
    db.commit()
    db.refresh(payment)
    user = db.get(User, payment.user_id) if payment.user_id else None
    subscription = db.scalar(select(UserSubscription).where(UserSubscription.user_id == payment.user_id)) if payment.user_id else None
    return to_payment_read(payment, user, subscription)


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
    oldest = datetime.utcnow() - (timedelta(days=limit + 1) if date_format == "%Y-%m-%d" else timedelta(days=limit * 32))
    aggregate: dict[str, list[int]] = {}
    for created_at, total_tokens in db.execute(select(APIUsage.created_at, APIUsage.total_tokens).where(APIUsage.created_at >= oldest).order_by(APIUsage.created_at)):
        period = created_at.strftime(date_format)
        values = aggregate.setdefault(period, [0, 0])
        values[0] += 1
        values[1] += int(total_tokens or 0)
    return [
        AdminUsageTimeBucket(period=period, requests=values[0], total_tokens=values[1])
        for period, values in list(sorted(aggregate.items()))[-limit:]
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
    current_admin: User = Depends(get_current_admin),
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
    sync_plan_limit_subscriptions(db, limit, current_admin)
    db.commit()
    db.refresh(limit)
    return to_plan_limit_read(limit)


@router.post("/apk/version", response_model=ApkReleaseRead)
def upsert_apk_version(
    payload: ApkVersionUpsert,
    background_tasks: BackgroundTasks,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> ApkReleaseRead:
    data = payload.model_dump()
    release_id = data.pop("id", None)
    existing = db.get(ApkRelease, release_id) if release_id else db.scalar(
        select(ApkRelease).where(
            or_(ApkRelease.version_code == payload.version_code, ApkRelease.version_name == payload.version_name)
        )
    )
    should_notify = existing is None or (not existing.is_active and payload.is_active)
    release = apk_service.upsert_version(db, release_id=release_id, **data)
    if should_notify and firebase_notification_service.configured:
        background_tasks.add_task(
            dispatch_apk_update_notifications,
            release.version_code,
            release.version_name,
            release.changelog,
        )
    return apk_service.release_read(release)


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


@router.get("/system-status")
def deployment_system_status(_: User = Depends(get_current_admin), db: Session = Depends(get_db)) -> dict:
    db.execute(select(func.count(User.id)))
    records = model_registry.refresh()
    providers = {}
    for provider in ("groq", "bedrock", "openai", "gemini"):
        provider_records = [record for record in records if record.provider == provider]
        providers[provider] = {
            "configured": any(record.enabled for record in provider_records),
            "healthy_models": sum(record.enabled and record.health_status == "healthy" for record in provider_records),
            "known_models": len(provider_records),
        }
    return {
        "environment": settings.ENVIRONMENT,
        "canonical_frontend_url": settings.frontend_url,
        "canonical_backend_url": settings.backend_url,
        "https_configured": settings.frontend_url.startswith("https://") and settings.backend_url.startswith("https://"),
        "database": {"backend": settings.database_backend, "reachable": True, "persistent": settings.persistent_storage},
        "cache": {"backend": response_cache.backend, "ttl_seconds": settings.RESPONSE_CACHE_TTL_SECONDS if settings.RESPONSE_CACHE_ENABLED else 0},
        "fcm": {"configured": firebase_notification_service.configured},
        "payments": {"razorpay": bool(settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET and settings.RAZORPAY_WEBHOOK_SECRET), "stripe": bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_WEBHOOK_SECRET)},
        "providers": providers,
        "commit_sha": settings.RAILWAY_GIT_COMMIT_SHA,
        "deployment_id": settings.RAILWAY_DEPLOYMENT_ID,
    }
