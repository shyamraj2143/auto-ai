from datetime import datetime
from pathlib import Path
import re
import time
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import (
    PhoneVerificationCheck,
    PhoneVerificationSend,
    PhoneVerificationStatus,
    UserProfileUpdate,
    UserRead,
    UsernameAvailability,
)
from app.services.phone_verification import phone_verification_service
from app.services.user_identity import normalize_username, username_error
from app.services.user_avatar import public_avatar


router = APIRouter(prefix="/users", tags=["users"])

ALLOWED_AVATAR_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
ALLOWED_AVATAR_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_AVATAR_BYTES = 5 * 1024 * 1024
E164_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")
COUNTRY_CODE_PATTERN = re.compile(r"^\+[1-9]\d{0,3}$")
INDIA_MOBILE_PATTERN = re.compile(r"^[6-9]\d{9}$")
PHONE_OTP_RESEND_SECONDS = 30
PHONE_OTP_MAX_CHECKS_PER_WINDOW = 6
PHONE_OTP_CHECK_WINDOW_SECONDS = 10 * 60
_phone_send_times: dict[str, float] = {}
_phone_check_windows: dict[str, tuple[float, int]] = {}


def avatar_directory() -> Path:
    directory = (Path(settings.UPLOAD_DIR) / "profile").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def avatar_url(filename: str) -> str:
    return f"/uploads/profile/{filename}"


def valid_image_bytes(content: bytes, suffix: str) -> bool:
    if suffix in {".jpg", ".jpeg"}:
        return content.startswith(b"\xff\xd8\xff")
    if suffix == ".png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix == ".webp":
        return len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    return False


def remove_local_avatar(path_value: str | None) -> None:
    if not path_value or not path_value.startswith("/uploads/profile/"):
        return
    filename = Path(path_value).name
    directory = avatar_directory()
    target = (directory / filename).resolve()
    try:
        target.relative_to(directory)
    except ValueError:
        return
    if target.exists():
        target.unlink()


def username_taken(db: Session, username: str, current_user_id: str | None = None) -> bool:
    statement = select(User.id).where(func.lower(User.username) == username.lower())
    if current_user_id:
        statement = statement.where(User.id != current_user_id)
    return db.scalar(statement) is not None


def normalize_country_code(phone_country_code: str | None) -> str:
    digits = re.sub(r"\D", "", phone_country_code or "")
    country = f"+{digits}" if digits else ""
    if not COUNTRY_CODE_PATTERN.fullmatch(country):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Select a valid country calling code.",
        )
    return country


def normalize_national_number(raw_number: str, country: str) -> str:
    stripped = raw_number.strip()
    had_international_prefix = stripped.startswith("+") or stripped.startswith("00")
    digits = re.sub(r"\D", "", stripped)
    if stripped.startswith("00"):
        digits = digits[2:]

    country_digits = country[1:]
    if had_international_prefix:
        if not digits.startswith(country_digits):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The mobile number does not match the selected country code.",
            )
        digits = digits[len(country_digits):]
    elif digits.startswith(country_digits) and len(digits) > 10:
        digits = digits[len(country_digits):]

    if country == "+91":
        if len(digits) == 11 and digits.startswith("0"):
            digits = digits[1:]
        if not INDIA_MOBILE_PATTERN.fullmatch(digits):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9.",
            )
        return digits

    if digits.startswith("0") and 7 <= len(digits[1:]) <= 12:
        digits = digits[1:]
    if not 7 <= len(digits) <= 12:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enter a valid mobile number for the selected country.",
        )
    return digits


def normalize_phone(phone_number: str | None, phone_country_code: str | None) -> tuple[str | None, str | None]:
    raw_number = (phone_number or "").strip()
    if not raw_number:
        return None, None
    country = normalize_country_code(phone_country_code)
    national_number = normalize_national_number(raw_number, country)
    candidate = f"{country}{national_number}"
    if not E164_PATTERN.fullmatch(candidate):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enter a valid mobile number for the selected country.",
        )
    return candidate, country


