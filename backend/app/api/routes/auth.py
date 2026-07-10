import logging
import smtplib
import secrets
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, get_current_user
from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
    get_password_hash,
    hash_token,
    password_needs_rehash,
    verify_password,
)
from app.db.session import get_db
from app.models.auth import PasswordResetToken, RefreshToken
from app.models.user import User
from app.repositories.sqlalchemy import SQLAlchemyUserRepository
from app.schemas.auth import (
    GoogleConfig,
    GoogleTokenRequest,
    LogoutRequest,
    PasswordResetConfirm,
    PasswordResetRequest,
    PasswordResetResult,
    RefreshRequest,
    Token,
    UserCreate,
    UserLogin,
    UserRead,
)
from app.services.admin_control import ensure_user_subscription
from app.services.google_auth import (
    GoogleAuthConfigurationError,
    GoogleAuthError,
    GoogleEmailNotVerifiedError,
    GoogleIdentity,
    verify_google_id_token,
)


router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger("auto_ai.auth")
PASSWORD_RESET_MESSAGE = "If an account exists, a password reset link has been sent."


def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_mobile(mobile: str | None) -> str | None:
    if not mobile:
        return None
    normalized = "".join(char for char in mobile.strip() if char.isdigit() or char == "+")
    return normalized or None


def auth_cookie_options(request: Request) -> tuple[bool, str]:
    secure = settings.is_production or request.url.scheme == "https"
    return secure, "none" if secure else "lax"


def set_auth_cookies(response: Response, request: Request, access_token: str, refresh_token: str) -> None:
    secure, same_site = auth_cookie_options(request)
    response.set_cookie(
        ACCESS_TOKEN_COOKIE,
        access_token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=secure,
        samesite=same_site,
        path="/",
    )
    response.set_cookie(
        REFRESH_TOKEN_COOKIE,
        refresh_token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=secure,
        samesite=same_site,
        path=f"{settings.API_V1_STR}/auth",
    )


def clear_auth_cookies(response: Response, request: Request) -> None:
    secure, same_site = auth_cookie_options(request)
    response.delete_cookie(ACCESS_TOKEN_COOKIE, path="/", secure=secure, samesite=same_site)
    response.delete_cookie(
        REFRESH_TOKEN_COOKIE,
        path=f"{settings.API_V1_STR}/auth",
        secure=secure,
        samesite=same_site,
    )


def merged_provider(current_provider: str | None) -> str:
    provider = (current_provider or "email").strip().lower()
    if provider == "google":
        return "google"
    if "google" in provider:
        return provider[:32]
    return "email_google"


def sync_subscription_status(db: Session, user: User) -> str:
    subscription = ensure_user_subscription(db, user)
    status_value = "suspended" if subscription.suspended_at else (subscription.status or subscription.payment_status or "free")
    user.subscription_status = str(status_value).strip().lower() or "free"
    return user.subscription_status


