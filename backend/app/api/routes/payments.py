from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import razorpay
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse, Response
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
    CreatePaymentSessionRequest,
    PaymentHistoryRead,
    PaymentConfigRead,
    PaymentLinkConfig,
    PaymentSessionResponse,
    PromoCodeRequest,
    PromoCodeResponse,
    RestorePurchaseResponse,
    VerifyPaymentRequest,
    VerifyPaymentResponse,
)
from app.utils.pdf import build_text_pdf
from app.services.admin_control import (
    PLAN_CATALOG,
    PLAN_PRICES_PAISE,
    activate_subscription_plan,
    active_subscription,
    billing_plan,
    plan_daily_message_limit,
    plan_monthly_token_limit,
    plan_price_paise,
    ensure_user_subscription,
    paid_plan_amount,
    plan_upload_limit_mb,
    promo_discount_percent,
    quota_plan_defaults,
    recalculate_token_balance,
    refresh_quota_periods,
)


router = APIRouter(tags=["payments"])
logger = logging.getLogger("auto_ai.payments")

PAYMENT_METHODS = [
    "UPI QR",
    "UPI",
    "Google Pay",
    "PhonePe",
    "Paytm",
    "Wallet",
    "Debit Card",
    "Credit Card",
    "Net Banking",
]

PAYMENT_SCREENSHOT_MESSAGE = "After payment, send your registered email and payment screenshot to admin."
RAZORPAY_SECRET_PATTERN = re.compile(
    r"(?i)(key_secret|secret|token|signature|password)([\"']?\s*[:=]\s*[\"']?)[^,\"'\s}]+"
)
RAZORPAY_KEY_PATTERN = re.compile(r"rzp_(test|live)_([A-Za-z0-9]{6})[A-Za-z0-9]+")


def razorpay_key_id() -> str:
    return (settings.RAZORPAY_KEY_ID or "").strip()


def razorpay_key_mode(key_id: str | None = None) -> str | None:
    value = (key_id or razorpay_key_id()).strip().lower()
    if value.startswith("rzp_test_"):
        return "test"
    if value.startswith("rzp_live_"):
        return "live"
    return None


def razorpay_secret_value() -> str:
    return settings.RAZORPAY_KEY_SECRET.get_secret_value().strip() if settings.RAZORPAY_KEY_SECRET else ""


def razorpay_secret() -> str:
    secret = razorpay_secret_value()
    if not razorpay_key_id() or not secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay credentials are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
        )
    return secret


def razorpay_webhook_secret() -> str:
    if not settings.RAZORPAY_WEBHOOK_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay webhook secret is not configured.",
        )
    return settings.RAZORPAY_WEBHOOK_SECRET.get_secret_value()


def razorpay_client() -> razorpay.Client:
    key_id = razorpay_key_id()
    if not razorpay_key_mode(key_id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Razorpay key_id is invalid. Use a valid TEST or LIVE key from the same Razorpay account.",
        )
    return razorpay.Client(auth=(key_id, razorpay_secret()))


def verify_razorpay_signature(order_id: str, payment_id: str, signature: str) -> None:
    body = f"{order_id}|{payment_id}".encode("utf-8")
    generated_signature = hmac.new(razorpay_secret().encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(generated_signature, signature):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay signature mismatch.")


def payment_status_url(base_url: str, params: dict[str, str]) -> str:
    clean_params = {key: value for key, value in params.items() if value}
    if not clean_params:
        return base_url
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}{urlencode(clean_params)}"


def checkout_url_for_session(session_id: str) -> str:
    return f"{settings.frontend_url}/payment/checkout?{urlencode({'session_id': session_id})}"


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


def payment_session_read(payment: PaymentRecord) -> PaymentSessionResponse:
    order_id = payment_order_id(payment)
    if not order_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment session has no Razorpay order.")
    key_id = razorpay_key_id()
    if not key_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Razorpay public key is missing.")
    metadata = payment.raw_metadata or {}
    return PaymentSessionResponse(
        session_id=payment.id,
        checkout_url=checkout_url_for_session(payment.id),
        razorpay_order_id=order_id,
        amount=payment_amount(payment),
        currency=payment.currency,
        key_id=key_id,
        plan_id=payment_plan(payment),
        status=payment.status,
        user_email=payment.user_email,
        user_name=str(metadata.get("user_name") or ""),
    )


