from datetime import datetime
from io import BytesIO

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.datastructures import Headers, UploadFile

from app.api.routes.users import send_phone_otp, update_profile, upload_avatar, username_available, verify_phone_otp
from app.core.config import settings
from app.db.base import Base
from app.models.user import User
from app.schemas.auth import PhoneVerificationCheck, PhoneVerificationSend, UserProfileUpdate
from app.schemas.call import PublicCallUser
from app.services.phone_verification import PhoneVerificationResult, phone_verification_service
from app.services.user_avatar import public_avatar


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def create_user(db: Session, user_id: str, username: str | None = None) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.com",
        name=f"{user_id} Name",
        username=username,
        hashed_password="unused",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def configure_phone_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "test-token")
    monkeypatch.setenv("TWILIO_VERIFY_SERVICE_SID", "VA_test")


def test_username_validation_and_case_insensitive_duplicate(db: Session) -> None:
    current = create_user(db, "current", "current_user")
    create_user(db, "taken", "shyam.raj")
    db.commit()

    invalid = username_available("Admin", db, current)
    duplicate = username_available("SHYAM.RAJ", db, current)
    available = username_available("new.user_1", db, current)

    assert invalid.valid is False
    assert duplicate.available is False
    assert available.available is True


def test_profile_update_stores_e164_mobile_unverified(db: Session) -> None:
    current = create_user(db, "current", "current_user")
    db.commit()

    updated = update_profile(
        UserProfileUpdate(
            name="Shyam Raj",
            username="shyam_raj",
            phone_country_code="+91",
            phone_number="98765 43210",
        ),
        db,
        current,
    )

    assert updated.username == "shyam_raj"
    assert updated.mobile == "+919876543210"
    assert updated.phone_number == "+919876543210"
    assert updated.phone_country_code == "+91"
    assert updated.phone_verified is False


def test_saving_same_verified_phone_preserves_verification(db: Session) -> None:
    current = create_user(db, "current", "current_user")
    current.mobile = "+919876543210"
    current.phone_number = "+919876543210"
    current.phone_country_code = "+91"
    current.phone_verified = True
    current.phone_verified_at = datetime.utcnow()
    db.commit()

    updated = update_profile(
        UserProfileUpdate(phone_country_code="+91", phone_number="98765 43210"),
        db,
        current,
    )

    assert updated.phone_verified is True
    assert updated.phone_verified_at is not None


def test_changing_verified_phone_invalidates_verification(db: Session) -> None:
    current = create_user(db, "current", "current_user")
    current.mobile = "+919876543210"
    current.phone_number = "+919876543210"
    current.phone_country_code = "+91"
    current.phone_verified = True
    current.phone_verified_at = datetime.utcnow()
    db.commit()

    updated = update_profile(
        UserProfileUpdate(phone_country_code="+91", phone_number="99999 99999"),
        db,
        current,
    )

    assert updated.phone_number == "+919999999999"
    assert updated.phone_verified is False
    assert updated.phone_verified_at is None


def test_send_and_verify_phone_otp(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    db.commit()
    configure_phone_provider(monkeypatch)
    monkeypatch.setattr(
        phone_verification_service,
        "send_code",
        lambda phone: PhoneVerificationResult(True, "pending", "Verification code sent."),
    )
    monkeypatch.setattr(
        phone_verification_service,
        "check_code",
        lambda phone, code: PhoneVerificationResult(code == "123456", "approved" if code == "123456" else "pending", "Mobile number verified." if code == "123456" else "Incorrect code."),
    )

    sent = send_phone_otp(
        PhoneVerificationSend(phone_country_code="+91", phone_number="9876543210"),
        db,
        current,
    )
    verified = verify_phone_otp(PhoneVerificationCheck(code="123456"), db, current)

    assert sent.verified is False
    assert sent.destination.endswith("3210")
    assert verified.verified is True
    assert verified.user is not None
    assert verified.user.phone_verified is True
    assert verified.user.phone_verified_at is not None


def test_duplicate_phone_verification_is_rejected(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    other = create_user(db, "other", "other_user")
    other.mobile = "+919876543210"
    other.phone_number = "+919876543210"
    db.commit()
    configure_phone_provider(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        send_phone_otp(
            PhoneVerificationSend(phone_country_code="+91", phone_number="9876543210"),
            db,
            current,
        )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_avatar_upload_validates_and_stores_path_only(db: Session, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    db.commit()
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))
    file = UploadFile(filename="avatar.png", file=BytesIO(b"\x89PNG\r\n\x1a\nprofile"), headers=Headers({"content-type": "image/png"}))

    updated = await upload_avatar(file, db, current)

    assert updated.avatar
    assert updated.avatar.startswith("/uploads/profile/")
    assert "base64" not in updated.avatar
    assert (tmp_path / "profile").exists()


@pytest.mark.asyncio
async def test_avatar_upload_rejects_invalid_image(db: Session, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    db.commit()
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))
    file = UploadFile(filename="avatar.png", file=BytesIO(b"not an image"), headers=Headers({"content-type": "image/png"}))

    with pytest.raises(Exception):
        await upload_avatar(file, db, current)


def test_missing_local_avatar_falls_back_to_provider_picture(db: Session, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    current.avatar = "/uploads/profile/missing.webp"
    current.picture = "https://images.example.com/current.webp"
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))

    assert public_avatar(current) == current.picture


def test_existing_local_avatar_remains_public(db: Session, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    current = create_user(db, "current", "current_user")
    profile_dir = tmp_path / "profile"
    profile_dir.mkdir()
    (profile_dir / "current.webp").write_bytes(b"RIFFxxxxWEBP")
    current.avatar = "/uploads/profile/current.webp"
    current.picture = "https://images.example.com/current.webp"
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))

    assert public_avatar(current) == current.avatar


def test_public_call_user_never_exposes_private_profile_fields() -> None:
    fields = set(PublicCallUser.model_fields)
    assert "email" not in fields
    assert "mobile" not in fields
    assert "phone_number" not in fields
    assert "fcm_token" not in fields
