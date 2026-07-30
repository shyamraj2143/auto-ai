from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def to_rfc3339_utc(value: datetime) -> str:
    normalized = ensure_utc(value)
    rendered = normalized.isoformat(timespec="milliseconds" if normalized.microsecond else "seconds")
    return rendered.replace("+00:00", "Z")
