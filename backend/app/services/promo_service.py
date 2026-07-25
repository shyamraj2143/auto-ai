from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.admin_control import PaymentRecord
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User
from app.services.admin_control import plan_price_paise, promo_discount_percent


SUCCESS_PAYMENT_STATUSES = {"paid", "verified", "captured", "succeeded"}
RESERVED_REDEMPTION_STATUSES = {"pending", "redeemed"}


@dataclass(frozen=True)
class PromoQuote:
    code: str
    promo_id: str | None
    discount_type: str
    discount_value: Decimal
    plan: str
    original_amount_paise: int
    discount_amount_paise: int
    final_amount_paise: int
    expires_at: datetime | None


def normalize_promo_code(value: str | None) -> str:
    return (value or "").strip().upper()


def promo_status(promo: PromoCode, now: datetime | None = None) -> str:
    now = now or datetime.utcnow()
    if promo.is_archived:
        return "archived"
    if not promo.is_active:
        return "inactive"
    if promo.starts_at and promo.starts_at > now:
        return "scheduled"
    if promo.expires_at and promo.expires_at <= now:
        return "expired"
    return "active"


def _money_to_paise(value: Decimal) -> int:
    return int((value * Decimal("100")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _redemption_count(db: Session, promo_id: str, *, user_id: str | None = None) -> int:
    query = select(func.count()).select_from(PromoRedemption).where(
        PromoRedemption.promo_code_id == promo_id,
        PromoRedemption.status.in_(RESERVED_REDEMPTION_STATUSES),
    )
    if user_id:
        query = query.where(PromoRedemption.user_id == user_id)
    return int(db.scalar(query) or 0)


def _quote_managed_promo(db: Session, user: User, promo: PromoCode, plan: str, currency: str) -> PromoQuote:
    now = datetime.utcnow()
    state = promo_status(promo, now)
    error_by_state = {
        "archived": "This promo code is unavailable.",
        "inactive": "This promo code is inactive.",
        "scheduled": "This promo code is not active yet.",
        "expired": "This promo code has expired.",
    }
    if state != "active":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_by_state[state])
    if plan not in (promo.eligible_plans or []):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code is not valid for the selected plan.")
    if promo.discount_type == "fixed" and promo.currency != currency:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code is not valid for the selected currency.")

    original_paise = plan_price_paise(db, plan)
    original_amount = Decimal(original_paise) / Decimal("100")
    if promo.minimum_amount is not None and original_amount < promo.minimum_amount:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The minimum purchase amount for this promo code is not met.")
    if promo.new_users_only:
        prior_payment = db.scalar(
            select(PaymentRecord.id).where(
                PaymentRecord.user_id == user.id,
                PaymentRecord.status.in_(SUCCESS_PAYMENT_STATUSES),
            ).limit(1)
        )
        if prior_payment:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code is only available to new customers.")
    if promo.total_usage_limit is not None and int(promo.reserved_count or 0) >= promo.total_usage_limit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code has reached its usage limit.")
    if _redemption_count(db, promo.id, user_id=user.id) >= promo.per_user_limit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You have already used this promo code.")

    if promo.discount_type == "percentage":
        discount_paise = int(
            (Decimal(original_paise) * promo.discount_value / Decimal("100")).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        if promo.maximum_discount is not None:
            discount_paise = min(discount_paise, _money_to_paise(promo.maximum_discount))
    else:
        discount_paise = _money_to_paise(promo.discount_value)
    discount_paise = min(max(discount_paise, 0), max(original_paise - 100, 0))
    if discount_paise <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code does not discount the selected plan.")
    return PromoQuote(
        code=promo.normalized_code,
        promo_id=promo.id,
        discount_type=promo.discount_type,
        discount_value=promo.discount_value,
        plan=plan,
        original_amount_paise=original_paise,
        discount_amount_paise=discount_paise,
        final_amount_paise=original_paise - discount_paise,
        expires_at=promo.expires_at,
    )


def quote_promo(
    db: Session,
    user: User,
    code: str,
    plan: str,
    currency: str = "INR",
    *,
    lock: bool = False,
) -> PromoQuote:
    normalized = normalize_promo_code(code)
    query = select(PromoCode).where(PromoCode.normalized_code == normalized)
    if lock:
        query = query.with_for_update()
    promo = db.scalar(query)
    if promo:
        return _quote_managed_promo(db, user, promo, plan, currency)

    legacy_percent = promo_discount_percent(normalized)
    if legacy_percent <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid promo code.")
    original_paise = plan_price_paise(db, plan)
    discount_paise = int(
        (Decimal(original_paise) * Decimal(legacy_percent) / Decimal("100")).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )
    discount_paise = min(discount_paise, max(original_paise - 100, 0))
    return PromoQuote(
        code=normalized,
        promo_id=None,
        discount_type="percentage",
        discount_value=Decimal(legacy_percent),
        plan=plan,
        original_amount_paise=original_paise,
        discount_amount_paise=discount_paise,
        final_amount_paise=original_paise - discount_paise,
        expires_at=None,
    )


def reserve_promo(db: Session, payment: PaymentRecord, user: User, code: str) -> PromoQuote:
    quote = quote_promo(db, user, code, payment.plan_id or payment.plan, payment.currency, lock=True)
    payment.original_amount_paise = quote.original_amount_paise
    payment.discount_amount_paise = quote.discount_amount_paise
    payment.promo_code_id = quote.promo_id
    payment.promo_code_snapshot = quote.code
    if not quote.promo_id:
        return quote
    promo = db.get(PromoCode, quote.promo_id)
    if not promo:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Promo code is no longer available.")
    counter_update = (
        update(PromoCode)
        .where(PromoCode.id == quote.promo_id)
        .values(reserved_count=PromoCode.reserved_count + 1)
    )
    if promo.total_usage_limit is not None:
        counter_update = counter_update.where(PromoCode.reserved_count < promo.total_usage_limit)
    if (db.execute(counter_update).rowcount or 0) != 1:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This promo code has reached its usage limit.")
    usage_slot = _redemption_count(db, quote.promo_id, user_id=user.id) + 1
    redemption = PromoRedemption(
        promo_code_id=quote.promo_id,
        user_id=user.id,
        payment_id=payment.id,
        usage_slot=usage_slot,
        original_amount=Decimal(quote.original_amount_paise) / Decimal("100"),
        discount_amount=Decimal(quote.discount_amount_paise) / Decimal("100"),
        final_amount=Decimal(quote.final_amount_paise) / Decimal("100"),
        status="pending",
    )
    db.add(redemption)
    try:
        db.flush()
    except IntegrityError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This promo code is already reserved for the payment.") from exc
    return quote


def finalize_promo_redemption(db: Session, payment: PaymentRecord, *, succeeded: bool) -> None:
    redemption = db.scalar(
        select(PromoRedemption).where(PromoRedemption.payment_id == payment.id).with_for_update()
    )
    if not redemption:
        return
    if succeeded:
        if redemption.status == "redeemed":
            return
        promo = db.scalar(select(PromoCode).where(PromoCode.id == redemption.promo_code_id).with_for_update())
        if not promo:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Promo redemption record is invalid.")
        redemption.status = "redeemed"
        redemption.redeemed_at = datetime.utcnow()
        redemption.updated_at = datetime.utcnow()
        promo.usage_count = int(promo.usage_count or 0) + 1
        promo.updated_at = datetime.utcnow()
    elif redemption.status == "pending":
        promo = db.scalar(select(PromoCode).where(PromoCode.id == redemption.promo_code_id).with_for_update())
        if promo:
            promo.reserved_count = max(0, int(promo.reserved_count or 0) - 1)
        redemption.status = "failed"
        redemption.usage_slot = None
        redemption.updated_at = datetime.utcnow()
