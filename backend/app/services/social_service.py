from __future__ import annotations

import re
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.call import BlockedUser, UserCallSettings
from app.models.social import SocialFollow, SocialNotification
from app.models.user import User
from app.schemas.social import FollowRequestRead, SocialNotificationRead, SocialProfile
from app.services.call_permission_service import call_allowed


ACCEPTED = "accepted"
PENDING = "pending"
TERMINAL = {"cancelled", "rejected"}


def clean_username(value: str) -> str:
    username = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if len(username) < 3:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username must contain at least 3 characters.")
    return username[:48]


def public_username(user: User) -> str:
    return user.username or f"user_{user.id.replace('-', '')[:8]}"


class SocialService:
    def users_blocked(self, db: Session, first_user_id: str, second_user_id: str) -> bool:
        return db.scalar(
            select(BlockedUser.id).where(
                or_(
                    and_(BlockedUser.blocker_id == first_user_id, BlockedUser.blocked_user_id == second_user_id),
                    and_(BlockedUser.blocker_id == second_user_id, BlockedUser.blocked_user_id == first_user_id),
                )
            )
        ) is not None

    def accepted_follow(self, db: Session, follower_id: str, following_id: str) -> bool:
        return db.scalar(
            select(SocialFollow.id).where(
                SocialFollow.follower_id == follower_id,
                SocialFollow.following_id == following_id,
                SocialFollow.status == ACCEPTED,
            )
        ) is not None

    def mutual_follow(self, db: Session, first_user_id: str, second_user_id: str) -> bool:
        return self.accepted_follow(db, first_user_id, second_user_id) and self.accepted_follow(db, second_user_id, first_user_id)

    def follow_status(self, db: Session, viewer_id: str, target_id: str) -> str:
        if viewer_id == target_id:
            return "self"
        if self.users_blocked(db, viewer_id, target_id):
            return "blocked"
        record = db.scalar(
            select(SocialFollow).where(SocialFollow.follower_id == viewer_id, SocialFollow.following_id == target_id)
        )
        if not record or record.status in TERMINAL:
            return "none"
        return "following" if record.status == ACCEPTED else "pending"

    def can_view_private_profile(self, db: Session, viewer_id: str, target: User) -> bool:
        return viewer_id == target.id or target.profile_visibility != "private" or self.accepted_follow(db, viewer_id, target.id)

    def can_message(self, db: Session, sender_id: str, recipient_id: str) -> bool:
        if sender_id == recipient_id or self.users_blocked(db, sender_id, recipient_id):
            return False
        recipient = db.get(User, recipient_id)
        if not recipient or not recipient.is_active:
            return False
        permission = recipient.message_permission or "followers"
        if permission == "everyone":
            return True
        if permission == "followers":
            return self.accepted_follow(db, sender_id, recipient_id)
        if permission == "mutual_followers":
            return self.mutual_follow(db, sender_id, recipient_id)
        return False

    def profile_for(self, db: Session, target: User, viewer_id: str) -> SocialProfile:
        status_value = self.follow_status(db, viewer_id, target.id)
        blocked = status_value == "blocked"
        private_restricted = not blocked and not self.can_view_private_profile(db, viewer_id, target)
        show_private_fields = not blocked and not private_restricted
        return SocialProfile(
            id=target.id,
            display_name=target.name,
            username=public_username(target),
            avatar_url=target.avatar or target.picture,
            bio=target.bio if show_private_fields else None,
            is_private=target.profile_visibility == "private",
            follow_status=status_value,
            can_message=not blocked and self.can_message(db, viewer_id, target.id),
            can_audio_call=not blocked and call_allowed(db, viewer_id, target.id, "audio")[0],
            can_video_call=not blocked and call_allowed(db, viewer_id, target.id, "video")[0],
            profile_restricted=blocked or private_restricted,
        )

    def search_users(self, db: Session, viewer: User, query: str, page: int, limit: int) -> tuple[list[SocialProfile], bool]:
        normalized = " ".join(query.strip().split())
        if len(normalized) < 2:
            return [], False
        pattern = f"%{normalized.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"
        blocked = select(BlockedUser.id).where(
            or_(
                and_(BlockedUser.blocker_id == viewer.id, BlockedUser.blocked_user_id == User.id),
                and_(BlockedUser.blocker_id == User.id, BlockedUser.blocked_user_id == viewer.id),
            )
        )
        rows = list(
            db.scalars(
                select(User)
                .join(UserCallSettings, UserCallSettings.user_id == User.id, isouter=True)
                .where(
                    User.id != viewer.id,
                    User.is_active == True,  # noqa: E712
                    User.username.is_not(None),
                    User.username != "",
                    or_(User.name.ilike(pattern, escape="\\"), User.username.ilike(pattern, escape="\\")),
                    ~blocked.exists(),
                )
                .order_by(User.name.asc(), User.id.asc())
                .offset((page - 1) * limit)
                .limit(limit + 1)
            )
        )
        return [self.profile_for(db, user, viewer.id) for user in rows[:limit]], len(rows) > limit

    def get_profile(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        target = db.get(User, target_id)
        if not target or not target.is_active:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        if self.users_blocked(db, viewer.id, target.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        return self.profile_for(db, target, viewer.id)

    def create_notification(
        self,
        db: Session,
        *,
        user_id: str,
        actor_id: str | None,
        notification_type: str,
        target_type: str,
        target_id: str | None,
        title: str,
        body: str | None = None,
        dedupe_key: str | None = None,
    ) -> SocialNotification | None:
        key = dedupe_key or f"{notification_type}:{actor_id or 'system'}:{target_type}:{target_id or ''}"
        existing = db.scalar(select(SocialNotification).where(SocialNotification.user_id == user_id, SocialNotification.dedupe_key == key))
        if existing:
            return existing
        record = SocialNotification(
            user_id=user_id,
            actor_id=actor_id,
            notification_type=notification_type,
            target_type=target_type,
            target_id=target_id,
            dedupe_key=key,
            title=title,
            body=body,
        )
        db.add(record)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            return None
        return record

    def follow_or_request(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        if viewer.id == target_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot follow yourself.")
        target = db.get(User, target_id)
        if not target or not target.is_active or self.users_blocked(db, viewer.id, target_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        now = datetime.utcnow()
        next_status = PENDING if target.profile_visibility == "private" else ACCEPTED
        record = db.scalar(select(SocialFollow).where(SocialFollow.follower_id == viewer.id, SocialFollow.following_id == target.id))
        if not record:
            record = SocialFollow(follower_id=viewer.id, following_id=target.id, status=next_status, requested_at=now)
            db.add(record)
        elif record.status != ACCEPTED:
            record.status = next_status
            record.requested_at = now
            record.responded_at = now if next_status == ACCEPTED else None
            record.updated_at = now
        if next_status == ACCEPTED:
            self.create_notification(
                db,
                user_id=target.id,
                actor_id=viewer.id,
                notification_type="follow",
                target_type="profile",
                target_id=viewer.id,
                title=f"{viewer.name} followed you",
                dedupe_key=f"follow:{viewer.id}:{target.id}",
            )
        else:
            self.create_notification(
                db,
                user_id=target.id,
                actor_id=viewer.id,
                notification_type="follow_request",
                target_type="follow_requests",
                target_id=record.id,
                title=f"{viewer.name} requested to follow you",
                dedupe_key=f"follow_request:{viewer.id}:{target.id}:{int(now.timestamp())}",
            )
        db.commit()
        return self.profile_for(db, target, viewer.id)

    def accept_request(self, db: Session, current_user: User, request_id: str) -> SocialProfile:
        record = db.scalar(select(SocialFollow).where(SocialFollow.id == request_id, SocialFollow.following_id == current_user.id, SocialFollow.status == PENDING))
        if not record:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Follow request not found.")
        record.status = ACCEPTED
        record.responded_at = datetime.utcnow()
        record.updated_at = datetime.utcnow()
        self.create_notification(
            db,
            user_id=record.follower_id,
            actor_id=current_user.id,
            notification_type="follow_accept",
            target_type="profile",
            target_id=current_user.id,
            title=f"{current_user.name} accepted your follow request",
            dedupe_key=f"follow_accept:{record.id}",
        )
        db.commit()
        requester = db.get(User, record.follower_id)
        return self.profile_for(db, requester, current_user.id)

    def reject_request(self, db: Session, current_user: User, request_id: str) -> None:
        record = db.scalar(select(SocialFollow).where(SocialFollow.id == request_id, SocialFollow.following_id == current_user.id, SocialFollow.status == PENDING))
        if not record:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Follow request not found.")
        record.status = "rejected"
        record.responded_at = datetime.utcnow()
        record.updated_at = datetime.utcnow()
        db.commit()

    def cancel_request(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        record = db.scalar(select(SocialFollow).where(SocialFollow.follower_id == viewer.id, SocialFollow.following_id == target_id, SocialFollow.status == PENDING))
        if record:
            record.status = "cancelled"
            record.updated_at = datetime.utcnow()
            db.commit()
        target = db.get(User, target_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        return self.profile_for(db, target, viewer.id)

    def unfollow(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        record = db.scalar(select(SocialFollow).where(SocialFollow.follower_id == viewer.id, SocialFollow.following_id == target_id, SocialFollow.status == ACCEPTED))
        if record:
            record.status = "cancelled"
            record.updated_at = datetime.utcnow()
            db.commit()
        target = db.get(User, target_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        return self.profile_for(db, target, viewer.id)

    def remove_follower(self, db: Session, viewer: User, follower_id: str) -> None:
        record = db.scalar(select(SocialFollow).where(SocialFollow.follower_id == follower_id, SocialFollow.following_id == viewer.id, SocialFollow.status == ACCEPTED))
        if record:
            record.status = "cancelled"
            record.updated_at = datetime.utcnow()
            db.commit()

    def requests(self, db: Session, current_user: User, direction: str, page: int, limit: int) -> tuple[list[FollowRequestRead], bool]:
        if direction == "incoming":
            statement = select(SocialFollow, User).join(User, User.id == SocialFollow.follower_id).where(SocialFollow.following_id == current_user.id, SocialFollow.status == PENDING)
            viewer_id = current_user.id
        else:
            statement = select(SocialFollow, User).join(User, User.id == SocialFollow.following_id).where(SocialFollow.follower_id == current_user.id, SocialFollow.status == PENDING)
            viewer_id = current_user.id
        rows = list(db.execute(statement.order_by(SocialFollow.requested_at.desc()).offset((page - 1) * limit).limit(limit + 1)).all())
        return [
            FollowRequestRead(id=record.id, requested_at=record.requested_at, user=self.profile_for(db, user, viewer_id))
            for record, user in rows[:limit]
        ], len(rows) > limit

    def unread_count(self, db: Session, user_id: str) -> int:
        return int(db.scalar(select(func.count(SocialNotification.id)).where(SocialNotification.user_id == user_id, SocialNotification.read_at.is_(None))) or 0)

    def notifications(self, db: Session, current_user: User, page: int, limit: int) -> tuple[list[SocialNotificationRead], bool, int]:
        rows = list(
            db.scalars(
                select(SocialNotification)
                .where(SocialNotification.user_id == current_user.id)
                .order_by(SocialNotification.created_at.desc())
                .offset((page - 1) * limit)
                .limit(limit + 1)
            )
        )
        items = []
        for record in rows[:limit]:
            actor = db.get(User, record.actor_id) if record.actor_id else None
            items.append(
                SocialNotificationRead(
                    id=record.id,
                    notification_type=record.notification_type,
                    target_type=record.target_type,
                    target_id=record.target_id,
                    title=record.title,
                    body=record.body,
                    read_at=record.read_at,
                    created_at=record.created_at,
                    actor=self.profile_for(db, actor, current_user.id) if actor and not self.users_blocked(db, current_user.id, actor.id) else None,
                )
            )
        return items, len(rows) > limit, self.unread_count(db, current_user.id)

    def mark_notification_read(self, db: Session, current_user: User, notification_id: str | None = None) -> None:
        now = datetime.utcnow()
        statement = select(SocialNotification).where(SocialNotification.user_id == current_user.id)
        if notification_id:
            statement = statement.where(SocialNotification.id == notification_id)
        records = list(db.scalars(statement))
        if notification_id and not records:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
        for record in records:
            record.read_at = record.read_at or now
        db.commit()


social_service = SocialService()
