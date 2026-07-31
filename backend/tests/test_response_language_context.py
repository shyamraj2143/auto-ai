from app.services.live_context import LiveRequestContext, response_language_instruction


def test_response_language_preferences_are_explicit():
    assert "Always answer in clear English" in response_language_instruction("autoai-response-en")
    assert "Always answer in clear Hindi" in response_language_instruction("autoai-response-hi")
    assert "latest message" in response_language_instruction("autoai-response-auto")
    assert response_language_instruction("en-IN") == ""


def test_live_context_includes_response_language_instruction():
    prompt = LiveRequestContext.create("Asia/Kolkata", "autoai-response-hi").system_prompt()
    assert "Response language instruction" in prompt
    assert "Devanagari" in prompt
