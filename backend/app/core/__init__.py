"""Core package compatibility helpers.

Keep payment credential settings backward-compatible when deployments contain
older config.py versions. The canonical fields should live in Settings; these
fallbacks only fill missing attributes from environment variables.
"""

import os

from pydantic import SecretStr

from .config import Settings, settings


_PAYMENT_SECRET_FIELDS = {
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
}
_PAYMENT_PLAIN_FIELDS = {"RAZORPAY_KEY_ID"}


def _install_missing_payment_setting(name: str, secret: bool) -> None:
    if hasattr(Settings, name):
        return
    value = os.getenv(name)
    setattr(Settings, name, SecretStr(value) if secret and value else (value or None))


for _name in _PAYMENT_PLAIN_FIELDS:
    _install_missing_payment_setting(_name, False)
for _name in _PAYMENT_SECRET_FIELDS:
    _install_missing_payment_setting(_name, True)

__all__ = ["Settings", "settings"]