def ensure_user_can_authenticate(user: User) -> None:
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is blocked or disabled.")
    if (user.subscription_status or "").lower() in {"blocked", "suspended"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is suspended.")


def create_persisted_refresh_token(db: Session, user: User, request: Request) -> str:
    token_id = str(uuid.uuid4())
    expires_at = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    refresh_token = create_refresh_token(user.id, token_id)
    db.add(
        RefreshToken(
            id=token_id,
            user_id=user.id,
            token_hash=hash_token(refresh_token),
            user_agent=(request.headers.get("user-agent") or "")[:255],
            expires_at=expires_at,
        )
    )
    return refresh_token


def issue_session(db: Session, user: User, request: Request, response: Response) -> Token:
    access_token = create_access_token(user.id)
    refresh_token = create_persisted_refresh_token(db, user, request)
    user.updated_at = datetime.utcnow()
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create login session.") from exc
    db.refresh(user)
    set_auth_cookies(response, request, access_token, refresh_token)
    return Token(access_token=access_token, refresh_token=refresh_token, user=UserRead.model_validate(user))


def revoke_refresh_token(db: Session, refresh_token: str | None) -> None:
    if not refresh_token:
        return
    decoded = decode_refresh_token(refresh_token)
    if not decoded:
        return
    _, token_id = decoded
    record = db.get(RefreshToken, token_id)
    if record and record.token_hash == hash_token(refresh_token) and not record.revoked_at:
        record.revoked_at = datetime.utcnow()
        db.commit()


def user_from_refresh_token(db: Session, refresh_token: str) -> tuple[User, RefreshToken]:
    decoded = decode_refresh_token(refresh_token)
    if not decoded:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")
    user_id, token_id = decoded
    record = db.get(RefreshToken, token_id)
    if (
        not record
        or record.user_id != user_id
        or record.token_hash != hash_token(refresh_token)
        or record.revoked_at
        or record.expires_at <= datetime.utcnow()
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token.")
    return user, record


def create_google_user(identity: GoogleIdentity) -> User:
    return User(
        email=identity.email,
        name=identity.name or identity.email.split("@", 1)[0],
        hashed_password=get_password_hash(secrets.token_urlsafe(48)),
        picture=identity.picture,
        avatar=identity.picture,
        provider="google",
        google_id=identity.google_id,
        is_active=True,
        is_admin=False,
        role="user",
        subscription_status="free",
    )


def password_reset_origin(request: Request) -> str:
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if origin and not settings.is_production:
        return origin
    return settings.frontend_url


def password_reset_url(request: Request, token: str) -> str:
    return f"{password_reset_origin(request)}/reset-password?token={quote(token)}"


def send_password_reset_email(email: str, reset_url: str) -> bool:
    if not settings.password_reset_email_enabled:
        return False
    from_email = settings.password_reset_from_email
    if not from_email:
        return False

    message = EmailMessage()
    message["Subject"] = "Reset your Auto-AI password"
    message["From"] = formataddr((settings.PASSWORD_RESET_FROM_NAME, from_email))
    message["To"] = email
    message.set_content(
        "We received a request to reset your Auto-AI password.\n\n"
        f"Open this link within {settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES} minutes:\n{reset_url}\n\n"
        "If you did not request this, you can ignore this email."
    )

    try:
        if settings.SMTP_USE_SSL:
            smtp = smtplib.SMTP_SSL(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15)
        else:
            smtp = smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15)
        with smtp:
            if settings.SMTP_USE_TLS and not settings.SMTP_USE_SSL:
                smtp.starttls()
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.smtp_password or "")
            smtp.send_message(message)
        return True
    except Exception:
        logger.exception("Password reset email could not be sent.")
        return False


@router.get("/google/config", response_model=GoogleConfig)
def google_config() -> GoogleConfig:
    client_id = settings.google_web_client_id
    return GoogleConfig(enabled=bool(client_id), client_id=client_id)


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
def register(
    payload: UserCreate,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> Token:
    repo = SQLAlchemyUserRepository(db)
    email = normalize_email(str(payload.email))
    mobile = normalize_mobile(payload.mobile)
    if repo.get_by_email(email):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Please log in instead.",
        )
    if mobile and repo.get_by_mobile(mobile):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this mobile number already exists. Please log in instead.",
        )

    try:
        user = repo.create(
            email=email,
            mobile=mobile,
            name=payload.name,
            hashed_password=get_password_hash(payload.password),
            is_admin=False,
            role="user",
        )
        sync_subscription_status(db, user)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email or mobile number already exists. Please log in instead.",
        ) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create account.") from exc
    return issue_session(db, user, request, response)


