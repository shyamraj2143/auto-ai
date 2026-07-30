from datetime import datetime
from pathlib import Path
import re
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import UserProfileUpdate, UserRead, UsernameAvailability
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


def normalize_phone(phone_number: str | None, phone_country_code: str | None) -> tuple[str | None, str | None]:
    raw_number = (phone_number or "").strip()
    raw_country = (phone_country_code or "").strip()
    if not raw_number:
        return None, None
    country = raw_country if raw_country.startswith("+") else f"+{raw_country}" if raw_country else ""
    digits = re.sub(r"\D", "", raw_number)
    candidate = raw_number if raw_number.startswith("+") else f"{country}{digits}"
    if not country or not COUNTRY_CODE_PATTERN.fullmatch(country) or not E164_PATTERN.fullmatch(candidate):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Enter a valid international mobile number.")
    return candidate, country


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
        current_user.mobile = phone_number
        current_user.phone_number = phone_number
        current_user.phone_country_code = phone_country_code
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
