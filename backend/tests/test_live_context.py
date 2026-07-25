from datetime import timedelta

from app.services.live_context import LiveRequestContext, is_time_query


def test_live_context_converts_asia_kolkata_from_server_utc():
    context = LiveRequestContext.create("Asia/Kolkata", "hi-IN")
    assert context.local_datetime.utcoffset() == timedelta(hours=5, minutes=30)
    assert context.timezone_name == "Asia/Kolkata"
    assert context.locale == "hi-IN"


def test_live_context_handles_dst_timezone():
    context = LiveRequestContext.create("America/New_York", "en-US")
    assert context.local_datetime.utcoffset() in {timedelta(hours=-4), timedelta(hours=-5)}


def test_live_context_invalid_timezone_falls_back_to_utc():
    context = LiveRequestContext.create("Invalid/Timezone", "en")
    assert context.timezone_name == "UTC"
    assert context.timezone_fallback is True
    assert context.local_datetime.utcoffset() == timedelta(0)


def test_time_query_does_not_capture_news_query():
    assert is_time_query("What is the exact time now?")
    assert is_time_query("अभी समय क्या है?")
    assert not is_time_query("today's latest news")
