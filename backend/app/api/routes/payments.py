from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import razorpay
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse, Response
from razorpay.errors import BadRequestError, GatewayError, ServerError
from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.admin_control import PaymentRecord, PaymentWebhookEvent
from app.models.admin_control import AuditLog
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
    PaymentHistoryPage,
    PaymentConfigRead,
    PaymentLinkConfig,
    PaymentSessionResponse,
    PromoCodeRequest,
    PromoCodeResponse,
    RestorePurchaseResponse,
    StripeCheckoutResponse,
    VerifyPaymentRequest,
    VerifyPaymentResponse,
)
from app.utils.pdf import build_text_pdf
from app.services.promo_service import (
    SUCCESS_PAYMENT_STATUSES,
    finalize_promo_redemption,
    quote_promo,
    reserve_promo,
)
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
    plan_upload_limit_mb,
    quota_plan_defaults,
    recalculate_token_balance,
    refresh_quota_periods,
)


router = APIRouter(tags=["payments"])
logger = logging.getLogger("auto_ai.payments")

PAYMENT_SCREENSHOT_MESSAGE = "Payment verified successfully."
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
    original_amount = plan_price_paise(db, selected_plan)
    quote = quote_promo(db, current_user, promo_code, selected_plan, currency, lock=True) if promo_code else None
    authoritative_amount = quote.final_amount_paise if quote else original_amount
    if authoritative_amount < 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Amount must be at least 100 paise.")

    receipt_value = receipt or f"auto-ai-{current_user.id[:8]}-{int(datetime.utcnow().timestamp())}"
    order_payload = {
        "amount": authoritative_amount,
        "currency": currency,
        "receipt": receipt_value[:40],
        "notes": {
            "user_id": current_user.id,
            "user_email": current_user.email,
            "plan_id": selected_plan,
            "promo_code": quote.code if quote else "",
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
        original_amount_paise=original_amount,
        discount_amount_paise=quote.discount_amount_paise if quote else 0,
        promo_code_id=quote.promo_id if quote else None,
        promo_code_snapshot=quote.code if quote else None,
        plan_name_snapshot=str(PLAN_CATALOG[selected_plan]["label"]),
        billing_period_snapshot="Monthly",
        raw_metadata={
            "receipt": receipt_value[:40],
            "promo_code": quote.code if quote else None,
            "original_amount_paise": original_amount,
            "discount_amount_paise": quote.discount_amount_paise if quote else 0,
            "user_id": current_user.id,
            "user_email": current_user.email,
            "user_name": current_user.name,
            "plan_id": selected_plan,
        },
    )
    db.add(payment)
    db.flush()
    if quote:
        reserve_promo(db, payment, current_user, quote.code)
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
    if not payment.verified_at:
        payment.verified_at = now
    if not payment.receipt_number:
        payment.receipt_number = f"AA-{now:%Y%m%d}-{payment.id.replace('-', '')[:12].upper()}"
    if payment.original_amount_paise is None:
        payment.original_amount_paise = amount
    if payment.discount_amount_paise is None:
        payment.discount_amount_paise = 0
    if not payment.plan_name_snapshot:
        payment.plan_name_snapshot = str(PLAN_CATALOG.get(plan, {}).get("label") or plan.title())
    if not payment.billing_period_snapshot:
        payment.billing_period_snapshot = "Monthly"
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
    finalize_promo_redemption(db, payment, succeeded=True)


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
        stripe_ready=bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_WEBHOOK_SECRET),
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


def stripe_secret_value() -> str:
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Stripe is not configured.")
    return settings.STRIPE_SECRET_KEY.get_secret_value().strip()


def stripe_price_id(plan: str) -> str | None:
    return {"pro": settings.STRIPE_PRICE_PRO, "premium": settings.STRIPE_PRICE_PREMIUM, "ultra": settings.STRIPE_PRICE_ULTRA}.get(plan)


def verify_stripe_webhook(payload: bytes, signature_header: str) -> None:
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Stripe webhook is not configured.")
    parts: dict[str, list[str]] = {}
    for item in signature_header.split(","):
        name, separator, value = item.strip().partition("=")
        if separator:
            parts.setdefault(name, []).append(value)
    try:
        timestamp = int(parts.get("t", [""])[0])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid Stripe signature timestamp.") from exc
    if abs(int(time.time()) - timestamp) > 300:
        raise HTTPException(status_code=400, detail="Expired Stripe webhook signature.")
    signed = str(timestamp).encode("ascii") + b"." + payload
    expected = hmac.new(settings.STRIPE_WEBHOOK_SECRET.get_secret_value().encode("utf-8"), signed, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, candidate) for candidate in parts.get("v1", [])):
        raise HTTPException(status_code=400, detail="Stripe signature mismatch.")


