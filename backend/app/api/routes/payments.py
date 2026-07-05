from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime

import razorpay
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from razorpay.errors import BadRequestError, GatewayError, ServerError
from sqlalchemy import or_, select
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


def razorpay_webhook_secret() -> str:
    if not settings.RAZORPAY_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay webhook secret is not configured.",
        )
    return settings.RAZORPAY_WEBHOOK_SECRET.get_secret_value()


def razorpay_client() -> razorpay.Client:
    return razorpay.Client(auth=(settings.RAZORPAY_KEY_ID, razorpay_secret()))


def request_plan(plan_id: str | None, plan: str | None) -> str:
    selected_plan = plan_id or plan
    if selected_plan not in PLAN_PRICES_PAISE or selected_plan == "free":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A paid plan_id is required.")
    return selected_plan


def payment_plan(payment: PaymentRecord) -> str:
    return payment.plan_id or payment.plan


def payment_amount(payment: PaymentRecord) -> int:
    return int(payment.amount or payment.amount_cents or 0)


def payment_order_id(payment: PaymentRecord) -> str | None:
    return payment.razorpay_order_id or payment.subscription_id


def find_razorpay_payment(db: Session, *, order_id: str | None = None, subscription_id: str | None = None) -> PaymentRecord | None:
    filters = []
    if order_id:
        filters.extend([PaymentRecord.razorpay_order_id == order_id, PaymentRecord.subscription_id == order_id])
    if subscription_id:
        filters.append(PaymentRecord.subscription_id == subscription_id)
    if not filters:
        return None
    return db.scalar(
        select(PaymentRecord)
        .where(PaymentRecord.provider == "razorpay", or_(*filters))
        .order_by(PaymentRecord.created_at.desc())
    )


def apply_paid_razorpay_payment(
    db: Session,
    payment: PaymentRecord,
    *,
    razorpay_payment_id: str,
    razorpay_signature: str | None = None,
    status_value: str = "paid",
) -> None:
    razorpay_payment_id = razorpay_payment_id.strip()
    if not payment.user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment is not linked to an Auto-AI user.")
    plan = payment_plan(payment)
    if plan not in PLAN_PRICES_PAISE or plan == "free":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment is not linked to a paid plan.")
    user = db.get(User, payment.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment user no longer exists.")

    now = datetime.utcnow()
    already_paid = payment.status in {"paid", "verified", "captured", "succeeded"} and payment.paid_at is not None
    amount = payment_amount(payment)
    payment.plan = plan
    payment.plan_id = plan
    payment.amount = amount
    payment.amount_cents = amount
    if razorpay_payment_id:
        payment.payment_id = razorpay_payment_id
        payment.razorpay_payment_id = razorpay_payment_id
    if razorpay_signature:
        payment.razorpay_signature = razorpay_signature
    if not payment.paid_at:
        payment.paid_at = now
    payment.status = status_value
    payment.updated_at = now

    subscription = ensure_user_subscription(db, user)
    if not already_paid:
        activate_subscription_plan(subscription, plan, payment_status="active")
        subscription.plan_id = plan
        subscription.status = "active"
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.started_at = now
    if razorpay_payment_id:
        subscription.razorpay_payment_id = razorpay_payment_id
    subscription.updated_at = now


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
        date=payment.paid_at or payment.created_at,
        amount_paise=payment_amount(payment),
        currency=payment.currency,
        plan=payment_plan(payment),
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
            f"Date: {(payment.paid_at or payment.created_at).isoformat()}",
            f"Email: {payment.user_email or current_user.email}",
            f"Plan: {payment_plan(payment)}",
            f"Amount: {payment_amount(payment) / 100:.2f} {payment.currency}",
            f"Status: {payment.status}",
            f"Payment ID: {payment.razorpay_payment_id or payment.payment_id or 'N/A'}",
            f"Order ID: {payment_order_id(payment) or 'N/A'}",
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
            or_(PaymentRecord.plan_id.in_(["pro", "premium", "ultra"]), PaymentRecord.plan.in_(["pro", "premium", "ultra"])),
        )
        .order_by(PaymentRecord.created_at.desc())
    )
    if not payment:
        return RestorePurchaseResponse(restored=False, message="No paid purchase found.")
    subscription = ensure_user_subscription(db, current_user)
    activate_subscription_plan(subscription, payment_plan(payment), payment_status="restored")
    subscription.razorpay_payment_id = payment.razorpay_payment_id or payment.payment_id
    db.commit()
    return RestorePurchaseResponse(restored=True, message="Purchase restored.")


