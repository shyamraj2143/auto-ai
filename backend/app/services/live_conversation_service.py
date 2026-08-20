import json

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.api_usage import APIUsage
from app.models.live import LiveMessage, LiveSession
from app.models.user import User
from app.services.admin_control import billable_usage, enforce_user_quota, infer_provider_from_model, track_quota_usage
from app.services.groq_service import groq_service
from app.services.live_vision_service import VisualContext


def live_system_prompt(language: str | None, camera_available: bool) -> str:
    language_hint = language or "auto"
    camera_rule = (
        "A recent private camera summary is supplied when relevant. Use it naturally without exposing "
        "analysis metadata."
        if camera_available
        else "No recent camera frame exists. Never claim that you can see the user or scene."
    )
    return (
        "You are Zara in a live voice call. Reply in the user's language: Hindi, Hinglish, or English. "
        "Keep replies natural and brief, usually one or two spoken sentences. Give one or two steps at "
        "a time. Do not use markdown. Ask a follow-up only when useful. "
        f"Language hint: {language_hint}. {camera_rule}"
    )


class LiveConversationService:
    def answer(
        self,
        db: Session,
        *,
        user: User,
        session: LiveSession,
        transcript: str,
        language: str | None,
        provider: str | None,
        model: str | None,
        visual_context: VisualContext | None,
    ) -> tuple[str, str, str]:
        text = transcript.strip()
        if not text:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript is required.")
        history = list(
            reversed(
                db.scalars(
                    select(LiveMessage)
                    .where(LiveMessage.session_id == session.id)
                    .order_by(LiveMessage.created_at.desc())
                    .limit(5)
                ).all()
            )
        )
        messages: list[dict] = [
            {
                "role": "system",
                "content": live_system_prompt(language, bool(visual_context and visual_context.summary)),
            }
        ]
        for item in history:
            if item.transcript:
                messages.append({"role": "user", "content": item.transcript})
            if item.response_text:
                messages.append({"role": "assistant", "content": item.response_text})
        if visual_context and visual_context.summary:
            messages.append(
                {
                    "role": "system",
                    "content": f"Private current camera context: {visual_context.summary}",
                }
            )
        messages.append({"role": "user", "content": text})
        estimated_input = max(1, len(json.dumps(messages, ensure_ascii=False)) // 4)
        enforce_user_quota(db, user, estimated_input_tokens=estimated_input)
        selected_provider = groq_service.selected_provider(provider)
        selected_model = groq_service.selected_model(model, provider=selected_provider, web_search=False)
        response, usage, used_model = groq_service.complete(
            messages,
            model=selected_model,
            provider=selected_provider,
            web_search=False,
            max_tokens=240,
            request_timeout=45,
                    )
        response = response.strip()
        if not response:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Live response was empty.")
        message = LiveMessage(
            session_id=session.id,
            user_id=user.id,
            role="assistant",
            transcript=text,
            response_text=response,
        )
        db.add(message)
        charged_usage = billable_usage()
        input_tokens = charged_usage["prompt_tokens"]
        output_tokens = charged_usage["completion_tokens"]
        db.add(
            APIUsage(
                user_id=user.id,
                endpoint="live_message",
                provider=infer_provider_from_model(used_model),
                model=used_model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                prompt_tokens=input_tokens,
                completion_tokens=output_tokens,
                total_tokens=charged_usage["total_tokens"],
            )
        )
        track_quota_usage(db, user.id)
        db.commit()
        db.refresh(message)
        return response, used_model, message.id


live_conversation_service = LiveConversationService()
