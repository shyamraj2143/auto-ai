from app.core.config import settings
from app.core.security import _jwt_secret


def test_jwt_secret_resolves_from_settings_fields():
    expected = (settings.JWT_SECRET_KEY or settings.SECRET_KEY).strip()
    assert _jwt_secret() == expected
    assert expected
