from __future__ import annotations

import hashlib
from pathlib import Path
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.library_asset import LibraryAsset
from app.services.document_service import document_service
from app.services.library_storage import library_storage


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
DOCUMENT_EXTENSIONS = {".pdf", ".docx", ".txt"}
CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".go", ".rs",
    ".css", ".html", ".json", ".md", ".yaml", ".yml", ".sql",
}
BLOCKED_EXTENSIONS = {".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".apk", ".jar", ".ps1", ".sh", ".scr"}
ALLOWED_SOURCES = {"upload", "camera", "chat_attachment", "screen_capture", "import"}


def classify_and_validate(filename: str, declared_mime: str | None, data: bytes) -> tuple[str, str, str]:
    safe_name = document_service.safe_filename(Path(filename).name)
    extension = Path(safe_name).suffix.lower()
    allowed = IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS | CODE_EXTENSIONS
    if extension in BLOCKED_EXTENSIONS or extension not in allowed:
        raise HTTPException(status_code=415, detail="Unsupported or unsafe file type.")
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > settings.LIBRARY_MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"File is too large. Maximum size is {settings.LIBRARY_MAX_UPLOAD_MB} MB.",
        )

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
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".txt": "text/plain",
        ".json": "application/json",
    }.get(extension, "text/plain" if file_type == "code" else (declared_mime or "application/octet-stream"))
    if declared_mime and declared_mime not in {"application/octet-stream", canonical_mime} and file_type in {"image", "document"}:
        raise HTTPException(status_code=415, detail="The declared MIME type does not match the file content.")
    return safe_name, canonical_mime, file_type


def extract_content(data: bytes, extension: str, file_type: str) -> tuple[str | None, dict]:
    if file_type == "image":
        return None, {}
    if extension in DOCUMENT_EXTENSIONS:
        extraction = document_service.extract_text(data, extension)
        return extraction.text, extraction.metadata
    text = data.decode("utf-8-sig", errors="replace")
    normalized = document_service.normalize_text(text)
    return normalized[: settings.MAX_DOCUMENT_CONTEXT_CHARS * 4], {
        "parser": "text-code",
        "character_count": len(normalized),
    }


def upsert_library_asset(
    db: Session,
    *,
    user_id: str,
    filename: str,
    declared_mime: str | None,
    data: bytes,
    source: str = "chat_attachment",
    pre_extracted: tuple[str | None, dict] | None = None,
    extra_metadata: dict | None = None,
) -> LibraryAsset:
    """Store one account-scoped asset and deduplicate it by SHA-256 checksum."""

    normalized_source = source if source in ALLOWED_SOURCES else "chat_attachment"
    name, mime_type, file_type = classify_and_validate(filename, declared_mime, data)
    checksum = hashlib.sha256(data).hexdigest()
    existing = db.scalar(
        select(LibraryAsset).where(
            LibraryAsset.user_id == user_id,
            LibraryAsset.checksum == checksum,
            LibraryAsset.is_deleted.is_(False),
        )
    )
    if existing:
        return existing

    extension = Path(name).suffix.lower()
    extracted_text, metadata = pre_extracted or extract_content(data, extension, file_type)
    metadata = {**(metadata or {}), **(extra_metadata or {})}
    storage_key = f"{user_id}/{uuid.uuid4().hex}{extension}"
    library_storage.put(storage_key, data, mime_type)
    asset = LibraryAsset(
        user_id=user_id,
        original_name=Path(filename or name).name[:255],
        display_name=name,
        mime_type=mime_type,
        file_type=file_type,
        file_size=len(data),
        storage_key=storage_key,
        source=normalized_source,
        checksum=checksum,
        upload_status="ready",
        extracted_text=extracted_text,
        metadata_json=metadata,
    )
    db.add(asset)
    db.flush()
    return asset
