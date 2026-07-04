from __future__ import annotations

import hashlib
import hmac
from datetime import datetime

import razorpay
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from razorpay.errors import BadRequestError, GatewayError, ServerError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.admin_control import PaymentRecord
from app.models.user import User
from app.schemas.payments import (
    AutoRenewalUpdate,
    BillingCenterRead,
    BillingCurrentPlanRead,
    BillingPlanRead,
    CreateOrderRequest,
    CreateOrderResponse,
    PaymentHistoryRead,
    PaymentConfigRead,
    PaymentLinkConfig,
    PromoCodeRequest,
    PromoCodeResponse,
    RestorePurchaseResponse,
    VerifyPaymentRequest,
    VerifyPaymentResponse,
)
from app.services.admin_control import (
    PLAN_CATALOG,
    PLAN_PRICES_PAISE,
    activate_subscription_plan,
    active_subscription,
    billing_plan,
    ensure_user_subscription,
    paid_plan_amount,
    plan_upload_limit_mb,
    promo_discount_percent,
    quota_plan_defaults,
    recalculate_token_balance,
    refresh_quota_periods,
)


router = APIRouter(tags=["payments"])

PAYMENT_METHODS = [
    "UPI",
    "Google Pay",
    "PhonePe",
    "Paytm",
    "Debit Card",
    "Credit Card",
    "Net Banking",
]

PAYMENT_SCREENSHOT_MESSAGE = "After payment, send your registered email and payment screenshot to admin."


def razorpay_secret() -> str:
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay credentials are not configured.",
        )
    return settings.RAZORPAY_KEY_SECRET.get_secret_value()


def razorpay_client() -> razorpay.Client:
    return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, razorpay_secret()))


def expected_plan_amount(plan: str | None, promo_code: str | None = None) -> int | None:
    if not plan:
        return None
    discount = promo_discount_percent(promo_code)
    if promo_code and discount <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid promo code.")
    return paid_plan_amount(plan, discount)


def validate_plan_amount(plan: str | None, amount: int, promo_code: str | None = None) -> None:
    expected_amount = expected_plan_amount(plan, promo_code)
    if expected_amount is None:
        return
    if amount != expected_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Amount does not match the selected {plan} plan.",
        )


def razorpay_error_status(error: Exception) -> int:
    message = str(error).lower()
    if "auth" in message or "unauthorized" in message or "invalid api key" in message:
        return status.HTTP_401_UNAUTHORIZED
    return status.HTTP_500_INTERNAL_SERVER_ERROR


@router.get("/payments/config", response_model=PaymentConfigRead)
def payment_config() -> PaymentConfigRead:
    return PaymentConfigRead(
        key_id=settings.RAZORPAY_KEY_ID,
        payment_links=PaymentLinkConfig(
            pro=settings.RAZORPAY_PRO_LINK or None,
            premium=settings.RAZORPAY_PREMIUM_LINK or None,
            ultra=settings.RAZORPAY_ULTRA_LINK or None,
        ),
    )


def plan_read(plan_id: str) -> BillingPlanRead:
    item = PLAN_CATALOG[plan_id]
    return BillingPlanRead(
        id=plan_id,
        label=str(item["label"]),
        price_paise=int(item["price_paise"]),
        features=list(item["features"]),
        token_quota=int(item["token_quota"]),
        model_access=list(item["model_access"]),
        upload_limit_mb=int(item["upload_limit_mb"]),
        priority_speed=str(item["priority_speed"]),
        daily_message_limit=int(item["daily_message_limit"]),
    )


def payment_history_item(payment: PaymentRecord) -> PaymentHistoryRead:
    return PaymentHistoryRead(
        id=payment.id,
        date=payment.created_at,
        amount_paise=payment.amount_cents,
        currency=payment.currency,
        plan=payment.plan,
        status=payment.status,
        invoice_url=f"/api/v1/payments/invoices/{payment.id}",
    )