def create_razorpay_payment_record(
    db: Session,
    current_user: User,
    *,
    selected_plan: str,
    amount: int,
    currency: str,
    receipt: str | None = None,
    promo_code: str | None = None,
    checkout_config_id: str | None = None,
) -> PaymentRecord:
    if amount < 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Amount must be at least 100 paise.")
    validate_plan_amount(db, selected_plan, amount, promo_code)

    receipt_value = receipt or f"auto-ai-{current_user.id[:8]}-{int(datetime.utcnow().timestamp())}"
    order_payload = {
        "amount": amount,
        "currency": currency,
        "receipt": receipt_value[:40],
        "notes": {
            "user_id": current_user.id,
            "user_email": current_user.email,
            "plan_id": selected_plan,
        },
    }
    resolved_checkout_config_id = checkout_config_id or settings.razorpay_checkout_config_id
    if resolved_checkout_config_id:
        order_payload["checkout_config_id"] = resolved_checkout_config_id
    log_razorpay_order_request(order_payload, selected_plan, receipt_value[:40])
    try:
        order = razorpay_client().order.create(order_payload)
    except HTTPException:
        raise
    except (BadRequestError, GatewayError, ServerError) as exc:
        log_razorpay_order_failure(exc, order_payload, selected_plan, receipt_value[:40])
        raise HTTPException(status_code=razorpay_error_status(exc), detail=razorpay_error_detail(exc)) from exc
    except Exception as exc:
        log_razorpay_order_failure(exc, order_payload, selected_plan, receipt_value[:40])
        raise HTTPException(status_code=razorpay_error_status(exc), detail=razorpay_error_detail(exc)) from exc

    payment = PaymentRecord(
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
            "receipt": receipt_value[:40],
            "promo_code": promo_code,
            "user_id": current_user.id,
            "user_email": current_user.email,
            "user_name": current_user.name,
            "plan_id": selected_plan,
        },
    )
    db.add(payment)
    db.flush()
    return payment


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
        activate_subscription_plan(db, subscription, plan, payment_status="active")
        subscription.plan_id = plan
        subscription.status = "active"
        subscription.tokens_added = subscription.token_limit_monthly
        subscription.started_at = now
        recalculate_token_balance(subscription)
    if razorpay_payment_id:
        subscription.razorpay_payment_id = razorpay_payment_id
    subscription.updated_at = now
    user.subscription_status = subscription.status
    user.updated_at = now


def expected_plan_amount(db: Session, plan: str | None, promo_code: str | None = None) -> int | None:
    if not plan:
        return None
    discount = promo_discount_percent(promo_code)
    if promo_code and discount <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid promo code.")
    return paid_plan_amount(plan, discount, db)


def validate_plan_amount(db: Session, plan: str | None, amount: int, promo_code: str | None = None) -> None:
    expected_amount = expected_plan_amount(db, plan, promo_code)
    if expected_amount is None:
        return
    if amount != expected_amount:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Amount does not match the selected {plan} plan.",
        )


def razorpay_error_status(error: Exception) -> int:
    message = safe_razorpay_error_message(error).lower()
    if "auth" in message or "unauthorized" in message or "invalid api key" in message or "api key" in message:
        return status.HTTP_401_UNAUTHORIZED
    if isinstance(error, BadRequestError):
        return status.HTTP_400_BAD_REQUEST
    return status.HTTP_502_BAD_GATEWAY


def sanitize_razorpay_log_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "[redacted]" if re.search(r"(?i)(secret|token|signature|password)", str(key)) else sanitize_razorpay_log_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_razorpay_log_value(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_razorpay_log_value(item) for item in value]
    if isinstance(value, str):
        sanitized = RAZORPAY_SECRET_PATTERN.sub(r"\1\2[redacted]", value)
        return RAZORPAY_KEY_PATTERN.sub(r"rzp_\1_\2...", sanitized)
    return value


