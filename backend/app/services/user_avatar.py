from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import settings

if TYPE_CHECKING:
    from app.models.user import User


def _stored_profile_avatar_exists(value: str) -> bool:
    if not value.startswith("/uploads/profile/"):
        return True
    root = (Path(settings.UPLOAD_DIR) / "profile").resolve()
    candidate = (root / Path(value).name).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return candidate.is_file()


def public_avatar(user: "User") -> str:
    avatar = (user.avatar or "").strip()[:500]
    if avatar and _stored_profile_avatar_exists(avatar):
        return avatar
    return (user.picture or "").strip()[:500]