def current_plan_read(db: Session, user: User) -> BillingCurrentPlanRead:
    subscription = ensure_user_subscription(db, user)
    refresh_quota_periods(subscription)
    recalculate_token_balance(subscription)
    subscription_active = active_subscription(subscription)
    effective_plan = subscription.plan if subscription_active else "free"
    catalog = billing_plan(effective_plan)
    renewal_at = subscription.expires_at if subscription.auto_renewal and subscription_active and not subscription.is_lifetime else None
    return BillingCurrentPlanRead(
        plan=effective_plan,
        plan_name=subscription.plan_name if subscription_active else str(quota_plan_defaults("free")["plan_name"]),
        status="lifetime" if subscription.is_lifetime else "active" if subscription_active else "suspended" if subscription.suspended_at else "inactive",
        expires_at=None if subscription.is_lifetime else subscription.expires_at,
        renewal_at=renewal_at,
        token_limit_monthly=subscription.token_limit_monthly,
        tokens_used_monthly=subscription.tokens_used_monthly,
        token_balance=subscription.token_balance,
        daily_message_limit=subscription.daily_message_limit,
        messages_used_today=subscription.messages_used_today,
        upload_limit_mb=plan_upload_limit_mb(effective_plan),
        enabled_ai_models=list(catalog["model_access"]),
        auto_renewal=subscription.auto_renewal,
        is_lifetime=subscription.is_lifetime,
    )


