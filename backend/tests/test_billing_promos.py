from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.api.routes.admin import create_promo_code
from app.api.routes.payments import cancel_payment_session, download_receipt, payment_history
from app.db.base import Base
from app.models.admin_control import PaymentRecord
from app.models.promo import PromoCode, PromoRedemption
from app.models.user import User
from app.schemas.promo import PromoCodeCreate
from app.services.promo_service import finalize_promo_redemption, quote_promo, reserve_promo


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def make_user(db: Session, user_id: str, *, admin: bool = False) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name=user_id.title(),
        hashed_password="unused",
        is_active=True,
        is_admin=admin,
        role="admin" if admin else "user",
    )
    db.add(user)
    db.commit()
    return user


def promo_payload(code: str = "SAVE20", **changes) -> PromoCodeCreate:
    values = {
        "code": code,
        "description": "Launch promo",
        "discount_type": "percentage",
        "discount_value": Decimal("20"),
        "eligible_plans": ["pro"],
        "per_user_limit": 1,
        "is_active": True,
    }
    values.update(changes)
    return PromoCodeCreate(**values)


def make_payment(db: Session, user: User, payment_id: str, *, status: str = "created", amount: int = 0) -> PaymentRecord:
    payment = PaymentRecord(
        id=payment_id,
        user_id=user.id,
        user_email=user.email,
        provider="razorpay",
        plan="pro",
        plan_id="pro",
        amount=amount,
        amount_cents=amount,
        currency="INR",
        status=status,
    )
    db.add(payment)
    db.flush()
    return payment


def test_admin_can_create_promo_and_non_admin_is_rejected(db: Session) -> None:
    admin = make_user(db, "admin", admin=True)
    user = make_user(db, "member")
    created = create_promo_code(promo_payload("save20"), admin, db)
    assert created.code == "SAVE20"
    assert created.created_by == admin.id
    with pytest.raises(HTTPException) as exc:
        get_current_admin(user)
    assert exc.value.status_code == 403


def test_duplicate_code_is_case_insensitive(db: Session) -> None:
    admin = make_user(db, "admin", admin=True)
    create_promo_code(promo_payload("Save20"), admin, db)
    with pytest.raises(HTTPException) as exc:
        create_promo_code(promo_payload("SAVE20"), admin, db)
    assert exc.value.status_code == 409


def test_percentage_fixed_and_date_validation() -> None:
    with pytest.raises(ValueError):
        promo_payload(discount_value=Decimal("101"))
    fixed = promo_payload(discount_type="fixed", discount_value=Decimal("100"), currency="INR")
    assert fixed.currency == "INR"
    with pytest.raises(ValueError):
        promo_payload(discount_type="fixed", discount_value=Decimal("100"))
    with pytest.raises(ValueError):
        promo_payload(starts_at=datetime.utcnow(), expires_at=datetime.utcnow() - timedelta(days=1))


def test_expired_inactive_and_wrong_plan_promos_are_rejected(db: Session) -> None:
    admin = make_user(db, "admin", admin=True)
    user = make_user(db, "member")
    expired = create_promo_code(
        promo_payload("EXPIRED", starts_at=datetime.utcnow() - timedelta(days=2), expires_at=datetime.utcnow() - timedelta(days=1)),
        admin,
        db,
    )
    with pytest.raises(HTTPException, match="expired"):
        quote_promo(db, user, expired.code, "pro")
    inactive = create_promo_code(promo_payload("INACTIVE", is_active=False), admin, db)
    with pytest.raises(HTTPException, match="inactive"):
        quote_promo(db, user, inactive.code, "pro")
    valid = create_promo_code(promo_payload("PROONLY"), admin, db)
    with pytest.raises(HTTPException, match="selected plan"):
        quote_promo(db, user, valid.code, "premium")


def test_limits_failed_payment_and_idempotent_success_redemption(db: Session) -> None:
    admin = make_user(db, "admin", admin=True)
    first_user = make_user(db, "first")
    second_user = make_user(db, "second")
    promo = create_promo_code(promo_payload("ONEUSE", total_usage_limit=1), admin, db)

    first_payment = make_payment(db, first_user, "payment-1")
    first_quote = reserve_promo(db, first_payment, first_user, promo.code)
    first_payment.amount = first_quote.final_amount_paise
    first_payment.amount_cents = first_quote.final_amount_paise
    db.commit()
    with pytest.raises(HTTPException, match="usage limit"):
        quote_promo(db, second_user, promo.code, "pro")

    finalize_promo_redemption(db, first_payment, succeeded=False)
    first_payment.status = "failed"
    db.commit()
    assert db.get(PromoCode, promo.id).usage_count == 0

    second_payment = make_payment(db, second_user, "payment-2")
    second_quote = reserve_promo(db, second_payment, second_user, promo.code)
    second_payment.amount = second_quote.final_amount_paise
    second_payment.amount_cents = second_quote.final_amount_paise
    finalize_promo_redemption(db, second_payment, succeeded=True)
    finalize_promo_redemption(db, second_payment, succeeded=True)
    db.commit()
    assert db.get(PromoCode, promo.id).usage_count == 1
    assert db.scalar(select(PromoRedemption).where(PromoRedemption.payment_id == second_payment.id)).status == "redeemed"


def test_cancelled_session_releases_promo_reservation(db: Session) -> None:
    admin = make_user(db, "admin", admin=True)
    user = make_user(db, "member")
    promo = create_promo_code(promo_payload("CANCELME", total_usage_limit=1), admin, db)
    payment = make_payment(db, user, "cancel-payment")
    reserve_promo(db, payment, user, promo.code)
    db.commit()

    response = cancel_payment_session(payment.id, user, db)

    assert response.status_code == 204
    assert db.get(PaymentRecord, payment.id).status == "cancelled"
    refreshed = db.get(PromoCode, promo.id)
    assert refreshed.usage_count == 0
    assert refreshed.reserved_count == 0
    redemption = db.scalar(select(PromoRedemption).where(PromoRedemption.payment_id == payment.id))
    assert redemption.status == "failed"
    assert redemption.usage_slot is None


def test_payment_search_filter_ownership_and_verified_pdf_receipt(db: Session) -> None:
    owner = make_user(db, "owner")
    other = make_user(db, "other")
    paid = make_payment(db, owner, "paid-payment", status="paid", amount=49900)
    paid.payment_id = "pay_verified_123456"
    paid.receipt_number = "AA-TEST-001"
    paid.verified_at = datetime.utcnow()
    paid.paid_at = datetime.utcnow()
    paid.original_amount_paise = 59900
    paid.discount_amount_paise = 10000
    paid.plan_name_snapshot = "Pro"
    paid.billing_period_snapshot = "Monthly"
    make_payment(db, owner, "failed-payment", status="failed", amount=49900)
    make_payment(db, other, "other-payment", status="paid", amount=49900)
    db.commit()

    success = payment_history("AA-TEST", "success", 1, 20, owner, db)
    failed = payment_history("", "failed", 1, 20, owner, db)
    assert [item.id for item in success.items] == [paid.id]
    assert [item.id for item in failed.items] == ["failed-payment"]
    assert all(item.id != "other-payment" for item in success.items + failed.items)

    response = download_receipt(paid.id, owner, db)
    assert response.media_type == "application/pdf"
    assert response.body.startswith(b"%PDF")
    assert b"499.00 INR" in response.body
    with pytest.raises(HTTPException) as exc:
        download_receipt(paid.id, other, db)
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        download_receipt("failed-payment", owner, db)
    assert exc.value.status_code == 409
