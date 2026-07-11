from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.models.call import BlockedUser, Call, UserCallSettings
from app.models.social import SocialFollow


CONTACT_STATUSES = {"accepted", "connecting", "active", "ended"}


def get_or_create_call_settings(db: Session, user_id: str) -> UserCallSettings:
    record = db.scalar(select(UserCallSettings).where(UserCallSettings.user_id == user_id))
    if record:
        return record
    record = UserCallSettings(
        user_id=user_id,
        is_discoverable=True,
        show_online_status=True,
        show_last_seen=True,
    )
    db.add(record)
    db.flush()
    return record


def users_blocked(db: Session, first_user_id: str, second_user_id: str) -> bool:
    return bool(
        db.scalar(
            select(BlockedUser.id).where(
                or_(
                    and_(BlockedUser.blocker_id == first_user_id, BlockedUser.blocked_user_id == second_user_id),
                    and_(BlockedUser.blocker_id == second_user_id, BlockedUser.blocked_user_id == first_user_id),
                )
            )
        )
    )


def previously_contacted(db: Session, first_user_id: str, second_user_id: str) -> bool:
    return bool(
        db.scalar(
            select(Call.id).where(
                or_(
                    and_(Call.caller_id == first_user_id, Call.callee_id == second_user_id),
                    and_(Call.caller_id == second_user_id, Call.callee_id == first_user_id),
                ),
                Call.status.in_(CONTACT_STATUSES),
            ).limit(1)
        )
    )


def accepted_follow(db: Session, follower_id: str, following_id: str) -> bool:
    return bool(
        db.scalar(
            select(SocialFollow.id).where(
                SocialFollow.follower_id == follower_id,
                SocialFollow.following_id == following_id,
                SocialFollow.status == "accepted",
            )
        )
    )


def mutual_follow(db: Session, first_user_id: str, second_user_id: str) -> bool:
    return accepted_follow(db, first_user_id, second_user_id) and accepted_follow(db, second_user_id, first_user_id)


def call_allowed(db: Session, caller_id: str, callee_id: str, call_type: str) -> tuple[bool, bool]:
    if users_blocked(db, caller_id, callee_id):
        return False, False
    settings_record = get_or_create_call_settings(db, callee_id)
    if call_type == "video" and not settings_record.allow_video_calls:
        return False, False
    if call_type == "audio" and not settings_record.allow_audio_calls:
        return False, False
    known = previously_contacted(db, caller_id, callee_id)
    if settings_record.call_permission == "nobody":
        return False, known
    if settings_record.call_permission == "followers" and not accepted_follow(db, caller_id, callee_id):
        return False, known
    if settings_record.call_permission == "mutual_followers" and not mutual_follow(db, caller_id, callee_id):
        return False, known
    if settings_record.call_permission == "approved_contacts" and not accepted_follow(db, caller_id, callee_id):
        return False, known
    if settings_record.call_permission == "previous_contacts" and not known:
        return False, known
    return True, known
