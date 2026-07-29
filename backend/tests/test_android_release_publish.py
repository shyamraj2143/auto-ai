import hashlib
import importlib.util
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "publish_android_release.py"
SCRIPT_SPEC = importlib.util.spec_from_file_location("auto_ai_publish_android_release", SCRIPT_PATH)
assert SCRIPT_SPEC and SCRIPT_SPEC.loader
publish_android_release = importlib.util.module_from_spec(SCRIPT_SPEC)
SCRIPT_SPEC.loader.exec_module(publish_android_release)


def test_metadata_publish_registers_github_release_without_binary_upload(tmp_path, monkeypatch) -> None:
    apk = tmp_path / "auto-ai.apk"
    apk.write_bytes(b"signed-apk")
    captured: dict[str, object] = {}

    def fake_post_json(url: str, payload: dict[str, object], token: str | None = None) -> dict[str, object]:
        captured.update(url=url, payload=payload, token=token)
        return {"version_code": payload["version_code"]}

    monkeypatch.setattr(publish_android_release, "post_json", fake_post_json)

    result = publish_android_release.publish_metadata(
        "https://api.example.com/api/v1",
        "admin-token",
        apk,
        version_name="1.0.101461",
        version_code=101461,
        min_android_version="Android 7.0",
        release_notes="Call Hub fixes",
        changelog="Call Hub fixes",
        force_update=False,
    )

    payload = captured["payload"]
    assert isinstance(payload, dict)
    assert captured["url"] == "https://api.example.com/api/v1/admin/apk/version"
    assert captured["token"] == "admin-token"
    assert payload["apk_url"] == "/api/download/apk/github/latest?version=1.0.101461"
    assert payload["file_size"] == len(b"signed-apk")
    assert payload["sha256"] == hashlib.sha256(b"signed-apk").hexdigest()
    assert result == {"version_code": 101461}
