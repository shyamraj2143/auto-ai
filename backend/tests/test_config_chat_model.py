from app.core.config import Settings


def test_chat_model_for_uses_provider_defaults():
    settings = Settings()

    assert settings.chat_model_for("groq") == settings.GROQ_MODEL
    assert settings.chat_model_for("openai") == settings.OPENAI_MODEL
    assert settings.chat_model_for("gemini") == settings.GEMINI_MODEL


def test_chat_model_for_defaults_to_configured_provider():
    settings = Settings(AI_PROVIDER="openai")
    assert settings.chat_model_for() == settings.OPENAI_MODEL


def test_chat_model_for_rejects_unknown_provider():
    settings = Settings()
    try:
        settings.chat_model_for("unknown")
    except ValueError as exc:
        assert "Unsupported AI provider" in str(exc)
    else:
        raise AssertionError("Expected ValueError for unsupported provider")