def phone_provider_http_status(message: str) -> int:
    lowered = message.casefold()
    user_input_markers = (
        "valid mobile number",
        "valid international",
        "destination",
        "selected country",
    )
    if any(marker in lowered for marker in user_input_markers):
        return status.HTTP_422_UNPROCESSABLE_ENTITY
    if "too many" in lowered or "wait" in lowered or "maximum otp" in lowered:
        return status.HTTP_429_TOO_MANY_REQUESTS
    return status.HTTP_502_BAD_GATEWAY


def masked_phone(phone_number: str) -> str:
    if len(phone_number) <= 6:
        return phone_number
    return f"{phone_number[:3]}{'•' * max(4, len(phone_number) - 7)}{phone_number[-4:]}"


def ensure_unique_phone(db: Session, phone_number: str, current_user_id: str) -> None:
    owner = db.scalar(
        select(User.id).where(
            User.mobile == phone_number,
            User.id != current_user_id,
        )
    )
    if owner:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This mobile number is already linked to another account.")


def serialize_user(user: User) -> UserRead:
    serialized = UserRead.model_validate(user)
    return serialized.model_copy(update={"avatar": public_avatar(user) or None})


@router.get("/me", response_model=UserRead)
def get_profile(current_user: User = Depends(get_current_user)) -> UserRead:
    return serialize_user(current_user)


@router.patch("/me", response_model=UserRead)
def update_profile(
    payload: UserProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UserRead:
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        display_name = " ".join(data["name"].strip().split())
        if len(display_name) < 2:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Full name must be at least 2 characters.")
        current_user.name = display_name
    if "username" in data and data["username"] is not None:
        username = normalize_username(data["username"])
        error = username_error(username)
        if error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error)
        if username_taken(db, username, current_user.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already taken.")
        current_user.username = username
    if "phone_number" in data or "phone_country_code" in data:
        phone_number, phone_country_code = normalize_phone(data.get("phone_number"), data.get("phone_country_code"))
        if phone_number:
            ensure_unique_phone(db, phone_number, current_user.id)
        phone_changed = phone_number != current_user.phone_number
        current_user.mobile = phone_number
        current_user.phone_number = phone_number
        current_user.phone_country_code = phone_country_code
        if phone_changed:
            current_user.phone_verified = False
            current_user.phone_verified_at = None
    if "memory_enabled" in data and data["memory_enabled"] is not None:
        current_user.memory_enabled = data["memory_enabled"]
    if "feedback_learning_enabled" in data and data["feedback_learning_enabled"] is not None:
        current_user.feedback_learning_enabled = data["feedback_learning_enabled"]
    current_user.updated_at = datetime.utcnow()
    current_user.profile_updated_at = current_user.updated_at
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Profile value already exists.") from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to update profile.") from exc
    db.refresh(current_user)
    return serialize_user(current_user)


@router.post("/me/phone/send-otp", response_model=PhoneVerificationStatus)
def send_phone_otp(
    payload: PhoneVerificationSend,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PhoneVerificationStatus:
    phone_number, phone_country_code = normalize_phone(payload.phone_number, payload.phone_country_code)
    if not phone_number or not phone_country_code:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Enter a mobile number first.")
    ensure_unique_phone(db, phone_number, current_user.id)
    if not phone_verification_service.configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SMS verification is not configured on the server yet.",
        )

    now = time.monotonic()
    previous = _phone_send_times.get(current_user.id, 0.0)
    remaining = int(PHONE_OTP_RESEND_SECONDS - (now - previous))
    if remaining > 0:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Wait {remaining} seconds before requesting another code.",
        )

    phone_changed = current_user.phone_number != phone_number
    current_user.mobile = phone_number
    current_user.phone_number = phone_number
    current_user.phone_country_code = phone_country_code
    if phone_changed:
        current_user.phone_verified = False
        current_user.phone_verified_at = None
    current_user.updated_at = datetime.utcnow()
    current_user.profile_updated_at = current_user.updated_at
    db.commit()

    try:
        result = phone_verification_service.send_code(phone_number)
    except RuntimeError as exc:
        detail = str(exc)
        raise HTTPException(status_code=phone_provider_http_status(detail), detail=detail) from exc
    if not result.ok:
        raise HTTPException(status_code=phone_provider_http_status(result.detail), detail=result.detail)
    _phone_send_times[current_user.id] = now
    _phone_check_windows[current_user.id] = (now, 0)
    return PhoneVerificationStatus(
        message=result.detail,
        destination=masked_phone(phone_number),
        expires_in_seconds=600,
        resend_after_seconds=PHONE_OTP_RESEND_SECONDS,
        verified=False,
    )


