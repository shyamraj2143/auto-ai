from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
import httpx
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.apk import ApkRelease
from app.models.user import User
from app.schemas.download import ApkDownloadCountRequest, ApkReleaseRead, ApkReleaseUpdate, ApkStats
from app.services.apk_service import apk_service
from app.services.github_apk_release import github_apk_release_service


router = APIRouter(prefix="/download", tags=["download"])


def optional_user(request: Request, db: Session) -> User | None:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    user_id = decode_access_token(auth.split(" ", 1)[1].strip())
    return db.get(User, user_id) if user_id else None


def newest_release(db_release: ApkRelease | None) -> ApkReleaseRead | None:
    db_read = apk_service.release_read(db_release) if db_release else None
    github_release = github_apk_release_service.latest_release()
    if github_release and (not db_read or github_release.read.version_code > db_read.version_code):
        return github_release.read
    return db_read or (github_release.read if github_release else None)


@router.get("/apk")
def download_apk(
    request: Request,
    version: str | None = None,
    counted: bool = False,
    db: Session = Depends(get_db),
):
    release = apk_service.find_release(db, version)
    if not release:
        apk_service.record_download(db, None, request, status_value="not_found")
        db.commit()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No APK release is available.")

    path = apk_service.validate_release_file(release)
    if not counted:
        apk_service.record_download(db, release, request, optional_user(request, db))
        db.commit()
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename=release.file_name,
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
    release = newest_release(apk_service.latest_release(db))
    if not release:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No APK release is available.")
    return release


@router.get("/apk/versions", response_model=list[ApkReleaseRead])
def apk_versions(db: Session = Depends(get_db)) -> list[ApkReleaseRead]:
    releases = db.scalars(select(ApkRelease).order_by(ApkRelease.version_code.desc(), ApkRelease.released_at.desc())).all()
    result = [apk_service.release_read(release) for release in releases]
    github_release = github_apk_release_service.latest_release()
    if github_release and all(item.version_code != github_release.read.version_code for item in result):
        result.insert(0, github_release.read)
    return result


@router.get("/apk/github/latest")
def download_latest_github_apk(version: str | None = None):
    release = github_apk_release_service.latest_release()
    if not release or (version and release.read.version_name != version):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No GitHub APK release is available.")

    def stream_apk():
        with httpx.stream("GET", release.asset_url, follow_redirects=True, timeout=120.0) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                if chunk:
                    yield chunk

    return StreamingResponse(
        stream_apk(),
        media_type="application/vnd.android.package-archive",
        headers={
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": f'attachment; filename="{release.read.file_name}"',
            "X-Auto-AI-APK-Version": release.read.version_name,
            "X-Auto-AI-APK-Version-Code": str(release.read.version_code),
            "X-Auto-AI-APK-SHA256": release.read.sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/apk/count", response_model=ApkReleaseRead)
def count_apk_download(
    request: Request,
    payload: ApkDownloadCountRequest | None = None,
    db: Session = Depends(get_db),
) -> ApkReleaseRead:
    payload = payload or ApkDownloadCountRequest()
    release = apk_service.find_release_for_count(
        db,
        release_id=payload.id,
        version_name=payload.version_name,
        version_code=payload.version_code,
    )
    if not release:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No APK release is available.")
    release = apk_service.increment_download_count(db, release, request, optional_user(request, db))
    return apk_service.release_read(release)


@router.get("/apk/stats", response_model=ApkStats)
def apk_stats(db: Session = Depends(get_db)) -> ApkStats:
    latest = newest_release(apk_service.latest_release(db))
    total_downloads = db.scalar(select(func.coalesce(func.sum(ApkRelease.download_count), 0))) or 0
    return ApkStats(
        latest=latest,
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
