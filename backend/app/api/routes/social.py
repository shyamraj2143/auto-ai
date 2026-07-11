from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.call import BlockedUser
from app.models.user import User
from app.schemas.social import (
    DirectConversationRead,
    FollowRequestPage,
    ProfileUpdateRequest,
    SocialNotificationPage,
    SocialProfile,
    SocialUserPage,
)
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.social_service import clean_username, social_service
from app.services.user_chat_service import user_chat_service


router = APIRouter(prefix="/social", tags=["social"])


@router.get("/users", response_model=SocialUserPage)
async def search_users(
    query: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1, le=10000),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SocialUserPage:
    try:
        allowed = await presence_service.allow_rate("social_search", current_user.id, settings.CALL_SEARCH_MAX_PER_MINUTE)
    except RealtimeUnavailable:
        allowed = True
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many user searches.")
    items, has_more = social_service.search_users(db, current_user, query, page, limit)
    return SocialUserPage(items=items, page=page, limit=limit, has_more=has_more, unread_notifications=social_service.unread_count(db, current_user.id))


@router.get("/me", response_model=SocialProfile)
def my_profile(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.profile_for(db, current_user, current_user.id)


@router.patch("/me", response_model=SocialProfile)
def update_profile(
    payload: ProfileUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SocialProfile:
    if payload.display_name is not None:
        current_user.name = payload.display_name.strip()
    if payload.username is not None:
        username = clean_username(payload.username)
        existing_id = db.scalar(select(User.id).where(func.lower(User.username) == username, User.id != current_user.id))
        if existing_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username is already taken.")
        current_user.username = username
    if payload.bio is not None:
        current_user.bio = payload.bio.strip() or None
    if payload.profile_visibility is not None:
        current_user.profile_visibility = payload.profile_visibility
    if payload.message_permission is not None:
        current_user.message_permission = payload.message_permission
    current_user.profile_updated_at = datetime.utcnow()
    db.commit()
    db.refresh(current_user)
    return social_service.profile_for(db, current_user, current_user.id)


@router.get("/users/{user_id}", response_model=SocialProfile)
def get_profile(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.get_profile(db, current_user, user_id[:64])


@router.post("/users/{user_id}/follow", response_model=SocialProfile)
def follow_user(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.follow_or_request(db, current_user, user_id[:64])


@router.post("/requests/{request_id}/accept", response_model=SocialProfile)
def accept_request(request_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.accept_request(db, current_user, request_id[:64])


@router.post("/requests/{request_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
def reject_request(request_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    social_service.reject_request(db, current_user, request_id[:64])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/users/{user_id}/cancel-request", response_model=SocialProfile)
def cancel_request(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.cancel_request(db, current_user, user_id[:64])


@router.delete("/users/{user_id}/follow", response_model=SocialProfile)
def unfollow(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> SocialProfile:
    return social_service.unfollow(db, current_user, user_id[:64])


@router.delete("/followers/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_follower(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    social_service.remove_follower(db, current_user, user_id[:64])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/users/{user_id}/block", status_code=status.HTTP_204_NO_CONTENT)
def block_user(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    target_id = user_id[:64]
    if target_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot block yourself.")
    if not db.get(User, target_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    existing = db.scalar(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_user_id == target_id))
    if not existing:
        db.add(BlockedUser(blocker_id=current_user.id, blocked_user_id=target_id))
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/users/{user_id}/block", status_code=status.HTTP_204_NO_CONTENT)
def unblock_user(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    record = db.scalar(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_user_id == user_id[:64]))
    if record:
        db.delete(record)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/requests/incoming", response_model=FollowRequestPage)
def incoming_requests(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=30, ge=1, le=80),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FollowRequestPage:
    items, has_more = social_service.requests(db, current_user, "incoming", page, limit)
    return FollowRequestPage(items=items, page=page, limit=limit, has_more=has_more)


@router.get("/requests/sent", response_model=FollowRequestPage)
def sent_requests(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=30, ge=1, le=80),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> FollowRequestPage:
    items, has_more = social_service.requests(db, current_user, "sent", page, limit)
    return FollowRequestPage(items=items, page=page, limit=limit, has_more=has_more)


@router.get("/notifications", response_model=SocialNotificationPage)
def notifications(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=30, ge=1, le=80),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SocialNotificationPage:
    items, has_more, unread = social_service.notifications(db, current_user, page, limit)
    return SocialNotificationPage(items=items, page=page, limit=limit, has_more=has_more, unread_count=unread)


@router.post("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def read_notification(notification_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    social_service.mark_notification_read(db, current_user, notification_id[:64])
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT)
def read_all_notifications(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> Response:
    social_service.mark_notification_read(db, current_user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/users/{user_id}/conversation", response_model=DirectConversationRead, status_code=status.HTTP_201_CREATED)
def open_conversation(user_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)) -> DirectConversationRead:
    if not social_service.can_message(db, current_user.id, user_id[:64]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Follow approval is required before messaging this user.")
    thread = user_chat_service.create_or_get_thread(db, current_user, user_id[:64])
    return DirectConversationRead(thread_id=thread.id)
