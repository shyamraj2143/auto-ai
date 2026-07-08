from datetime import datetime

from pydantic import BaseModel, Field


class LiveSessionStartResponse(BaseModel):
    session_id: str
    status: str
    started_at: datetime


class LiveMessageRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=36)
    text: str = Field(default="", max_length=20000)
    transcript: str | None = Field(default=None, max_length=20000)
    camera_context_id: str | None = Field(default=None, max_length=36)
    image_frame_id: str | None = Field(default=None, max_length=36)
    provider: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=160)
    language: str | None = Field(default=None, max_length=40)


class LiveMessageResponse(BaseModel):
    session_id: str
    message_id: str
    response_text: str
    model: str
    answer: str
    status: str


class VisionAnalyzeResponse(BaseModel):
    frame_id: str
    analysis_summary: str
    image_url: str
    model: str


class LiveSessionEndRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=36)


class LiveSessionEndResponse(BaseModel):
    session_id: str
    status: str
    ended_at: datetime


class FaceMemoryStatusResponse(BaseModel):
    enabled: bool
    consent_given: bool
    updated_at: datetime | None = None
