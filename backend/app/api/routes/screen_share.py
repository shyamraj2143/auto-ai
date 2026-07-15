from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.schemas.screen_share import ScreenShareSessionCreate, ScreenShareSessionRead, ScreenShareTicket
from app.services.presence_service import presence_service
from app.services.screen_share_service import screen_share_event, screen_share_service


router = APIRouter(prefix="/screen-share", tags=["screen-share"])


@router.post("/session", response_model=ScreenShareSessionRead, status_code=201)
async def create_screen_share_session(
    payload: ScreenShareSessionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ScreenShareSessionRead:
    session, invite_token = screen_share_service.create(
        db,
        current_user,
        viewer_user_id=payload.viewer_user_id,
        invite_link=payload.invite_link,
        expires_minutes=payload.expires_minutes,
    )
    invite_link = screen_share_service.invite_link(session.session_id, invite_token) if invite_token else None
    await screen_share_service.notify_created(db, session, current_user, invite_link)
    return screen_share_service.serialize(session, invite_token)


@router.get("/session/{session_id}", response_model=ScreenShareSessionRead)
def get_screen_share_session(
    session_id: str,
    invite: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ScreenShareSessionRead:
    session = screen_share_service.get_authorized(
        db, session_id, current_user.id, invite_token=invite, allow_claim=bool(invite)
    )
    return screen_share_service.serialize(session)


@router.post("/session/{session_id}/end", response_model=ScreenShareSessionRead)
async def end_screen_share_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ScreenShareSessionRead:
    session = screen_share_service.end(db, session_id, current_user.id)
    for user_id in {session.sharer_user_id, session.viewer_user_id} - {None}:
        await presence_service.publish(
            str(user_id),
            screen_share_event(
                "screen-share-ended",
                sender_user_id=current_user.id,
                session_id=session.session_id,
                payload={"status": session.status},
            ),
        )
    return screen_share_service.serialize(session)


@router.post("/ws-ticket", response_model=ScreenShareTicket)
async def create_screen_share_ws_ticket(current_user: User = Depends(get_current_user)) -> ScreenShareTicket:
    ticket = await presence_service.create_ticket(current_user.id)
    return ScreenShareTicket(ticket=ticket, expires_in=settings.CALL_WS_TICKET_TTL_SECONDS)