def apply_paid_stripe_payment(db: Session, payment: PaymentRecord, stripe_session: dict[str, Any]) -> None:
    if not payment.user_id:
        raise HTTPException(status_code=400, detail="Stripe payment is not linked to a user.")
    user = db.get(User, payment.user_id)
    if not user:
        raise HTTPException(status_code=400, detail="Stripe payment user no longer exists.")
    expected_amount = payment_amount(payment)
    paid_amount = int(stripe_session.get("amount_total") or 0)
    paid_currency = str(stripe_session.get("currency") or "").upper()
    if paid_amount != expected_amount or paid_currency != payment.currency.upper():
        raise HTTPException(status_code=400, detail="Stripe payment amount or currency mismatch.")
    now = datetime.utcnow()
    already_paid = payment.status in SUCCESS_PAYMENT_STATUSES and payment.verified_at is not None
    payment.status = "paid"
    payment.payment_id = str(stripe_session.get("payment_intent") or stripe_session.get("id") or "")
    payment.customer_id = str(stripe_session.get("customer") or "") or None
    payment.paid_at = payment.paid_at or now
    payment.verified_at = payment.verified_at or now
    payment.receipt_number = payment.receipt_number or f"AA-{now:%Y%m%d}-{payment.id.replace('-', '')[:12].upper()}"
    payment.updated_at = now
    subscription = ensure_user_subscription(db, user)
    if not already_paid:
        activate_subscription_plan(db, subscription, payment_plan(payment), payment_status="active")
        subscription.started_at = now
        recalculate_token_balance(subscription)
    subscription.stripe_customer_id = payment.customer_id
    subscription.stripe_payment_id = payment.payment_id
    subscription.updated_at = now
    user.subscription_status = "active"
    user.updated_at = now
    finalize_promo_redemption(db, payment, succeeded=True)