def razorpay_exception_body(error: Exception) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": type(error).__name__,
        "message": safe_razorpay_error_message(error),
    }
    for attr in ("status_code", "http_status_code", "error_code", "field"):
        value = getattr(error, attr, None)
        if value is not None:
            body[attr] = value
    response = getattr(error, "response", None)
    if response is not None:
        body["response_status"] = getattr(response, "status_code", None)
        try:
            body["response_body"] = response.json()
        except Exception:
            body["response_body"] = getattr(response, "text", None)
    if error.args:
        body["args"] = list(error.args)
    return sanitize_razorpay_log_value(body)


def safe_razorpay_error_message(error: Exception) -> str:
    message = str(error).strip()
    if not message:
        return ""
    message = RAZORPAY_SECRET_PATTERN.sub(r"\1\2[redacted]", message)
    message = RAZORPAY_KEY_PATTERN.sub(r"rzp_\1_\2...", message)
    return message[:300]


def razorpay_error_detail(error: Exception) -> str:
    safe_message = safe_razorpay_error_message(error)
    message = safe_message.lower()
    if "expired" in message and "api key" in message:
        return "Razorpay API key has expired. Update RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
    if "auth" in message or "unauthorized" in message or "invalid api key" in message or "api key" in message:
        return "Razorpay authentication failed. Check that key_id and key_secret are from the same TEST or LIVE account."
    if "id provided does not exist" in message:
        return "Razorpay rejected the order setup. Check Razorpay mode and remove deleted dashboard IDs."
    return "Razorpay order creation failed. Please try again or contact support."


def log_razorpay_order_request(order_payload: dict[str, Any], plan_id: str, receipt: str) -> None:
    logger.info(
        "razorpay_order_create_request %s",
        sanitize_razorpay_log_value(
            {
                "mode": razorpay_key_mode(),
                "order_request": order_payload,
                "plan_id": plan_id,
                "customer_id": None,
                "subscription_id": None,
                "receipt": receipt,
                "amount": order_payload.get("amount"),
                "currency": order_payload.get("currency"),
            }
        ),
    )


def log_razorpay_order_failure(error: Exception, order_payload: dict[str, Any], plan_id: str, receipt: str) -> None:
    logger.warning(
        "razorpay_order_create_failed %s",
        sanitize_razorpay_log_value(
            {
                "status": razorpay_error_status(error),
                "mode": razorpay_key_mode(),
                "order_request": order_payload,
                "plan_id": plan_id,
                "customer_id": None,
                "subscription_id": None,
                "receipt": receipt,
                "amount": order_payload.get("amount"),
                "currency": order_payload.get("currency"),
                "razorpay_response": razorpay_exception_body(error),
            }
        ),
    )


