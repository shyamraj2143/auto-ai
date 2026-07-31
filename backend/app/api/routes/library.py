import hashlib
from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.chat import Chat
from app.models.document import Document
from app.models.library_asset import LibraryAsset
from app.models.user import User
from app.schemas.library import (
    LibraryAssetPage,
    LibraryAssetRead,
    LibraryAssetUpdate,
    LibraryAttachRequest,
    LibraryAttachmentRead,
)
from app.services.document_service import document_service
from app.services.library_storage import library_storage
from app.utils.datetime import utc_now


router = APIRouter(prefix="/library/assets", tags=["library"])
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DOCUMENT_EXTENSIONS = {".pdf", ".docx", ".txt"}
CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".go", ".rs", ".css", ".html", ".json", ".md", ".yaml", ".yml", ".sql"}
BLOCKED_EXTENSIONS = {".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".apk", ".jar", ".ps1", ".sh", ".scr"}


def asset_or_404(db: Session, asset_id: str, user_id: str) -> LibraryAsset:
    asset = db.scalar(
        select(LibraryAsset).where(
            LibraryAsset.id == asset_id,
            LibraryAsset.user_id == user_id,
            LibraryAsset.is_deleted.is_(False),
        )
    )
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library asset is no longer available.")
    return asset


def classify_and_validate(filename: str, declared_mime: str | None, data: bytes) -> tuple[str, str, str]:
    safe_name = document_service.safe_filename(Path(filename).name)
    extension = Path(safe_name).suffix.lower()
    if extension in BLOCKED_EXTENSIONS or extension not in IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | CODE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported or unsafe file type.")
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > settings.LIBRARY_MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File is too large. Maximum size is {settings.LIBRARY_MAX_UPLOAD_MB} MB.")

    if extension == ".pdf" and not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="The file content is not a valid PDF.")
    if extension == ".docx" and not data.startswith(b"PK\x03\x04"):
        raise HTTPException(status_code=415, detail="The file content is not a valid DOCX document.")
    image_signatures = {
        ".png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        ".jpg": data.startswith(b"\xff\xd8\xff"),
        ".jpeg": data.startswith(b"\xff\xd8\xff"),
        ".gif": data.startswith((b"GIF87a", b"GIF89a")),
        ".webp": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    }
    if extension in image_signatures and not image_signatures[extension]:
        raise HTTPException(status_code=415, detail="The image content does not match its file type.")
    if extension in CODE_EXTENSIONS | {".txt"} and b"\x00" in data[:8192]:
        raise HTTPException(status_code=415, detail="Binary files are not supported as text or code.")

    file_type = "image" if extension in IMAGE_EXTENSIONS else "document" if extension in DOCUMENT_EXTENSIONS else "code"
    canonical_mime = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".gif": "image/gif", ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain", ".json": "application/json",
    }.get(extension, "text/plain" if file_type == "code" else (declared_mime or "application/octet-stream"))
    if declared_mime and declared_mime not in {"application/octet-stream", canonical_mime} and file_type in {"image", "document"}:
        raise HTTPException(status_code=415, detail="The declared MIME type does not match the file content.")
    return safe_name, canonical_mime, file_type


def extracted_content(data: bytes, extension: str, file_type: str) -> tuple[str | None, dict]:
    if file_type == "image":
        return None, {}
    if extension in DOCUMENT_EXTENSIONS:
        extraction = document_service.extract_text(data, extension)
        return extraction.text, extraction.metadata
    text = data.decode("utf-8-sig", errors="replace")
    normalized = document_service.normalize_text(text)
    return normalized[: settings.MAX_DOCUMENT_CONTEXT_CHARS * 4], {"parser": "text-code", "character_count": len(normalized)}


