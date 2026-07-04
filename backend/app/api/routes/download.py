from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.apk import ApkRelease
from app.models.user import User
from app.schemas.download import ApkReleaseRead, ApkReleaseUpdate, ApkStats
from app.services.apk_service import apk_service


router = APIRouter(prefix="/download", tags=["download"])


def optional_user(request: Request, db: Session) -> User | None:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    user_id = decode_access_token(auth.split(" ", 1)[1].strip())
    return db.get(User, user_id) if user_id else None


@router.get("/apk")
def download_apk(
    request: Request,
    version: str | None = None,
    db: Session = Depends(get_db),
):
    release = apk_service.find_release(db, version)
    if not release:
        apk_service.record_download(db, None, request, status_value="not_found")
        db.commit()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No APK release is available.")

    path = apk_service.validate_release_file(release)
    apk_service.record_download(db, release, request, optional_user(request, db))
    db.commit()
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=release.filename,
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Auto-AI-APK-Version": release.version_name,
            "X-Auto-AI-APK-Version-Code": str(release.version_code),
            "X-Auto-AI-APK-SHA256": release.sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/apk/latest", response_model=ApkReleaseRead)
def latest_apk(db: Session = Depends(get_db)) -> ApkReleaseRead:
    release = apk_service.latest_release(db)
    if not release:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No APK release is available.")
    apk_service.validate_release_file(release)
    return apk_service.release_read(release)


@router.get("/apk/versions", response_model=list[ApkReleaseRead])
def apk_versions(db: Session = Depends(get_db)) -> list[ApkReleaseRead]:
    releases = db.scalars(select(ApkRelease).order_by(ApkRelease.version_code.desc())).all()
    return [apk_service.release_read(release) for release in releases]


@router.get("/apk/stats", response_model=ApkStats)
def apk_stats(db: Session = Depends(get_db)) -> ApkStats:
    latest = apk_service.latest_release(db)
    total_downloads = db.scalar(select(func.coalesce(func.sum(ApkRelease.download_count), 0))) or 0
    return ApkStats(
        latest=apk_service.release_read(latest) if latest else None,
        total_downloads=total_downloads,
        downloads_by_version=apk_service.download_counts(db),
    )


@router.post("/apk/releases", response_model=ApkReleaseRead, status_code=status.HTTP_201_CREATED)
async def upload_apk_release(
    file: UploadFile = File(...),
    version_name: str | None = Form(default=None),
    version: str | None = Form(default=None),
    version_code: int | None = Form(default=None),
    min_android_version: str | None = Form(default=None),
    release_notes: str | None = Form(default=None),
    changelog: str | None = Form(default=None),
    force_update: bool = Form(default=False),
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> ApkReleaseRead:
    release = await apk_service.save_upload(
        db,
        file,
        version_name=version_name or version,
        version_code=version_code,
        min_android_version=min_android_version,
        release_notes=release_notes,
        changelog=changelog,
        force_update=force_update,
    )
    return apk_service.release_read(release)


@router.patch("/apk/versions/{release_id}", response_model=ApkReleaseRead)
def update_apk_release(
    release_id: str,
    payload: ApkReleaseUpdate,
    _: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> ApkReleaseRead:
    release = apk_service.update_release(db, release_id, **payload.model_dump(exclude_unset=True))
    return apk_service.release_read(release)
