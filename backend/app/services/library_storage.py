from pathlib import Path
from typing import Protocol

from app.core.config import settings


class LibraryStorage(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def read(self, key: str) -> bytes: ...
    def local_path(self, key: str) -> Path | None: ...


class LocalLibraryStorage:
    def __init__(self) -> None:
        self.root = Path(settings.LIBRARY_STORAGE_DIR).resolve()

    def _path(self, key: str) -> Path:
        target = (self.root / key).resolve()
        if self.root != target and self.root not in target.parents:
            raise ValueError("Invalid library storage key")
        return target

    def put(self, key: str, data: bytes, content_type: str) -> None:
        del content_type
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def local_path(self, key: str) -> Path:
        return self._path(key)


class S3LibraryStorage:
    def __init__(self) -> None:
        import boto3

        if not settings.LIBRARY_S3_BUCKET:
            raise RuntimeError("LIBRARY_S3_BUCKET is required for S3 library storage")
        self.bucket = settings.LIBRARY_S3_BUCKET
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.LIBRARY_S3_ENDPOINT_URL,
            region_name=settings.LIBRARY_S3_REGION,
            aws_access_key_id=settings.LIBRARY_S3_ACCESS_KEY_ID,
            aws_secret_access_key=(
                settings.LIBRARY_S3_SECRET_ACCESS_KEY.get_secret_value()
                if settings.LIBRARY_S3_SECRET_ACCESS_KEY
                else None
            ),
        )

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def read(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def local_path(self, key: str) -> None:
        del key
        return None


library_storage: LibraryStorage = (
    S3LibraryStorage() if settings.LIBRARY_STORAGE_BACKEND.lower() == "s3" else LocalLibraryStorage()
)
