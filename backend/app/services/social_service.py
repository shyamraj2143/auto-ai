from __future__ import annotations

import re
import logging
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.call import BlockedUser, UserCallSettings
from app.models.social import SearchHistory, SocialFollow, SocialNotification
from app.models.user import User
from app.schemas.social import FollowRequestRead, SearchHistoryRead, SocialNotificationRead, SocialProfile
from app.services.call_permission_service import call_allowed
from app.services.social_notification_service import send_social_push_notification


ACCEPTED = "accepted"
PENDING = "pending"
REJECTED = "rejected"
CANCELLED = "cancelled"
DISCONNECTED = "disconnected"
BLOCKED = "blocked"
TERMINAL = {CANCELLED, REJECTED, DISCONNECTED, BLOCKED}
ACTIVE_STATUSES = {PENDING, ACCEPTED}
logger = logging.getLogger(__name__)


def pair_key(first_user_id: str, second_user_id: str) -> str:
    return ":".join(sorted([first_user_id, second_user_id]))


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

    def relationship_between(self, db: Session, first_user_id: str, second_user_id: str) -> SocialFollow | None:
        key = pair_key(first_user_id, second_user_id)
        record = db.scalar(
            select(SocialFollow)
            .where(SocialFollow.pair_key == key)
            .order_by(SocialFollow.updated_at.desc(), SocialFollow.created_at.desc())
            .limit(1)
        )
        if record:
            return record
        return db.scalar(
            select(SocialFollow)
            .where(
                or_(
                    and_(SocialFollow.follower_id == first_user_id, SocialFollow.following_id == second_user_id),
                    and_(SocialFollow.follower_id == second_user_id, SocialFollow.following_id == first_user_id),
                )
            )
            .order_by(SocialFollow.updated_at.desc(), SocialFollow.created_at.desc())
            .limit(1)
        )

    def accepted_connection(self, db: Session, first_user_id: str, second_user_id: str) -> bool:
        key = pair_key(first_user_id, second_user_id)
        return bool(
            db.scalar(
                select(SocialFollow.id)
                .where(
                    or_(
                        SocialFollow.pair_key == key,
                        and_(SocialFollow.follower_id == first_user_id, SocialFollow.following_id == second_user_id),
                        and_(SocialFollow.follower_id == second_user_id, SocialFollow.following_id == first_user_id),
                    ),
                    SocialFollow.status == ACCEPTED,
                )
                .limit(1)
            )
        )

    def accepted_follow(self, db: Session, follower_id: str, following_id: str) -> bool:
        return self.accepted_connection(db, follower_id, following_id)

    def mutual_follow(self, db: Session, first_user_id: str, second_user_id: str) -> bool:
        return self.accepted_connection(db, first_user_id, second_user_id)

    def follow_status(self, db: Session, viewer_id: str, target_id: str) -> str:
        if viewer_id == target_id:
            return "self"
        if self.users_blocked(db, viewer_id, target_id):
            return "blocked"
        if self.accepted_connection(db, viewer_id, target_id):
            return "following"
        record = self.relationship_between(db, viewer_id, target_id)
        if not record:
            return "none"
        if record.status == PENDING:
            return "pending_sent" if record.follower_id == viewer_id else "pending_received"
        if record.status in {REJECTED, CANCELLED, DISCONNECTED}:
            return record.status
        return "none"

    def can_view_private_profile(self, db: Session, viewer_id: str, target: User) -> bool:
        return viewer_id == target.id or target.profile_visibility != "private" or self.accepted_connection(db, viewer_id, target.id)

    def can_message(self, db: Session, sender_id: str, recipient_id: str) -> bool:
        if sender_id == recipient_id or self.users_blocked(db, sender_id, recipient_id):
            return False
        sender = db.get(User, sender_id)
        if not sender or not sender.is_active:
            return False
        recipient = db.get(User, recipient_id)
        if not recipient or not recipient.is_active:
            return False
        return self.accepted_connection(db, sender_id, recipient_id)

    def profile_for(self, db: Session, target: User, viewer_id: str) -> SocialProfile:
        status_value = self.follow_status(db, viewer_id, target.id)
        relationship = None if viewer_id == target.id else self.relationship_between(db, viewer_id, target.id)
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
            request_id=relationship.id if relationship and relationship.status == PENDING else None,
            requested_by_me=bool(relationship and relationship.status == PENDING and relationship.follower_id == viewer_id),
            requested_by_them=bool(relationship and relationship.status == PENDING and relationship.following_id == viewer_id),
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
        dispatch_push: bool = True,
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
            actor = db.get(User, actor_id) if actor_id else None
            if dispatch_push and notification_type in {"follow_request", "follow_accept"}:
                try:
                    send_social_push_notification(db, record, actor)
                except Exception:
                    logger.exception("social_push_delivery_failed notification_type=%s notification_id=%s", notification_type, record.id)
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
        key = pair_key(viewer.id, target.id)
        record = self.relationship_between(db, viewer.id, target.id)
        if record and record.status == PENDING and record.following_id == viewer.id:
            return self.profile_for(db, target, viewer.id)
        if record and record.status == ACCEPTED:
            return self.profile_for(db, target, viewer.id)
        if not record:
            record = SocialFollow(follower_id=viewer.id, following_id=target.id, pair_key=key, status=PENDING, requested_at=now)
            db.add(record)
            db.flush()
        elif record.status not in ACTIVE_STATUSES:
            record.follower_id = viewer.id
            record.following_id = target.id
            record.pair_key = key
            record.status = PENDING
            record.requested_at = now
            record.responded_at = None
            record.responder_user_id = None
            record.cancelled_at = None
            record.disconnected_at = None
            record.rejection_reason_category = None
            record.updated_at = now
        else:
            return self.profile_for(db, target, viewer.id)
        db.commit()
        notification = self.create_notification(
            db,
            user_id=target.id,
            actor_id=viewer.id,
            notification_type="follow_request",
            target_type="follow_requests",
            target_id=record.id,
            title=f"{viewer.name} requested to follow you",
            dedupe_key=f"follow_request:{record.id}:{target.id}",
            dispatch_push=False,
        )
        db.commit()
        if notification:
            try:
                send_social_push_notification(db, notification, viewer)
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("follow_request_push_failed notification_id=%s", notification.id)
        return self.profile_for(db, target, viewer.id)

    def accept_request(self, db: Session, current_user: User, request_id: str) -> SocialProfile:
        record = db.scalar(select(SocialFollow).where(SocialFollow.id == request_id))
        if not record:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Follow request not found.")
        if record.following_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the request receiver can accept it.")
        if record.status == ACCEPTED:
            requester = db.get(User, record.follower_id)
            return self.profile_for(db, requester, current_user.id)
        if record.status != PENDING:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Follow request is no longer pending.")
        record.status = ACCEPTED
        now = datetime.utcnow()
        record.responded_at = now
        record.responder_user_id = current_user.id
        record.updated_at = now
        record.pair_key = record.pair_key or pair_key(record.follower_id, record.following_id)
        db.commit()
        db.refresh(record)
        requester = db.get(User, record.follower_id)
        notification = self.create_notification(
            db,
            user_id=record.follower_id,
            actor_id=current_user.id,
            notification_type="follow_accept",
            target_type="profile",
            target_id=current_user.id,
            title=f"{current_user.name} accepted your follow request",
            dedupe_key=f"follow_accept:{record.id}",
            dispatch_push=False,
        )
        db.commit()
        if notification:
            try:
                send_social_push_notification(db, notification, current_user)
                db.commit()
            except Exception:
                db.rollback()
                logger.exception("follow_accept_push_failed notification_id=%s", notification.id)
        return self.profile_for(db, requester, current_user.id)

    def reject_request(self, db: Session, current_user: User, request_id: str, reason_category: str | None = None) -> None:
        record = db.scalar(select(SocialFollow).where(SocialFollow.id == request_id))
        if not record:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Follow request not found.")
        if record.following_id != current_user.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the request receiver can reject it.")
        if record.status != PENDING:
            return
        now = datetime.utcnow()
        record.status = REJECTED
        record.responded_at = now
        record.responder_user_id = current_user.id
        record.rejection_reason_category = (reason_category or "not_shared")[:32]
        record.updated_at = now
        db.commit()

    def cancel_request(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        record = self.relationship_between(db, viewer.id, target_id)
        if record and record.status == PENDING and record.follower_id != viewer.id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the request sender can cancel it.")
        if record:
            record.status = CANCELLED
            now = datetime.utcnow()
            record.cancelled_at = now
            record.updated_at = now
            db.commit()
        target = db.get(User, target_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        return self.profile_for(db, target, viewer.id)

    def unfollow(self, db: Session, viewer: User, target_id: str) -> SocialProfile:
        record = self.relationship_between(db, viewer.id, target_id)
        if record:
            if record.status == ACCEPTED:
                record.status = DISCONNECTED
                now = datetime.utcnow()
                record.disconnected_at = now
                record.updated_at = now
            elif record.status == PENDING and record.follower_id == viewer.id:
                record.status = CANCELLED
                record.cancelled_at = datetime.utcnow()
                record.updated_at = datetime.utcnow()
            db.commit()
        target = db.get(User, target_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        return self.profile_for(db, target, viewer.id)

    def remove_follower(self, db: Session, viewer: User, follower_id: str) -> None:
        record = self.relationship_between(db, viewer.id, follower_id)
        if record and record.status == ACCEPTED:
            record.status = DISCONNECTED
            now = datetime.utcnow()
            record.disconnected_at = now
            record.updated_at = now
            db.commit()

    def requests(self, db: Session, current_user: User, direction: str, page: int, limit: int) -> tuple[list[FollowRequestRead], bool]:
        if direction == "incoming":
            statement = select(SocialFollow, User).join(User, User.id == SocialFollow.follower_id).where(SocialFollow.following_id == current_user.id, SocialFollow.status == PENDING)
            viewer_id = current_user.id
        elif direction == "sent":
            statement = select(SocialFollow, User).join(User, User.id == SocialFollow.following_id).where(SocialFollow.follower_id == current_user.id, SocialFollow.status == PENDING)
            viewer_id = current_user.id
        else:
            statement = (
                select(SocialFollow, User)
                .join(
                    User,
                    or_(
                        and_(SocialFollow.follower_id == current_user.id, User.id == SocialFollow.following_id),
                        and_(SocialFollow.following_id == current_user.id, User.id == SocialFollow.follower_id),
                    ),
                )
                .where(
                    or_(SocialFollow.follower_id == current_user.id, SocialFollow.following_id == current_user.id),
                    SocialFollow.status.in_([ACCEPTED, REJECTED, CANCELLED, DISCONNECTED]),
                )
            )
            viewer_id = current_user.id
        rows = list(db.execute(statement.order_by(SocialFollow.requested_at.desc()).offset((page - 1) * limit).limit(limit + 1)).all())
        items: list[FollowRequestRead] = []
        for record, user in rows[:limit]:
            responder = db.get(User, record.responder_user_id) if record.responder_user_id else None
            label = None
            if record.status == ACCEPTED and responder:
                label = f"You accepted @{public_username(user)}" if responder.id == current_user.id else f"Accepted by @{public_username(responder)}"
            items.append(
                FollowRequestRead(
                    id=record.id,
                    status=record.status,
                    requested_at=record.requested_at,
                    responded_at=record.responded_at,
                    actor_label=label,
                    user=self.profile_for(db, user, viewer_id),
                )
            )
        return items, len(rows) > limit

    def accepted_connections(self, db: Session, current_user: User, query: str, page: int, limit: int) -> tuple[list[SocialProfile], bool]:
        normalized = " ".join(query.strip().split())
        escaped = normalized.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        statement = (
            select(SocialFollow, User)
            .join(
                User,
                or_(
                    and_(SocialFollow.follower_id == current_user.id, User.id == SocialFollow.following_id),
                    and_(SocialFollow.following_id == current_user.id, User.id == SocialFollow.follower_id),
                ),
            )
            .where(
                SocialFollow.status == ACCEPTED,
                or_(SocialFollow.follower_id == current_user.id, SocialFollow.following_id == current_user.id),
                User.is_active == True,  # noqa: E712
            )
        )
        if normalized:
            statement = statement.where(or_(User.name.ilike(pattern, escape="\\"), User.username.ilike(pattern, escape="\\")))
        rows = list(db.execute(statement.order_by(User.name.asc(), User.id.asc()).offset((page - 1) * limit).limit(limit + 1)).all())
        return [self.profile_for(db, user, current_user.id) for _, user in rows[:limit]], len(rows) > limit

    def block_user(self, db: Session, current_user: User, target_id: str) -> None:
        if target_id == current_user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot block yourself.")
        if not db.get(User, target_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        existing = db.scalar(select(BlockedUser).where(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_user_id == target_id))
        now = datetime.utcnow()
        if not existing:
            db.add(BlockedUser(blocker_id=current_user.id, blocked_user_id=target_id))
        record = self.relationship_between(db, current_user.id, target_id)
        if record and record.status in ACTIVE_STATUSES:
            record.status = BLOCKED
            record.responded_at = record.responded_at or now
            record.responder_user_id = current_user.id
            record.updated_at = now
        db.execute(
            update(SocialFollow)
            .where(
                or_(
                    and_(SocialFollow.follower_id == current_user.id, SocialFollow.following_id == target_id),
                    and_(SocialFollow.follower_id == target_id, SocialFollow.following_id == current_user.id),
                    SocialFollow.pair_key == pair_key(current_user.id, target_id),
                ),
                SocialFollow.status == PENDING,
            )
            .values(status=BLOCKED, responder_user_id=current_user.id, responded_at=now, updated_at=now)
        )
        db.commit()

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

    def delete_notification(self, db: Session, current_user: User, notification_id: str | None = None) -> None:
        statement = delete(SocialNotification).where(SocialNotification.user_id == current_user.id)
        if notification_id:
            statement = statement.where(SocialNotification.id == notification_id)
        result = db.execute(statement)
        if notification_id and not result.rowcount:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
        db.commit()

    def search_history(self, db: Session, current_user: User) -> list[SearchHistoryRead]:
        records = list(db.scalars(select(SearchHistory).where(SearchHistory.user_id == current_user.id).order_by(SearchHistory.created_at.desc()).limit(20)))
        items: list[SearchHistoryRead] = []
        for record in records:
            selected = db.get(User, record.selected_user_id) if record.selected_user_id else None
            items.append(SearchHistoryRead(
                id=record.id,
                query=record.query,
                selected_user_id=record.selected_user_id,
                created_at=record.created_at,
                selected_user=self.profile_for(db, selected, current_user.id) if selected and not self.users_blocked(db, current_user.id, selected.id) else None,
            ))
        return items

    def add_search_history(self, db: Session, current_user: User, query: str, selected_user_id: str | None) -> SearchHistoryRead:
        normalized = " ".join(query.strip().split())[:80]
        if len(normalized) < 2:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Search query must contain at least 2 characters.")
        if selected_user_id and (selected_user_id == current_user.id or not db.get(User, selected_user_id)):
            selected_user_id = None
        latest = db.scalar(select(SearchHistory).where(SearchHistory.user_id == current_user.id).order_by(SearchHistory.created_at.desc()).limit(1))
        if latest and latest.query.casefold() == normalized.casefold() and latest.selected_user_id == selected_user_id:
            latest.created_at = datetime.utcnow()
            record = latest
        else:
            record = SearchHistory(user_id=current_user.id, query=normalized, selected_user_id=selected_user_id)
            db.add(record)
        db.flush()
        keep_ids = list(db.scalars(select(SearchHistory.id).where(SearchHistory.user_id == current_user.id).order_by(SearchHistory.created_at.desc()).limit(20)))
        if keep_ids:
            db.execute(delete(SearchHistory).where(SearchHistory.user_id == current_user.id, ~SearchHistory.id.in_(keep_ids)))
        db.commit()
        db.refresh(record)
        selected = db.get(User, record.selected_user_id) if record.selected_user_id else None
        return SearchHistoryRead(id=record.id, query=record.query, selected_user_id=record.selected_user_id, created_at=record.created_at, selected_user=self.profile_for(db, selected, current_user.id) if selected else None)

    def delete_search_history(self, db: Session, current_user: User, history_id: str | None = None) -> None:
        statement = delete(SearchHistory).where(SearchHistory.user_id == current_user.id)
        if history_id:
            statement = statement.where(SearchHistory.id == history_id)
        result = db.execute(statement)
        if history_id and not result.rowcount:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Search history item not found.")
        db.commit()


social_service = SocialService()