@router.get("/payments/config", response_model=PaymentConfigRead)
def payment_config() -> PaymentConfigRead:
    upi_id = settings.payment_upi_id.strip() if settings.payment_upi_id else None
    upi_payee_name = settings.UPI_PAYEE_NAME.strip() if settings.UPI_PAYEE_NAME else "Auto-AI"
    key_id = razorpay_key_id() or None
    return PaymentConfigRead(
        key_id=key_id,
        razorpay_ready=bool(key_id and razorpay_secret_value()),
        razorpay_mode=razorpay_key_mode(key_id),
        razorpay_config_id=settings.razorpay_checkout_config_id,
        frontend_url=settings.frontend_url,
        backend_url=settings.backend_url,
        upi_id=upi_id,
        upi_payee_name=upi_payee_name,
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


def plan_read_for_db(db: Session, plan_id: str) -> BillingPlanRead:
    item = PLAN_CATALOG[plan_id]
    return BillingPlanRead(
        id=plan_id,
        label=str(item["label"]),
        price_paise=plan_price_paise(db, plan_id),
        features=list(item["features"]),
        token_quota=plan_monthly_token_limit(db, plan_id),
        model_access=list(item["model_access"]),
        upload_limit_mb=int(item["upload_limit_mb"]),
        priority_speed=str(item["priority_speed"]),
        daily_message_limit=plan_daily_message_limit(db, plan_id),
    )


@router.get("/payments/plans", response_model=list[BillingPlanRead])
def payment_plans(db: Session = Depends(get_db)) -> list[BillingPlanRead]:
    return [plan_read_for_db(db, plan_id) for plan_id in ("free", "pro", "premium", "ultra")]


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
    subscription_active = active_subscription(subscription)
    effective_plan = subscription.plan if subscription_active else "free"
    catalog = billing_plan(effective_plan)
    token_limit_monthly = plan_monthly_token_limit(db, effective_plan)
    daily_message_limit = plan_daily_message_limit(db, effective_plan)
    if subscription.token_limit_monthly != token_limit_monthly:
        subscription.token_limit_monthly = token_limit_monthly
        subscription.tokens_added = token_limit_monthly
    if subscription.daily_message_limit != daily_message_limit:
        subscription.daily_message_limit = daily_message_limit
    recalculate_token_balance(subscription)
    token_balance = subscription.token_balance
    if token_limit_monthly > 0:
        token_balance = max(0, token_limit_monthly + subscription.bonus_tokens - subscription.tokens_used_monthly)
    renewal_at = subscription.expires_at if subscription.auto_renewal and subscription_active and not subscription.is_lifetime else None
    return BillingCurrentPlanRead(
        plan=effective_plan,
        plan_name=subscription.plan_name if subscription_active else str(quota_plan_defaults("free")["plan_name"]),
        status="lifetime" if subscription.is_lifetime else "active" if subscription_active else "suspended" if subscription.suspended_at else "inactive",
        expires_at=None if subscription.is_lifetime else subscription.expires_at,
        renewal_at=renewal_at,
        token_limit_monthly=token_limit_monthly,
        tokens_used_monthly=subscription.tokens_used_monthly,
        token_balance=token_balance,
        daily_message_limit=daily_message_limit,
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
        plans=[plan_read_for_db(db, plan_id) for plan_id in ("free", "pro", "premium", "ultra")],
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
    invoice = build_text_pdf(
        "Auto-AI Invoice",
        [
            f"Invoice ID: {payment.id}",
            f"Date: {(payment.paid_at or payment.created_at).isoformat()}",
            f"Email: {payment.user_email or current_user.email}",
            f"Plan: {payment_plan(payment)}",
            f"Amount: {payment_amount(payment) / 100:.2f} {payment.currency}",
            f"Status: {payment.status}",
            f"Payment ID: {payment.razorpay_payment_id or payment.payment_id or 'N/A'}",
            f"Order ID: {payment_order_id(payment) or 'N/A'}",
        ],
    )
    return Response(
        content=invoice,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="auto-ai-invoice-{payment.id}.pdf"'},
    )


@router.post("/payments/promo-code", response_model=PromoCodeResponse)
def apply_promo_code(payload: PromoCodeRequest, db: Session = Depends(get_db)) -> PromoCodeResponse:
    discount = promo_discount_percent(payload.code)
    if discount <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid promo code.")
    return PromoCodeResponse(
        code=payload.code,
        discount_percent=discount,
        plan=payload.plan,
        original_amount_paise=plan_price_paise(db, payload.plan),
        discounted_amount_paise=paid_plan_amount(payload.plan, discount, db),
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
    activate_subscription_plan(db, subscription, payment_plan(payment), payment_status="restored")
    subscription.razorpay_payment_id = payment.razorpay_payment_id or payment.payment_id
    current_user.subscription_status = subscription.status
    current_user.updated_at = datetime.utcnow()
    db.commit()
    return RestorePurchaseResponse(restored=True, message="Purchase restored.")


@router.post("/payments/create-session", response_model=PaymentSessionResponse)
def create_payment_session(
    payload: CreatePaymentSessionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaymentSessionResponse:
    selected_plan = request_plan(payload.plan_id, None)
    amount = payload.amount if payload.amount is not None else expected_plan_amount(db, selected_plan, payload.promo_code)
    if amount is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to determine plan amount.")
    payment = create_razorpay_payment_record(
        db,
        current_user,
        selected_plan=selected_plan,
        amount=amount,
        currency=payload.currency,
        receipt=payload.receipt,
        promo_code=payload.promo_code,
    )
    db.commit()
    db.refresh(payment)
    return payment_session_read(payment)


@router.get("/payments/sessions/{session_id}", response_model=PaymentSessionResponse)
def payment_session(session_id: str, db: Session = Depends(get_db)) -> PaymentSessionResponse:
    payment = db.get(PaymentRecord, session_id)
    if not payment or payment.provider != "razorpay":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment session not found.")
    return payment_session_read(payment)


@router.post("/create-order", response_model=CreateOrderResponse)
@router.post("/payments/create-order", response_model=CreateOrderResponse)
def create_order(
    payload: CreateOrderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CreateOrderResponse:
    selected_plan = request_plan(payload.plan_id, payload.plan)
    payment = create_razorpay_payment_record(
        db,
        current_user,
        selected_plan=selected_plan,
        amount=payload.amount,
        currency=payload.currency,
        receipt=payload.receipt,
        promo_code=payload.promo_code,
        checkout_config_id=payload.checkout_config_id,
    )
    db.commit()
    return CreateOrderResponse(
        order_id=payment_order_id(payment) or "",
        amount=payment_amount(payment),
        currency=payment.currency,
        plan_id=selected_plan,
    )


@router.post("/verify-payment", response_model=VerifyPaymentResponse)
@router.post("/payments/verify-payment", response_model=VerifyPaymentResponse)
def verify_payment(
    payload: VerifyPaymentRequest,
    db: Session = Depends(get_db),
) -> VerifyPaymentResponse:
    if not payload.razorpay_payment_id or not payload.razorpay_order_id or not payload.razorpay_signature:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Razorpay payment fields.")

    order_record = find_razorpay_payment(db, order_id=payload.razorpay_order_id)
    if not order_record:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay order was not created by this account.")
    if payload.amount is not None and payload.amount != payment_amount(order_record):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment amount does not match the created order.")
    requested_plan = payload.plan_id or payload.plan
    stored_plan = payment_plan(order_record)
    if requested_plan and requested_plan != stored_plan:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Payment plan does not match the created order.")

    verify_razorpay_signature(payload.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature)

    order_record.raw_metadata = {
        **(order_record.raw_metadata or {}),
        "razorpay_order_id": payload.razorpay_order_id,
        "razorpay_payment_id": payload.razorpay_payment_id,
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


@router.post("/billing/razorpay/callback")
async def razorpay_checkout_callback(request: Request, db: Session = Depends(get_db)) -> RedirectResponse:
    try:
        form = await request.form()
        razorpay_payment_id = str(form.get("razorpay_payment_id") or "").strip()
        razorpay_order_id = str(form.get("razorpay_order_id") or "").strip()
        razorpay_signature = str(form.get("razorpay_signature") or "").strip()
        if not razorpay_payment_id or not razorpay_order_id or not razorpay_signature:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Razorpay payment fields.")

        payment = find_razorpay_payment(db, order_id=razorpay_order_id)
        if not payment:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Razorpay order was not created by Auto-AI.")
        verify_razorpay_signature(razorpay_order_id, razorpay_payment_id, razorpay_signature)
        payment.raw_metadata = {
            **(payment.raw_metadata or {}),
            "razorpay_order_id": razorpay_order_id,
            "razorpay_payment_id": razorpay_payment_id,
            "callback_verified_at": datetime.utcnow().isoformat(),
        }
        apply_paid_razorpay_payment(
            db,
            payment,
            razorpay_payment_id=razorpay_payment_id,
            razorpay_signature=razorpay_signature,
            status_value="paid",
        )
        db.commit()
        return RedirectResponse(
            payment_status_url(
                settings.razorpay_success_url,
                {"order_id": razorpay_order_id, "payment_id": razorpay_payment_id},
            ),
            status_code=status.HTTP_303_SEE_OTHER,
        )
    except Exception as exc:
        db.rollback()
        logger.warning("razorpay_callback_failed %s", safe_razorpay_error_message(exc))
        return RedirectResponse(
            payment_status_url(settings.razorpay_failure_url, {"reason": "verification_failed"}),
            status_code=status.HTTP_303_SEE_OTHER,
        )


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