@router.post("/login", response_model=Token)
def login(
    payload: UserLogin,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> Token:
    repo = SQLAlchemyUserRepository(db)
    user = repo.get_by_email(normalize_email(str(payload.email)))
    if not user or not user.hashed_password or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Email or password is incorrect.")
    sync_subscription_status(db, user)
    ensure_user_can_authenticate(user)
    if password_needs_rehash(user.hashed_password):
        user.hashed_password = get_password_hash(payload.password)
    return issue_session(db, user, request, response)


@router.post("/password/forgot", response_model=PasswordResetResult)
def request_password_reset(
    payload: PasswordResetRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> PasswordResetResult:
    repo = SQLAlchemyUserRepository(db)
    user = repo.get_by_email(normalize_email(str(payload.email)))
    response_reset_url: str | None = None

    if user and user.is_active:
        now = datetime.utcnow()
        raw_token = secrets.token_urlsafe(48)
        reset_link = password_reset_url(request, raw_token)
        try:
            db.execute(
                update(PasswordResetToken)
                .where(
                    PasswordResetToken.user_id == user.id,
                    PasswordResetToken.used_at.is_(None),
                    PasswordResetToken.revoked_at.is_(None),
                )
                .values(revoked_at=now)
            )
            db.add(
                PasswordResetToken(
                    user_id=user.id,
                    token_hash=hash_token(raw_token),
                    user_agent=(request.headers.get("user-agent") or "")[:255],
                    request_ip=(request.client.host if request.client else "")[:45],
                    expires_at=now + timedelta(minutes=settings.PASSWORD_RESET_TOKEN_EXPIRE_MINUTES),
                )
            )
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to create password reset link.") from exc

        send_password_reset_email(user.email, reset_link)
        if not settings.is_production:
            response_reset_url = reset_link

    return PasswordResetResult(message=PASSWORD_RESET_MESSAGE, reset_url=response_reset_url)


@router.post("/password/reset", response_model=PasswordResetResult)
def reset_password(payload: PasswordResetConfirm, db: Session = Depends(get_db)) -> PasswordResetResult:
    now = datetime.utcnow()
    record = db.scalar(select(PasswordResetToken).where(PasswordResetToken.token_hash == hash_token(payload.token)))
    if not record or record.used_at or record.revoked_at or record.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password reset link is invalid or expired.")

    user = db.get(User, record.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password reset link is invalid or expired.")

    try:
        user.hashed_password = get_password_hash(payload.password)
        if (user.provider or "").strip().lower() == "google":
            user.provider = "email_google"
        user.updated_at = now
        record.used_at = now
        record.revoked_at = now
        db.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to reset password.") from exc

    return PasswordResetResult(message="Password has been reset. Please log in with your new password.")


@router.post("/google", response_model=Token)
def google_login(
    payload: GoogleTokenRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> Token:
    try:
        identity = verify_google_id_token(payload.id_token)
    except GoogleAuthConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except GoogleEmailNotVerifiedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except GoogleAuthError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    try:
        user_by_google = db.scalar(select(User).where(User.google_id == identity.google_id))
        user_by_email = db.scalar(select(User).where(User.email == identity.email))
        if user_by_google and user_by_email and user_by_google.id != user_by_email.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This Google account is linked to a different Auto-AI account.",
            )

        user = user_by_email or user_by_google
        if user:
            sync_subscription_status(db, user)
            ensure_user_can_authenticate(user)
            if user.google_id and user.google_id != identity.google_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This email is already linked to another Google account.",
                )
            user.google_id = identity.google_id
            user.provider = merged_provider(user.provider)
            user.email = identity.email
            if identity.name and not user.name.strip():
                user.name = identity.name
            if identity.picture:
                user.picture = identity.picture
                user.avatar = identity.picture
        else:
            user = create_google_user(identity)
            db.add(user)
            db.flush()
            sync_subscription_status(db, user)
    except HTTPException:
        raise
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Please log in instead.",
        ) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to complete Google login.") from exc

    return issue_session(db, user, request, response)


@router.post("/refresh", response_model=Token)
def refresh_session(
    request: Request,
    response: Response,
    payload: RefreshRequest | None = Body(default=None),
    db: Session = Depends(get_db),
) -> Token:
    refresh_token = payload.refresh_token if payload else None
    refresh_token = refresh_token or request.cookies.get(REFRESH_TOKEN_COOKIE)
    if not refresh_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token is required.")
    try:
        user, record = user_from_refresh_token(db, refresh_token)
        sync_subscription_status(db, user)
        ensure_user_can_authenticate(user)
        record.revoked_at = datetime.utcnow()
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Unable to refresh session.") from exc
    return issue_session(db, user, request, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    payload: LogoutRequest | None = Body(default=None),
    db: Session = Depends(get_db),
) -> None:
    refresh_token = payload.refresh_token if payload else None
    refresh_token = refresh_token or request.cookies.get(REFRESH_TOKEN_COOKIE)
    try:
        revoke_refresh_token(db, refresh_token)
    except SQLAlchemyError:
        db.rollback()
    clear_auth_cookies(response, request)
    response.status_code = status.HTTP_204_NO_CONTENT


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user
