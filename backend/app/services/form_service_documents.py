from __future__ import annotations

import asyncio
import hashlib
import hmac
import re
import struct
import uuid
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from pypdf import PdfReader

from app.core.config import settings


MIME_SIGNATURES = {
    "application/pdf": (b"%PDF-",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
}
SCRIPT_MARKERS = (b"/JavaScript", b"/JS", b"/OpenAction", b"/Launch", b"/EmbeddedFile", b"<script")


@dataclass(frozen=True)
class InspectedUpload:
    path: str
    filename: str
    content_type: str
    size: int
    sha256: str
    page_count: int | None
    dimensions: dict[str, int]
    extracted_text: str
    scanner_result: dict


def create_document_access_signature(user_id: str, task_id: str, asset_id: str, expires: int) -> str:
    payload = f"{user_id}:{task_id}:{asset_id}:{expires}"
    return hmac.new(settings.jwt_secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def valid_document_access_signature(user_id: str, task_id: str, asset_id: str, expires: int, signature: str) -> bool:
    return hmac.compare_digest(create_document_access_signature(user_id, task_id, asset_id, expires), signature)


def _image_dimensions(data: bytes, mime: str) -> dict[str, int]:
    if mime == "image/png" and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
    elif mime == "image/jpeg":
        width = height = 0
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            index += 2
            if marker in {0xD8, 0xD9}:
                continue
            if index + 2 > len(data):
                break
            segment_length = int.from_bytes(data[index:index + 2], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and index + 7 <= len(data):
                height = int.from_bytes(data[index + 3:index + 5], "big")
                width = int.from_bytes(data[index + 5:index + 7], "big")
                break
            if segment_length < 2:
                break
            index += segment_length
    else:
        width = height = 0
    if width <= 0 or height <= 0 or width > 20000 or height > 20000 or width * height > 80_000_000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "Image dimensions are invalid or exceed safe processing limits"})
    return {"width": width, "height": height}


def _inspect_content(data: bytes, detected: str) -> tuple[int | None, dict[str, int], str]:
    if detected != "application/pdf":
        return None, _image_dimensions(data, detected), ""
    lowered = data.lower()
    if any(marker.lower() in lowered for marker in SCRIPT_MARKERS):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "Document contains active or embedded content and was rejected"})
    try:
        reader = PdfReader(BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError("encrypted")
        page_count = len(reader.pages)
        if page_count < 1 or page_count > settings.FORM_SERVICE_MAX_PDF_PAGES:
            raise ValueError("page_limit")
        chunks: list[str] = []
        for page in reader.pages:
            value = page.extract_text() or ""
            chunks.append(value[:20000])
        return page_count, {}, "\n\n".join(chunks)[:100000]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "PDF is encrypted, malformed, or exceeds safe page limits"}) from exc


def extract_supported_document_fields(text: str) -> dict[str, dict[str, str | float]]:
    """Extract conservative candidates only; callers must require explicit user acceptance."""
    if not text.strip():
        return {}
    patterns = {
        "student_name": (r"(?im)^\s*(?:student\s+name|name\s+of\s+student|name)\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{1,119})\s*$", "Student name"),
        "applicant_name": (r"(?im)^\s*(?:applicant\s+name|name\s+of\s+applicant)\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{1,119})\s*$", "Applicant name"),
        "date_of_birth": (r"(?im)^\s*(?:date\s+of\s+birth|dob)\s*[:\-]\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}-\d{2}-\d{2})\s*$", "Date of birth"),
        "percentage": (r"(?im)^\s*(?:percentage|marks\s+percentage)\s*[:\-]\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$", "Percentage"),
        "roll_number": (r"(?im)^\s*(?:roll\s*(?:number|no\.?))\s*[:\-]\s*([A-Za-z0-9/-]{2,40})\s*$", "Roll number"),
    }
    fields: dict[str, dict[str, str | float]] = {}
    for key, (pattern, label) in patterns.items():
        match = re.search(pattern, text)
        if match:
            fields[key] = {"label": label, "value": match.group(1).strip(), "confidence": 0.82, "source": "document_embedded_text"}
    return fields


async def inspect_and_store_upload(upload: UploadFile, user_id: str, *, accepted: list[str], max_bytes: int) -> InspectedUpload:
    limit = min(max_bytes, settings.FORM_SERVICE_MAX_UPLOAD_MB * 1024 * 1024)
    data = await upload.read(limit + 1)
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "The selected file is empty"})
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail={"code": "DOCUMENT_INVALID", "message": f"File exceeds the {limit // 1024 // 1024 or 1} MB requirement limit"})
    declared = (upload.content_type or "").split(";", 1)[0].lower()
    detected = next((mime for mime, signatures in MIME_SIGNATURES.items() if any(data.startswith(signature) for signature in signatures)), None)
    if not detected or detected not in accepted or (declared and declared not in {detected, "application/octet-stream"}):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail={"code": "DOCUMENT_INVALID", "message": "File content does not match an accepted PDF, JPG, or PNG type"})
    if b"PK\x03\x04" in data[:1024] and detected != "application/pdf":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "Archive and polyglot files are not accepted"})
    page_count, dimensions, extracted_text = await asyncio.to_thread(_inspect_content, data, detected)
    digest = hashlib.sha256(data).hexdigest()
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(upload.filename or "document").stem).strip("._")[:80] or "document"
    extension = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}[detected]
    target_dir = (Path(settings.FORM_SERVICE_STORAGE_DIR) / user_id).resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    target = (target_dir / f"{safe_stem}-{uuid.uuid4().hex}{extension}").resolve()
    if target.parent != target_dir:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "DOCUMENT_INVALID", "message": "Unsafe filename"})
    await asyncio.to_thread(target.write_bytes, data)
    return InspectedUpload(
        path=str(target),
        filename=f"{safe_stem}{extension}",
        content_type=detected,
        size=len(data),
        sha256=digest,
        page_count=page_count,
        dimensions=dimensions,
        extracted_text=extracted_text,
        scanner_result={"engine": "bounded-signature-and-parser", "status": "CLEAN", "findings": []},
    )
