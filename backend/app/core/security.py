import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings


pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated=["bcrypt"])


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def password_needs_rehash(hashed_password: str) -> bool:
    return pwd_context.needs_update(hashed_password)


def _jwt_secret() -> str:
    """Resolve the JWT signing secret from the actual Settings fields."""
    return (getattr(settings, "JWT_SECRET_KEY", None) or settings.SECRET_KEY).strip()


def create_access_token(subject: str, expires_delta: timedelta | None = None) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload: dict[str, Any] = {"sub": subject, "exp": expire, "typ": "access", "jti": str(uuid.uuid4())}
    return jwt.encode(payload, _jwt_secret(), algorithm=settings.JWT_ALGORITHM)


def create_screen_share_guest_token(subject: str, expires_delta: timedelta) -> str:
    expire = datetime.now(timezone.utc) + expires_delta
    payload: dict[str, Any] = {
        "sub": subject,
        "exp": expire,
        "typ": "screen_share_guest",
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(
    subject: str,
    token_id: str,
    expires_delta: timedelta | None = None,
) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    )
    payload: dict[str, Any] = {"sub": subject, "jti": token_id, "exp": expire, "typ": "refresh"}
    return jwt.encode(payload, _jwt_secret(), algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[settings.JWT_ALGORITHM])
        token_type = payload.get("typ")
        if token_type not in {None, "access"}:
            return None
        subject = payload.get("sub")
        return str(subject) if subject else None
    except JWTError:
        return None


def decode_screen_share_guest_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[settings.JWT_ALGORITHM])
        if payload.get("typ") != "screen_share_guest":
            return None
        subject = str(payload.get("sub") or "")
        return str(uuid.UUID(subject)) if subject else None
    except (JWTError, ValueError):
        return None


def decode_refresh_token(token: str) -> tuple[str, str] | None:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[settings.JWT_ALGORITHM])
        if payload.get("typ") != "refresh":
            return None
        subject = payload.get("sub")
        token_id = payload.get("jti")
        if not subject or not token_id:
            return None
        return str(subject), str(token_id)
    except JWTError:
        return None


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
