import pytest

from app.services.preset_detection import CODING_SYSTEM_INSTRUCTION, detect_preset, resolve_preset


@pytest.mark.parametrize(
    ("message", "has_attachments", "expected"),
    [
        ("Debug this React API", False, "coding"),
        ("Create a SQL migration", False, "coding"),
        ("Compare sources with citations", False, "deep_research"),
        ("Prove this complex architecture trade-off", False, "high"),
        ("hello", False, "instant"),
        ("Help me plan a balanced routine for the coming week", False, "medium"),
        ("Analyze this", True, "high"),
    ],
)
def test_detect_preset(message, has_attachments, expected):
    assert detect_preset(message, has_attachments=has_attachments) == expected


def test_manual_preset_remains_locked():
    result = resolve_preset(
        message="debug this code",
        preset_mode="manual",
        selected_preset="high",
        manual_preset_locked=True,
    )
    assert result.selected_preset == "high"
    assert result.detected_preset == "coding"
    assert result.manual_preset_locked is True


def test_auto_can_change_between_messages():
    first = resolve_preset(message="hello", preset_mode="auto", selected_preset=None, manual_preset_locked=False)
    second = resolve_preset(message="debug this Python API", preset_mode="auto", selected_preset=first.selected_preset, manual_preset_locked=False)
    assert first.selected_preset == "instant"
    assert second.selected_preset == "coding"


def test_coding_instruction_requires_complete_repository_aligned_work():
    prompt = CODING_SYSTEM_INSTRUCTION.lower()
    assert "complete" in prompt
    assert "repository architecture" in prompt
    assert "placeholders" in prompt
