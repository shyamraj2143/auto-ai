import pytest

from app.core.config import Settings


def test_chat_model_for_uses_provider_defaults():
    settings = Settings()

    assert settings.chat_model_for("groq") == settings.GROQ_MODEL
    assert settings.chat_model_for("openai") == settings.OPENAI_MODEL


def test_chat_model_for_defaults_to_configured_provider():
    settings = Settings(AI_PROVIDER="openai")
    assert settings.chat_model_for() == settings.OPENAI_MODEL


def test_legacy_removed_provider_configuration_normalizes_to_groq():
    assert Settings(AI_PROVIDER="bedrock").AI_PROVIDER == "groq"
    assert Settings(AI_PROVIDER="gemini").AI_PROVIDER == "groq"


def test_chat_model_for_rejects_removed_providers_when_explicitly_requested():
    settings = Settings()
    for provider in ("bedrock", "gemini"):
        with pytest.raises(ValueError, match="Unsupported AI provider"):
            settings.chat_model_for(provider)


def test_chat_model_for_rejects_unknown_provider():
    settings = Settings()
    with pytest.raises(ValueError, match="Unsupported AI provider"):
        settings.chat_model_for("unknown")
