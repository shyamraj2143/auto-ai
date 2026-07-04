from __future__ import annotations

import hashlib
import hmac
from datetime import datetime

import razorpay
from fastapi import APIRouter, Depends, HTTPException, status
from razorpay.errors import BadRequestError, GatewayError, ServerError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.admin_control import PaymentRecord
from app.models.user import User
from app.schemas.payments import (
    CreateOrderRequest,
    CreateOrderResponse,
    PaymentConfigRead,
    PaymentLinkConfig,
    VerifyPaymentRequest,
    VerifyPaymentResponse,
)


router = APIRouter(tags=["payments"])

PLAN_PRICES_PAISE = {
    "pro": 2000,
    "premium": 5000,
    "ultra": 10000,
}

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


def validate_plan_amount(plan: str | None, amount: int) -> None:
    if not plan:
        return
    expected_amount = PLAN_PRICES_PAISE[plan]
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


@router.post("/create-order", response_model=CreateOrderResponse)
@router.post("/payments/create-order", response_model=CreateOrderResponse)
def create_order(
    payload: CreateOrderRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CreateOrderResponse:
    if payload.amount < 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Amount must be at least 100 paise.")
    validate_plan_amount(payload.plan, payload.amount)

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
            raw_metadata={"receipt": receipt[:40]},
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
        validate_plan_amount(payload.plan, order_record.amount_cents)

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
    db.commit()
    return VerifyPaymentResponse(success=True, message=PAYMENT_SCREENSHOT_MESSAGE)
