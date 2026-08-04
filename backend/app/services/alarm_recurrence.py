from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


RECURRENCE_TYPES = {"ONCE", "DAILY", "WEEKDAYS", "WEEKENDS", "CUSTOM", "SPECIFIC_DATE"}
WEEKDAYS = (0, 1, 2, 3, 4)
WEEKENDS = (5, 6)


@dataclass(frozen=True)
class AlarmSchedule:
    next_trigger_at: datetime
    weekdays: tuple[int, ...]


def normalized_weekdays(recurrence_type: str, selected: Iterable[int]) -> tuple[int, ...]:
    if recurrence_type == "DAILY":
        return tuple(range(7))
    if recurrence_type == "WEEKDAYS":
        return WEEKDAYS
    if recurrence_type == "WEEKENDS":
        return WEEKENDS
    if recurrence_type == "CUSTOM":
        values = tuple(sorted(set(selected)))
        if not values:
            raise ValueError("Custom recurrence requires at least one weekday.")
        if any(value < 0 or value > 6 for value in values):
            raise ValueError("Weekdays must use Monday (0) through Sunday (6).")
        return values
    return ()


def next_occurrence(
    *,
    local_time: str,
    timezone: str,
    recurrence_type: str = "ONCE",
    alarm_date: date | None = None,
    selected_weekdays: Iterable[int] = (),
    start_date: date | None = None,
    end_date: date | None = None,
    enabled: bool = True,
    after: datetime | None = None,
) -> AlarmSchedule | None:
    if not enabled:
        return None
    if recurrence_type not in RECURRENCE_TYPES:
        raise ValueError("Unsupported recurrence type.")
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Unknown alarm timezone.") from exc
    try:
        hour, minute = (int(part) for part in local_time.split(":"))
        clock = time(hour, minute)
    except (TypeError, ValueError) as exc:
        raise ValueError("Time must use HH:mm in 24-hour format.") from exc
    current = after or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    local_now = current.astimezone(zone)
    days = normalized_weekdays(recurrence_type, selected_weekdays)

    if recurrence_type == "SPECIFIC_DATE" and alarm_date is None:
        raise ValueError("Specific-date alarms require a date.")
    if recurrence_type in {"ONCE", "SPECIFIC_DATE"}:
        target_date = alarm_date or local_now.date()
        candidate = datetime.combine(target_date, clock, zone)
        if alarm_date is None and candidate <= local_now:
            candidate += timedelta(days=1)
        if candidate <= local_now:
            raise ValueError("Choose a future alarm date and time.")
        return AlarmSchedule(candidate.astimezone(UTC), days)

    first_date = max(local_now.date(), start_date or local_now.date())
    for offset in range(0, 367 * 6):
        candidate_date = first_date + timedelta(days=offset)
        if end_date and candidate_date > end_date:
            return None
        if candidate_date.weekday() not in days:
            continue
        candidate = datetime.combine(candidate_date, clock, zone)
        if candidate > local_now:
            return AlarmSchedule(candidate.astimezone(UTC), days)
    return None
