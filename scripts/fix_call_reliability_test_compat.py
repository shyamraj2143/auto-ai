from pathlib import Path

path = Path("backend/app/services/presence_fallback.py")
text = path.read_text(encoding="utf-8")
needle = "    @property\n    def configured(self) -> bool:\n        return bool(self._delegate.configured)\n"
replacement = "    @property\n    def configured(self) -> bool:\n        return bool(self._delegate.configured)\n\n    @property\n    def _redis(self):\n        return self._delegate._redis\n\n    @_redis.setter\n    def _redis(self, value) -> None:\n        self._delegate._redis = value\n"
if replacement not in text:
    if needle not in text:
        raise RuntimeError("ResilientPresenceService compatibility insertion point not found")
    text = text.replace(needle, replacement, 1)
    path.write_text(text, encoding="utf-8")
print("Applied presence-service compatibility proxy.")
