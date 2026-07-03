from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.security import create_access_token, get_password_hash, password_needs_rehash, verify_password
from app.db.session import get_db
from app.models.user import User
from app.repositories.sqlalchemy import SQLAlchemyUserRepository
from app.schemas.auth import Token, UserCreate, UserLogin, UserRead


router = APIRouter(prefix="/auth", tags=["auth"])


def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_mobile(mobile: str | None) -> str | None:
    if not mobile:
        return None
    normalized = "".join(char for char in mobile.strip() if char.isdigit() or char == "+")
    return normalized or None


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> Token:
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

    user_count = db.scalar(select(func.count()).select_from(User)) or 0
    is_admin = user_count == 0 or email in settings.ADMIN_EMAILS
    role = "admin" if is_admin else "user"
    try:
        user = repo.create(
            email=email,
            mobile=mobile,
            name=payload.name,
            hashed_password=get_password_hash(payload.password),
            is_admin=is_admin,
            role=role,
        )
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email or mobile number already exists. Please log in instead.",
        ) from exc
    return Token(access_token=create_access_token(user.id), user=UserRead.model_validate(user))


@router.post("/login", response_model=Token)
def login(payload: UserLogin, db: Session = Depends(get_db)) -> Token:
    repo = SQLAlchemyUserRepository(db)
    user = repo.get_by_email(normalize_email(str(payload.email)))
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Email or password is incorrect.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is disabled.")
    if password_needs_rehash(user.hashed_password):
        user.hashed_password = get_password_hash(payload.password)
        db.commit()
        db.refresh(user)
    return Token(access_token=create_access_token(user.id), user=UserRead.model_validate(user))


@router.post("/admin-login", response_model=Token)
def admin_login(payload: UserLogin, db: Session = Depends(get_db)) -> Token:
    repo = SQLAlchemyUserRepository(db)
    user = repo.get_by_email(normalize_email(str(payload.email)))
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin email or password is incorrect.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This admin account is disabled.")
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admin accounts can access the admin dashboard.")
    if password_needs_rehash(user.hashed_password):
        user.hashed_password = get_password_hash(payload.password)
        db.commit()
        db.refresh(user)
    return Token(access_token=create_access_token(user.id), user=UserRead.model_validate(user))


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user
