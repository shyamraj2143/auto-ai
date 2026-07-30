from app.core.config import settings
from app.main import create_app


def test_app_can_be_created_before_persistent_upload_directory_exists(tmp_path, monkeypatch) -> None:
    upload_dir = tmp_path / "persistent-uploads"
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(upload_dir))

    app = create_app()

    assert app is not None
    assert not upload_dir.exists()