@router.post("/me/phone/verify-otp", response_model=PhoneVerificationStatus)
def verify_phone_otp(
    payload: PhoneVerificationCheck,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PhoneVerificationStatus:
    phone_number = current_user.phone_number or current_user.mobile
    if not phone_number:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Save a mobile number before verification.")
    if current_user.phone_verified:
        return PhoneVerificationStatus(
            message="Mobile number is already verified.",
            destination=masked_phone(phone_number),
            verified=True,
            user=serialize_user(current_user),
        )
    if not phone_verification_service.configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SMS verification is not configured on the server yet.")

    now = time.monotonic()
    window_started, attempts = _phone_check_windows.get(current_user.id, (now, 0))
    if now - window_started > PHONE_OTP_CHECK_WINDOW_SECONDS:
        window_started, attempts = now, 0
    if attempts >= PHONE_OTP_MAX_CHECKS_PER_WINDOW:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many incorrect attempts. Request a new code.")
    _phone_check_windows[current_user.id] = (window_started, attempts + 1)

    try:
        result = phone_verification_service.check_code(phone_number, payload.code)
    except RuntimeError as exc:
        detail = str(exc)
        raise HTTPException(status_code=phone_provider_http_status(detail), detail=detail) from exc
    if not result.ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=result.detail)

    current_user.phone_verified = True
    current_user.phone_verified_at = datetime.utcnow()
    current_user.updated_at = current_user.phone_verified_at
    current_user.profile_updated_at = current_user.phone_verified_at
    db.commit()
    db.refresh(current_user)
    _phone_check_windows.pop(current_user.id, None)
    _phone_send_times.pop(current_user.id, None)
    return PhoneVerificationStatus(
        message="Mobile number verified successfully.",
        destination=masked_phone(phone_number),
        verified=True,
        user=serialize_user(current_user),
    )


@router.post("/me/avatar", response_model=UserRead)
async def upload_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UserRead:
    suffix = Path(file.filename or "").suffix.lower()
    if file.content_type not in ALLOWED_AVATAR_CONTENT_TYPES or suffix not in ALLOWED_AVATAR_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Avatar must be JPG, PNG or WebP.")
    content = await file.read(MAX_AVATAR_BYTES + 1)
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Avatar must be 5 MB or smaller.")
    if not valid_image_bytes(content, suffix):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Avatar file is not a valid image.")
    extension = ".jpg" if suffix == ".jpeg" else suffix
    filename = f"{current_user.id}_{uuid.uuid4().hex}{extension}"
    directory = avatar_directory()
    target = (directory / filename).resolve()
    try:
        target.relative_to(directory)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid avatar path.") from exc
    target.write_bytes(content)
    remove_local_avatar(current_user.avatar)
    current_user.avatar = avatar_url(filename)
    current_user.updated_at = datetime.utcnow()
    current_user.profile_updated_at = current_user.updated_at
    db.commit()
    db.refresh(current_user)
    return serialize_user(current_user)


@router.delete("/me/avatar", status_code=status.HTTP_204_NO_CONTENT)
def delete_avatar(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    remove_local_avatar(current_user.avatar)
    current_user.avatar = None
    current_user.updated_at = datetime.utcnow()
    current_user.profile_updated_at = current_user.updated_at
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/username-available", response_model=UsernameAvailability)
def username_available(
    username: str = Query(min_length=1, max_length=64),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UsernameAvailability:
    normalized = normalize_username(username)
    error = username_error(normalized)
    if error:
        return UsernameAvailability(username=normalized, available=False, valid=False, message="Invalid username")
    available = not username_taken(db, normalized, current_user.id)
    return UsernameAvailability(
        username=normalized,
        available=available,
        valid=True,
        message="Username available" if available else "Username already taken",
    )
