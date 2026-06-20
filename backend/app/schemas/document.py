from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class DocumentRead(BaseModel):
    id: str
    chat_id: str | None
    filename: str
    content_type: str
    file_size: int = 0
    summary: str | None
    document_metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = {"from_attributes": True}


class DocumentDetail(DocumentRead):
    extracted_text: str


class DocumentSummary(BaseModel):
    document: DocumentRead
    summary: str