@router.post("/create-order", response_model=CreateOrderResponse)
@router.post("/payments/create-order", response_model=CreateOrderResponse)
def create_order(
    payload: CreateOrderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CreateOrderResponse:
    selected_plan = request_plan(payload.plan_id, payload.plan)
    if payload.amount < 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Amount must be at least 100 paise.")
    validate_plan_amount(selected_plan, payload.amount, payload.promo_code)

    receipt = payload.receipt or f"auto-ai-{current_user.id[:8]}-{int(datetime.utcnow().timestamp())}"
    order_payload = {
        "amount": payload.amount,
        "currency": payload.currency,
        "receipt": receipt[:40],
        "notes": {
            "user_id": current_user.id,
            "user_email": current_user.email,
            "plan_id": selected_plan,
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
            user_email=current_user.email,
            provider="razorpay",
            subscription_id=str(order["id"]),
            razorpay_order_id=str(order["id"]),
            plan=selected_plan,
            plan_id=selected_plan,
            amount=int(order["amount"]),
            amount_cents=int(order["amount"]),
            currency=str(order["currency"]),
            status="created",
            raw_metadata={
                "receipt": receipt[:40],
                "promo_code": payload.promo_code,
                "user_id": current_user.id,
                "user_email": current_user.email,
                "plan_id": selected_plan,
            },
        )
    )
    db.commit()
    return CreateOrderResponse(
        order_id=str(order["id"]),
        amount=int(order["amount"]),
        currency=str(order["currency"]),
        plan_id=selected_plan,
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

    order_record = find_razorpay_payment(db, order_id=payload.razorpay_order_id)
    if not order_record:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay order was not created by this account.")
    if order_record.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay order was not created by this account.")
    if payload.amount is not None and payload.amount != payment_amount(order_record):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment amount does not match the created order.")
    requested_plan = payload.plan_id or payload.plan
    stored_plan = payment_plan(order_record)
    if requested_plan and requested_plan != stored_plan:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment plan does not match the created order.")

    body = f"{payload.razorpay_order_id}|{payload.razorpay_payment_id}".encode("utf-8")
    generated_signature = hmac.new(razorpay_secret().encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(generated_signature, payload.razorpay_signature):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay signature mismatch.")

    order_record.raw_metadata = {
        **(order_record.raw_metadata or {}),
        "razorpay_order_id": payload.razorpay_order_id,
        "razorpay_payment_id": payload.razorpay_payment_id,
        "verified_by_user_id": current_user.id,
        "verified_at": datetime.utcnow().isoformat(),
    }
    apply_paid_razorpay_payment(
        db,
        order_record,
        razorpay_payment_id=payload.razorpay_payment_id,
        razorpay_signature=payload.razorpay_signature,
        status_value="paid",
    )
    db.commit()
    return VerifyPaymentResponse(success=True, message=PAYMENT_SCREENSHOT_MESSAGE)


@router.post("/billing/razorpay/webhook")
async def razorpay_webhook(request: Request, db: Session = Depends(get_db)) -> dict[str, bool]:
    body = await request.body()
    received_signature = request.headers.get("X-Razorpay-Signature", "")
    generated_signature = hmac.new(razorpay_webhook_secret().encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not received_signature or not hmac.compare_digest(generated_signature, received_signature):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay webhook signature mismatch.")

    try:
        event = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Razorpay webhook payload.") from exc

    payload = event.get("payload") if isinstance(event, dict) else {}
    payload = payload if isinstance(payload, dict) else {}
    payment_entity = ((payload.get("payment") or {}).get("entity") or {}) if isinstance(payload.get("payment"), dict) else {}
    order_entity = ((payload.get("order") or {}).get("entity") or {}) if isinstance(payload.get("order"), dict) else {}
    subscription_entity = (
        ((payload.get("subscription") or {}).get("entity") or {}) if isinstance(payload.get("subscription"), dict) else {}
    )
    order_id = payment_entity.get("order_id") or order_entity.get("id")
    subscription_id = payment_entity.get("subscription_id") or subscription_entity.get("id")
    razorpay_payment_id = payment_entity.get("id")
    event_name = str(event.get("event") or "")
    payment_status = str(payment_entity.get("status") or "")

    payment = find_razorpay_payment(db, order_id=order_id, subscription_id=subscription_id)
    if not payment:
        return {"success": True, "matched": False}

    now = datetime.utcnow()
    payment.raw_metadata = {
        **(payment.raw_metadata or {}),
        "last_webhook_event": event_name,
        "last_webhook_at": now.isoformat(),
        "razorpay_webhook_order_id": order_id,
        "razorpay_webhook_subscription_id": subscription_id,
    }
    if event_name in {"payment.captured", "order.paid"} or payment_status == "captured":
        apply_paid_razorpay_payment(
            db,
            payment,
            razorpay_payment_id=str(razorpay_payment_id or payment.razorpay_payment_id or payment.payment_id or ""),
            status_value="paid",
        )
    elif event_name == "payment.failed" or payment_status == "failed":
        payment.status = "failed"
        payment.updated_at = now
    else:
        payment.updated_at = now
    db.commit()
    return {"success": True, "matched": True}
