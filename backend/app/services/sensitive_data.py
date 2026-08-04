from app.services.device_token_security import decrypt_token, encrypt_token


def encrypt_sensitive_text(value: str | None) -> str | None:
    return encrypt_token(value)


def decrypt_sensitive_text(value: str | None) -> str:
    return decrypt_token(value) or ""