@router.post("", response_model=LibraryAssetRead, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    file: UploadFile = File(...),
    source: str = Form(default="upload", pattern="^(upload|camera|chat_attachment|screen_capture|import)$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    data = await file.read()
    name, mime_type, file_type = classify_and_validate(file.filename or "asset", file.content_type, data)
    checksum = hashlib.sha256(data).hexdigest()
    existing = db.scalar(
        select(LibraryAsset).where(
            LibraryAsset.user_id == current_user.id,
            LibraryAsset.checksum == checksum,
            LibraryAsset.is_deleted.is_(False),
        )
    )
    if existing:
        return existing
    extension = Path(name).suffix.lower()
    extracted_text, metadata = extracted_content(data, extension, file_type)
    storage_key = f"{current_user.id}/{uuid.uuid4().hex}{extension}"
    library_storage.put(storage_key, data, mime_type)
    asset = LibraryAsset(
        user_id=current_user.id,
        original_name=Path(file.filename or name).name[:255],
        display_name=name,
        mime_type=mime_type,
        file_type=file_type,
        file_size=len(data),
        storage_key=storage_key,
        source=source,
        checksum=checksum,
        upload_status="ready",
        extracted_text=extracted_text,
        metadata_json=metadata,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


@router.get("", response_model=LibraryAssetPage)
def list_assets(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=100),
    query: str = Query(default="", max_length=120),
    file_type: str | None = Query(default=None, pattern="^(image|document|code)$"),
    sort: str = Query(default="newest", pattern="^(newest|oldest|recently_used|name)$"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    filters = [LibraryAsset.user_id == current_user.id, LibraryAsset.is_deleted.is_(False)]
    normalized = query.strip()
    if normalized:
        filters.append(or_(LibraryAsset.display_name.ilike(f"%{normalized}%"), LibraryAsset.original_name.ilike(f"%{normalized}%")))
    if file_type:
        filters.append(LibraryAsset.file_type == file_type)
    order = {
        "oldest": LibraryAsset.created_at.asc(),
        "recently_used": LibraryAsset.last_used_at.desc().nullslast(),
        "name": LibraryAsset.display_name.asc(),
    }.get(sort, LibraryAsset.created_at.desc())
    total = db.scalar(select(func.count()).select_from(LibraryAsset).where(*filters)) or 0
    items = list(db.scalars(select(LibraryAsset).where(*filters).order_by(order).offset((page - 1) * page_size).limit(page_size)))
    return LibraryAssetPage(items=items, page=page, page_size=page_size, total=total, has_more=page * page_size < total)


@router.get("/{asset_id}", response_model=LibraryAssetRead)
def get_asset(asset_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return asset_or_404(db, asset_id, current_user.id)


@router.patch("/{asset_id}", response_model=LibraryAssetRead)
def rename_asset(asset_id: str, payload: LibraryAssetUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    asset = asset_or_404(db, asset_id, current_user.id)
    asset.display_name = document_service.safe_filename(payload.display_name)
    asset.updated_at = utc_now()
    db.commit()
    db.refresh(asset)
    return asset


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(asset_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    asset = asset_or_404(db, asset_id, current_user.id)
    asset.is_deleted = True
    asset.updated_at = utc_now()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{asset_id}/attach", response_model=LibraryAttachmentRead)
def attach_asset(asset_id: str, payload: LibraryAttachRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    asset = asset_or_404(db, asset_id, current_user.id)
    if payload.chat_id:
        chat = db.scalar(select(Chat).where(Chat.id == payload.chat_id, Chat.user_id == current_user.id))
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found.")
    document_id = None
    if asset.file_type != "image":
        existing = db.scalar(
            select(Document).where(
                Document.user_id == current_user.id,
                Document.document_metadata["library_asset_id"].as_string() == asset.id,
                Document.chat_id == payload.chat_id,
            )
        )
        if existing:
            document_id = existing.id
        else:
            document = Document(
                user_id=current_user.id,
                chat_id=payload.chat_id,
                filename=asset.display_name,
                content_type=asset.mime_type,
                file_size=asset.file_size,
                file_path=asset.storage_key,
                extracted_text=asset.extracted_text or "",
                document_metadata={"library_asset_id": asset.id, "storage": "library"},
            )
            db.add(document)
            db.flush()
            document_id = document.id
    asset.last_used_at = utc_now()
    db.commit()
    return LibraryAttachmentRead(
        asset_id=asset.id,
        document_id=document_id,
        type="image" if asset.file_type == "image" else "file",
        filename=asset.display_name,
        mime_type=asset.mime_type,
        file_size=asset.file_size,
        url=f"{settings.API_V1_STR}/library/assets/{asset.id}/download",
    )


def asset_file_response(asset: LibraryAsset, *, inline: bool) -> FileResponse | Response:
    path = library_storage.local_path(asset.storage_key)
    if path is None:
        try:
            content = library_storage.read(asset.storage_key)
        except Exception as exc:
            raise HTTPException(status_code=404, detail="Library asset is no longer available.") from exc
        disposition = "inline" if inline else "attachment"
        return Response(
            content=content,
            media_type=asset.mime_type,
            headers={"Content-Disposition": f'{disposition}; filename="{asset.display_name}"'},
        )
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Library asset is no longer available.")
    disposition = "inline" if inline else "attachment"
    return FileResponse(path, media_type=asset.mime_type, filename=asset.display_name, content_disposition_type=disposition)


@router.get("/{asset_id}/download")
def download_asset(asset_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return asset_file_response(asset_or_404(db, asset_id, current_user.id), inline=False)


@router.get("/{asset_id}/preview")
def preview_asset(asset_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return asset_file_response(asset_or_404(db, asset_id, current_user.id), inline=True)
