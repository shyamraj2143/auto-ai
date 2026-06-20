from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.chat import Chat
from app.models.document import Document
from app.models.user import User
from app.schemas.document import DocumentDetail, DocumentRead, DocumentSummary
from app.services.document_service import document_service


router = APIRouter(prefix="/documents", tags=["documents"])


@router.post("/upload", response_model=DocumentRead, status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...),
    chat_id: str | None = Form(default=None),
    summarize: bool = Form(default=True),
    provider: str | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if chat_id:
        chat = db.scalar(select(Chat).where(Chat.id == chat_id, Chat.user_id == current_user.id))
        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    file_path, extraction = await document_service.save_and_extract(file, current_user.id)

    summary = (
        document_service.summarize(extraction.text, file.filename or "document", provider=provider)
        if summarize
        else None
    )
    document = Document(
        user_id=current_user.id,
        chat_id=chat_id,
        filename=file.filename or Path(file_path).name,
        content_type=file.content_type or "application/octet-stream",
        file_size=int(extraction.metadata.get("file_size", 0) or 0),
        file_path=file_path,
        extracted_text=extraction.text,
        summary=summary,
        document_metadata=extraction.metadata,
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


@router.get("", response_model=list[DocumentRead])
def list_documents(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(
        db.scalars(
            select(Document).where(Document.user_id == current_user.id).order_by(Document.created_at.desc())
        )
    )


@router.get("/{document_id}", response_model=DocumentDetail)
def get_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    document = db.scalar(
        select(Document).where(Document.id == document_id, Document.user_id == current_user.id)
    )
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return document


@router.post("/{document_id}/summarize", response_model=DocumentSummary)
def summarize_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    document = db.scalar(
        select(Document).where(Document.id == document_id, Document.user_id == current_user.id)
    )
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    document.summary = document_service.summarize(document.extracted_text, document.filename)
    db.add(document)
    db.commit()
    db.refresh(document)
    return DocumentSummary(document=document, summary=document.summary or "")


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    document = db.scalar(
        select(Document).where(Document.id == document_id, Document.user_id == current_user.id)
    )
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    Path(document.file_path).unlink(missing_ok=True)
    db.delete(document)
    db.commit()
    return None
