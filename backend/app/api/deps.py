from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.user import User


bearer_scheme = HTTPBearer(auto_error=False)
ACCESS_TOKEN_COOKIE = "auto_ai_access_token"
REFRESH_TOKEN_COOKIE = "auto_ai_refresh_token"


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    token = credentials.credentials if credentials else request.cookies.get(ACCESS_TOKEN_COOKIE)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = decode_access_token(token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.get(User, user_id)
    if not user or not user.is_active or (user.subscription_status or "").lower() in {"blocked", "suspended"}:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Inactive user",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in {"admin", "super_admin", "administrator"} or not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


def get_current_cms_viewer(current_user: User = Depends(get_current_user)) -> User:
    from app.services.cms_service import CMS_VIEW_ROLES

    if current_user.role not in CMS_VIEW_ROLES or not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Content Manager access required")
    return current_user


def get_current_cms_editor(current_user: User = Depends(get_current_cms_viewer)) -> User:
    from app.services.cms_service import CMS_EDIT_ROLES

    if current_user.role not in CMS_EDIT_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Content edit permission required")
    return current_user


def get_current_cms_publisher(current_user: User = Depends(get_current_cms_viewer)) -> User:
    from app.services.cms_service import CMS_PUBLISH_ROLES

    if current_user.role not in CMS_PUBLISH_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Content publish permission required")
    return current_user