@router.get("/payments/billing", response_model=BillingCenterRead)
def billing_center(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BillingCenterRead:
    payments = db.scalars(
        select(PaymentRecord)
        .where(PaymentRecord.user_id == current_user.id)
        .order_by(PaymentRecord.created_at.desc())
        .limit(20)
    ).all()
    result = BillingCenterRead(
        current_plan=current_plan_read(db, current_user),
        plans=[plan_read(plan_id) for plan_id in ("free", "pro", "premium", "ultra")],
        payment_history=[payment_history_item(payment) for payment in payments],
        payment_methods=PAYMENT_METHODS,
        support_email=str(settings.ADMIN_EMAIL) if settings.ADMIN_EMAIL else None,
    )
    db.commit()
    return result


@router.get("/payments/history", response_model=list[PaymentHistoryRead])
def payment_history(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PaymentHistoryRead]:
    payments = db.scalars(
        select(PaymentRecord)
        .where(PaymentRecord.user_id == current_user.id)
        .order_by(PaymentRecord.created_at.desc())
    ).all()
    return [payment_history_item(payment) for payment in payments]


@router.get("/payments/invoices/{payment_id}")
def download_invoice(
    payment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    payment = db.get(PaymentRecord, payment_id)
    if not payment or payment.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found.")
    invoice = "\n".join(
        [
            "Auto-AI Invoice",
            f"Invoice ID: {payment.id}",
            f"Date: {payment.created_at.isoformat()}",
            f"Email: {current_user.email}",
            f"Plan: {payment.plan}",
            f"Amount: {payment.amount_cents / 100:.2f} {payment.currency}",
            f"Status: {payment.status}",
            f"Payment ID: {payment.payment_id or 'N/A'}",
            f"Order ID: {payment.subscription_id or 'N/A'}",
        ]
    )
    return Response(
        content=invoice,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="auto-ai-invoice-{payment.id}.txt"'},
    )


@router.post("/payments/promo-code", response_model=PromoCodeResponse)
def apply_promo_code(payload: PromoCodeRequest) -> PromoCodeResponse:
    discount = promo_discount_percent(payload.code)
    if discount <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid promo code.")
    original = PLAN_PRICES_PAISE[payload.plan]
    return PromoCodeResponse(
        code=payload.code,
        discount_percent=discount,
        plan=payload.plan,
        original_amount_paise=original,
        discounted_amount_paise=paid_plan_amount(payload.plan, discount),
    )


@router.patch("/payments/auto-renewal", response_model=BillingCurrentPlanRead)
def update_auto_renewal(
    payload: AutoRenewalUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BillingCurrentPlanRead:
    subscription = ensure_user_subscription(db, current_user)
    subscription.auto_renewal = payload.auto_renewal
    subscription.updated_at = datetime.utcnow()
    db.commit()
    return current_plan_read(db, current_user)


@router.post("/payments/restore-purchase", response_model=RestorePurchaseResponse)
def restore_purchase(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RestorePurchaseResponse:
    payment = db.scalar(
        select(PaymentRecord)
        .where(
            PaymentRecord.user_id == current_user.id,
            PaymentRecord.provider == "razorpay",
            PaymentRecord.status.in_(["verified", "paid", "captured"]),
            PaymentRecord.plan.in_(["pro", "premium", "ultra"]),
        )
        .order_by(PaymentRecord.created_at.desc())
    )
    if not payment:
        return RestorePurchaseResponse(restored=False, message="No paid purchase found.")
    subscription = ensure_user_subscription(db, current_user)
    activate_subscription_plan(subscription, payment.plan, payment_status="restored")
    subscription.razorpay_payment_id = payment.payment_id
    db.commit()
    return RestorePurchaseResponse(restored=True, message="Purchase restored.")


@router.post("/create-order", response_model=CreateOrderResponse)
@router.post("/payments/create-order", response_model=CreateOrderResponse)
def create_order(
    payload: CreateOrderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CreateOrderResponse:
    if payload.amount < 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Amount must be at least 100 paise.")
    validate_plan_amount(payload.plan, payload.amount, payload.promo_code)

    receipt = payload.receipt or f"auto-ai-{current_user.id[:8]}-{int(datetime.utcnow().timestamp())}"
    order_payload = {
        "amount": payload.amount,
        "currency": payload.currency,
        "receipt": receipt[:40],
        "notes": {
            "user_id": current_user.id,
            "email": current_user.email,
            "plan": payload.plan or "",
        },
    }
    try:
        order = razorpay_client().order.create(order_payload)
    except (BadRequestError, GatewayError, ServerError) as exc:
        raise HTTPException(status_code=razorpay_error_status(exc), detail="Unable to create Razorpay order.") from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create Razorpay order.") from exc

    db.add(
        PaymentRecord(
            user_id=current_user.id,
            provider="razorpay",
            subscription_id=str(order["id"]),
            plan=payload.plan or "free",
            amount_cents=int(order["amount"]),
            currency=str(order["currency"]),
            status="created",
            raw_metadata={"receipt": receipt[:40], "promo_code": payload.promo_code},
        )
    )
    db.commit()
    return CreateOrderResponse(
        order_id=str(order["id"]),
        amount=int(order["amount"]),
        currency=str(order["currency"]),
    )


@router.post("/verify-payment", response_model=VerifyPaymentResponse)
@router.post("/payments/verify-payment", response_model=VerifyPaymentResponse)
def verify_payment(
    payload: VerifyPaymentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VerifyPaymentResponse:
    if not payload.razorpay_payment_id or not payload.razorpay_order_id or not payload.razorpay_signature:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Razorpay payment fields.")

    order_record = db.scalar(
        select(PaymentRecord).where(
            PaymentRecord.user_id == current_user.id,
            PaymentRecord.provider == "razorpay",
            PaymentRecord.subscription_id == payload.razorpay_order_id,
        )
    )
    if not order_record:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay order was not created by this account.")
    if payload.amount is not None and payload.amount != order_record.amount_cents:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment amount does not match the created order.")
    if payload.plan:
        validate_plan_amount(payload.plan, order_record.amount_cents, (order_record.raw_metadata or {}).get("promo_code"))

    body = f"{order_record.subscription_id}|{payload.razorpay_payment_id}".encode("utf-8")
    generated_signature = hmac.new(razorpay_secret().encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(generated_signature, payload.razorpay_signature):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay signature mismatch.")

    order_record.payment_id = payload.razorpay_payment_id
    order_record.plan = payload.plan or order_record.plan
    order_record.amount_cents = payload.amount or order_record.amount_cents
    order_record.currency = payload.currency
    order_record.status = "verified"
    order_record.raw_metadata = {
        **(order_record.raw_metadata or {}),
        "razorpay_order_id": payload.razorpay_order_id,
        "razorpay_payment_id": payload.razorpay_payment_id,
    }
    if payload.plan:
        subscription = ensure_user_subscription(db, current_user)
        activate_subscription_plan(subscription, payload.plan, payment_status="paid")
        subscription.razorpay_payment_id = payload.razorpay_payment_id
    db.commit()
    return VerifyPaymentResponse(success=True, message=PAYMENT_SCREENSHOT_MESSAGE)