@router.post("/payments/stripe/create-session", response_model=StripeCheckoutResponse)
def create_stripe_checkout_session(
    payload: CreatePaymentSessionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StripeCheckoutResponse:
    secret = stripe_secret_value()
    selected_plan = request_plan(payload.plan_id, None)
    original_amount = plan_price_paise(db, selected_plan)
    quote = quote_promo(db, current_user, payload.promo_code, selected_plan, payload.currency, lock=True) if payload.promo_code else None
    amount = quote.final_amount_paise if quote else original_amount
    payment = PaymentRecord(user_id=current_user.id, user_email=current_user.email, provider="stripe", plan=selected_plan, plan_id=selected_plan, amount=amount, amount_cents=amount, currency=payload.currency, status="pending", original_amount_paise=original_amount, discount_amount_paise=quote.discount_amount_paise if quote else 0, promo_code_id=quote.promo_id if quote else None, promo_code_snapshot=quote.code if quote else None, plan_name_snapshot=str(PLAN_CATALOG[selected_plan]["label"]), billing_period_snapshot="Monthly", raw_metadata={"user_id": current_user.id, "plan_id": selected_plan})
    db.add(payment)
    db.flush()
    form: list[tuple[str, str]] = [
        ("mode", "payment"),
        ("success_url", f"{settings.frontend_url}/payment/success?stripe_session_id={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{settings.frontend_url}/settings?section=subscription&payment=cancelled"),
        ("client_reference_id", payment.id),
        ("customer_email", current_user.email),
        ("metadata[user_id]", current_user.id),
        ("metadata[payment_record_id]", payment.id),
        ("metadata[plan_id]", selected_plan),
        ("line_items[0][quantity]", "1"),
    ]
    configured_price = stripe_price_id(selected_plan) if not quote else None
    if configured_price:
        form.append(("line_items[0][price]", configured_price))
    else:
        form.extend([
            ("line_items[0][price_data][currency]", payload.currency.lower()),
            ("line_items[0][price_data][unit_amount]", str(amount)),
            ("line_items[0][price_data][product_data][name]", f"AutoAI {PLAN_CATALOG[selected_plan]['label']} plan"),
        ])
    try:
        response = httpx.post("https://api.stripe.com/v1/checkout/sessions", auth=(secret, ""), data=form, timeout=20)
        if response.status_code >= 400:
            logger.warning("stripe_session_create_failed status=%s", response.status_code)
            raise HTTPException(status_code=502, detail="Stripe could not create a checkout session.")
        session = response.json()
        payment.subscription_id = str(session["id"])
        payment.raw_metadata = {**(payment.raw_metadata or {}), "stripe_session_id": payment.subscription_id}
        if quote:
            reserve_promo(db, payment, current_user, quote.code)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.warning("stripe_session_create_failed error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Stripe checkout is temporarily unavailable.") from exc
    return StripeCheckoutResponse(session_id=payment.subscription_id, checkout_url=str(session["url"]), amount=amount, currency=payload.currency, plan_id=selected_plan)


@router.post("/billing/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    raw = await request.body()
    verify_stripe_webhook(raw, request.headers.get("stripe-signature", ""))
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook JSON.") from exc
    event_id = str(event.get("id") or "")
    event_type = str(event.get("type") or "")
    if not event_id or not event_type:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook event.")
    if db.scalar(select(PaymentWebhookEvent).where(PaymentWebhookEvent.event_id == event_id)):
        return {"received": True, "duplicate": True}
    webhook = PaymentWebhookEvent(provider="stripe", event_id=event_id, event_type=event_type)
    db.add(webhook)
    obj = event.get("data", {}).get("object", {})
    if not isinstance(obj, dict):
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook object.")
    session_id = str(obj.get("id") or "")
    payment = db.scalar(select(PaymentRecord).where(PaymentRecord.provider == "stripe", PaymentRecord.subscription_id == session_id))
    if payment:
        if event_type in {"checkout.session.completed", "checkout.session.async_payment_succeeded"} and obj.get("payment_status") == "paid":
            apply_paid_stripe_payment(db, payment, obj)
            webhook.status = "processed"
        elif event_type in {"checkout.session.expired", "checkout.session.async_payment_failed"}:
            payment.status = "expired" if event_type.endswith("expired") else "failed"
            payment.updated_at = datetime.utcnow()
            finalize_promo_redemption(db, payment, succeeded=False)
            webhook.status = "processed"
        else:
            webhook.status = "ignored"
    else:
        webhook.status = "unmatched"
    webhook.processed_at = datetime.utcnow()
    db.commit()
    return {"received": True, "duplicate": False}


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
    successful = payment.status in SUCCESS_PAYMENT_STATUSES and payment.verified_at is not None
    return PaymentHistoryRead(
        id=payment.id,
        date=payment.paid_at or payment.created_at,
        amount_paise=payment_amount(payment),
        currency=payment.currency,
        plan=payment_plan(payment),
        status=payment.status,
        receipt_number=payment.receipt_number,
        payment_id=payment.razorpay_payment_id or payment.payment_id,
        order_id=payment_order_id(payment),
        original_amount_paise=payment.original_amount_paise or payment_amount(payment),
        discount_amount_paise=payment.discount_amount_paise or 0,
        promo_code=payment.promo_code_snapshot,
        receipt_url=f"/api/v1/payments/{payment.id}/receipt" if successful else None,
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
        support_email=str(settings.ADMIN_EMAIL) if settings.ADMIN_EMAIL else None,
    )
    db.commit()
    return result


@router.get("/payments/history", response_model=PaymentHistoryPage)
def payment_history(
    query: str = Query(default="", max_length=120),
    payment_status: str = Query(default="all", alias="status", pattern="^(all|success|failed)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PaymentHistoryPage:
    statement = select(PaymentRecord).where(PaymentRecord.user_id == current_user.id)
    term = query.strip()
    if payment_status == "success":
        statement = statement.where(PaymentRecord.status.in_(SUCCESS_PAYMENT_STATUSES))
    elif payment_status == "failed":
        statement = statement.where(PaymentRecord.status == "failed")
    if term:
        pattern = f"%{term}%"
        statement = statement.where(
            or_(
                PaymentRecord.receipt_number.ilike(pattern),
                PaymentRecord.payment_id.ilike(pattern),
                PaymentRecord.razorpay_payment_id.ilike(pattern),
                PaymentRecord.subscription_id.ilike(pattern),
                PaymentRecord.razorpay_order_id.ilike(pattern),
                PaymentRecord.plan.ilike(pattern),
                PaymentRecord.plan_id.ilike(pattern),
                cast(PaymentRecord.amount, String).ilike(pattern),
                cast(PaymentRecord.created_at, String).ilike(pattern),
            )
        )
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    payments = db.scalars(
        statement.order_by(PaymentRecord.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return PaymentHistoryPage(
        items=[payment_history_item(payment) for payment in payments],
        page=page,
        page_size=page_size,
        total=total,
        total_pages=max(1, (total + page_size - 1) // page_size),
    )


def _masked_email(value: str) -> str:
    local, separator, domain = value.partition("@")
    if not separator:
        return value
    visible = local[:2]
    return f"{visible}{'*' * max(2, len(local) - len(visible))}@{domain}"


@router.get("/payments/invoices/{payment_id}", include_in_schema=False)
@router.get("/payments/{payment_id}/receipt")
def download_receipt(
    payment_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    payment = db.get(PaymentRecord, payment_id)
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found.")
    is_admin = current_user.is_admin and current_user.role in {"admin", "super_admin"}
    if payment.user_id != current_user.id and not is_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Receipt not found.")
    if payment.status not in SUCCESS_PAYMENT_STATUSES or payment.verified_at is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A verified successful payment is required for a receipt.")
    receipt_number = payment.receipt_number or f"AA-{(payment.paid_at or payment.created_at):%Y%m%d}-{payment.id.replace('-', '')[:12].upper()}"
    if not payment.receipt_number:
        payment.receipt_number = receipt_number
        db.commit()
    user = db.get(User, payment.user_id) if payment.user_id else None
    original_amount = payment.original_amount_paise or payment_amount(payment)
    discount_amount = payment.discount_amount_paise or 0
    reference = payment.razorpay_payment_id or payment.payment_id or "N/A"
    masked_reference = reference if len(reference) <= 8 else f"***{reference[-8:]}"
    receipt = build_text_pdf(
        "Auto-AI Payment Receipt",
        [
            f"Receipt Number: {receipt_number}",
            f"Payment Date: {(payment.paid_at or payment.created_at).isoformat()} UTC",
            f"Customer: {str((payment.raw_metadata or {}).get('user_name') or (user.name if user else 'Auto-AI Customer'))}",
            f"Email: {_masked_email(payment.user_email or (user.email if user else ''))}",
            f"Plan: {payment.plan_name_snapshot or payment_plan(payment)}",
            f"Billing Period: {payment.billing_period_snapshot or 'Monthly'}",
            f"Subtotal: {original_amount / 100:.2f} {payment.currency}",
            f"Promo Code: {payment.promo_code_snapshot or 'None'}",
            f"Discount: {discount_amount / 100:.2f} {payment.currency}",
            f"Final Paid Amount: {payment_amount(payment) / 100:.2f} {payment.currency}",
            f"Payment Status: {payment.status}",
            f"Gateway Reference: {masked_reference}",
            f"Order Reference: {payment_order_id(payment) or 'N/A'}",
            f"Verification Reference: {payment.id}",
            f"Support: {str(settings.ADMIN_EMAIL) if settings.ADMIN_EMAIL else 'support@autoai.site.je'}",
        ],
    )
    if is_admin and payment.user_id != current_user.id:
        db.add(AuditLog(actor_user_id=current_user.id, target_user_id=payment.user_id, action="payment.receipt_access", reason="Admin downloaded payment receipt", audit_metadata={"payment_id": payment.id}))
        db.commit()
    return Response(
        content=receipt,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="AutoAI-Receipt-{receipt_number}.pdf"',
            "Cache-Control": "private, no-store, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.post("/payments/promo-code", response_model=PromoCodeResponse)
def apply_promo_code(
    payload: PromoCodeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PromoCodeResponse:
    quote = quote_promo(db, current_user, payload.code, payload.plan)
    return PromoCodeResponse(
        code=quote.code,
        discount_type=quote.discount_type,
        discount_value=quote.discount_value,
        plan=payload.plan,
        original_amount_paise=quote.original_amount_paise,
        discount_amount_paise=quote.discount_amount_paise,
        discounted_amount_paise=quote.final_amount_paise,
        expires_at=quote.expires_at,
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
    payment = create_razorpay_payment_record(
        db,
        current_user,
        selected_plan=selected_plan,
        amount=payload.amount or 0,
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


@router.post("/payments/sessions/{session_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
def cancel_payment_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    payment = db.scalar(
        select(PaymentRecord)
        .where(
            PaymentRecord.id == session_id,
            PaymentRecord.user_id == current_user.id,
            PaymentRecord.provider == "razorpay",
        )
        .with_for_update()
    )
    if not payment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Payment session not found.")
    if payment.status in {"created", "pending"}:
        payment.status = "cancelled"
        payment.updated_at = datetime.utcnow()
        finalize_promo_redemption(db, payment, succeeded=False)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
        finalize_promo_redemption(db, payment, succeeded=False)
    else:
        payment.updated_at = now
    db.commit()
    return {"success": True, "matched": True}
