from app.core.config import Settings


def test_rate_limit_settings_match_middleware_contract():
    settings = Settings()

    assert settings.RATE_LIMIT_PER_MINUTE == 90
    assert settings.RATE_LIMIT_LOGIN_PER_MINUTE == 8
    assert settings.RATE_LIMIT_REGISTER_PER_MINUTE == 5
    assert settings.RATE_LIMIT_PASSWORD_RESET_PER_MINUTE == 5
    assert settings.RATE_LIMIT_AI_PER_MINUTE == 30
    assert settings.RATE_LIMIT_PAYMENT_PER_MINUTE == 12
    assert settings.RATE_LIMIT_ADMIN_PER_MINUTE == 30
    assert settings.RATE_LIMIT_RESTORE_PER_MINUTE == 3
    assert settings.RATE_LIMIT_UPLOAD_PER_MINUTE == 12
