import pytest

from app.services.alarm_ai_service import alarm_ai_service


@pytest.mark.parametrize("command,hour,minute,repeat,label", [
    ("दस तारीक भोर के चार बजे जगा देना पढ़ना है", 4, 0, [], "पढ़ाई"),
    ("कल सबेरे आठ बजे ऑफिस का अलारम लगा देना", 8, 0, [], "Office"),
    ("परसो साडे छह बजे उठा देना", 6, 30, [], "Alarm"),
    ("हर सोमवार से शुक्रवार 7 बजे जगा देना", 7, 0, [0, 1, 2, 3, 4], "Alarm"),
])
def test_natural_hindi_commands_are_normalized_without_network(monkeypatch, command, hour, minute, repeat, label):
    monkeypatch.setattr("app.services.alarm_ai_service.groq_service.complete", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Groq fallback not expected")))
    result = alarm_ai_service.interpret(transcript=command, timezone="Asia/Kolkata", language="hinglish-IN")
    assert result["action"] == "create"
    assert (result["scheduled_at"].hour, result["scheduled_at"].minute) == (hour, minute)
    assert result["repeat"] == repeat
    assert result["label"] == label
    assert result["normalized_user_text"] != command


def test_ambiguous_am_pm_requires_clarification(monkeypatch):
    monkeypatch.setattr("app.services.alarm_ai_service.groq_service.complete", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Groq fallback not expected")))
    result = alarm_ai_service.interpret(transcript="कल आठ बजे alarm लगाओ", timezone="Asia/Kolkata", language="hi-IN")
    assert result["action"] == "clarify"
    assert result["scheduled_at"] is None
    assert "सुबह 08:00" in result["clarification_question"]


def test_today_alarm_list_is_understood_without_execution(monkeypatch):
    monkeypatch.setattr("app.services.alarm_ai_service.groq_service.complete", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Groq fallback not expected")))
    result = alarm_ai_service.interpret(transcript="आज के सारे alarms दिखाओ", timezone="Asia/Kolkata", language="hinglish-IN")
    assert result["intent"] == "alarm.list"
    assert result["action"] == "list"


def test_custom_weekday_alarm_is_deterministic(monkeypatch):
    monkeypatch.setattr("app.services.alarm_ai_service.groq_service.complete", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Groq fallback not expected")))
    result = alarm_ai_service.interpret(transcript="every monday, wednesday and friday morning 5 am alarm", timezone="Asia/Kolkata", language="en-IN")
    assert result["action"] == "create"
    assert result["repeat"] == [0, 2, 4]
