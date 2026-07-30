from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


FeedbackReason = Literal[
    "incorrect",
    "not_helpful",
    "outdated",
    "ignored_instructions",
    "poor_writing",
    "unsafe",
    "other",
]


class MessageFeedbackWrite(BaseModel):
    rating: Literal[-1, 1]
    reason: FeedbackReason | None = None
    comment: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_matches_rating(cls, value: FeedbackReason | None, info):
        if info.data.get("rating") == 1 and value is not None:
            raise ValueError("A reason is only accepted for dislike feedback.")
        return value

    @field_validator("comment")
    @classmethod
    def clean_comment(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.replace("\x00", "").split()).strip()
        return cleaned or None


class MessageFeedbackRead(BaseModel):
    message_id: str
    rating: Literal[-1, 1]
    reason: FeedbackReason | None = None
    comment: str | None = None
    updated_at: datetime

    model_config = {"from_attributes": True}


class FeedbackAnalyticsRead(BaseModel):
    model: str
    provider: str
    response_mode: str
    total: int
    likes: int
    dislikes: int
    like_rate: float
    reason_counts: dict[str, int]
