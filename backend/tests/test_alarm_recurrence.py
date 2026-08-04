from datetime import UTC, date, datetime

import pytest

from app.services.alarm_recurrence import next_occurrence


def test_once_without_date_uses_next_future_local_time() -> None:
    before = next_occurrence(local_time="09:00", timezone="Asia/Kolkata", after=datetime(2026, 8, 4, 2, 0, tzinfo=UTC))
    after = next_occurrence(local_time="06:00", timezone="Asia/Kolkata", after=datetime(2026, 8, 4, 2, 0, tzinfo=UTC))
    assert before.next_trigger_at == datetime(2026, 8, 4, 3, 30, tzinfo=UTC)
    assert after.next_trigger_at == datetime(2026, 8, 5, 0, 30, tzinfo=UTC)


def test_specific_date_requires_date_and_rejects_past() -> None:
    with pytest.raises(ValueError, match="require a date"):
        next_occurrence(local_time="09:00", timezone="UTC", recurrence_type="SPECIFIC_DATE", after=datetime(2026, 8, 4, tzinfo=UTC))
    with pytest.raises(ValueError, match="future"):
        next_occurrence(local_time="09:00", timezone="UTC", recurrence_type="SPECIFIC_DATE", alarm_date=date(2026, 8, 3), after=datetime(2026, 8, 4, tzinfo=UTC))


@pytest.mark.parametrize(("kind", "expected_weekday"), (("DAILY", 5), ("WEEKDAYS", 0), ("WEEKENDS", 5)))
def test_standard_repeat_modes(kind: str, expected_weekday: int) -> None:
    result = next_occurrence(local_time="09:00", timezone="UTC", recurrence_type=kind, after=datetime(2026, 8, 7, 10, tzinfo=UTC))
    assert result.next_trigger_at.weekday() == expected_weekday


def test_custom_range_uses_selected_days_and_end_boundary() -> None:
    result = next_occurrence(local_time="09:00", timezone="UTC", recurrence_type="CUSTOM", selected_weekdays=[0, 3], start_date=date(2026, 8, 10), end_date=date(2026, 8, 30), after=datetime(2026, 8, 4, tzinfo=UTC))
    assert result.next_trigger_at == datetime(2026, 8, 10, 9, tzinfo=UTC)
    assert next_occurrence(local_time="09:00", timezone="UTC", recurrence_type="CUSTOM", selected_weekdays=[0], end_date=date(2026, 8, 4), after=datetime(2026, 8, 4, 10, tzinfo=UTC)) is None


def test_disabled_alarm_has_no_occurrence() -> None:
    assert next_occurrence(local_time="09:00", timezone="UTC", recurrence_type="DAILY", enabled=False) is None
