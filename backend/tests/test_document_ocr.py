from types import SimpleNamespace

from app.services.document_service import document_service


def test_scanned_pdf_pages_use_vision_ocr(monkeypatch):
    page = SimpleNamespace(
        extract_text=lambda: "",
        images=[
            SimpleNamespace(data=b"small", name="small.png"),
            SimpleNamespace(data=b"largest-image", name="scan.png"),
        ],
    )
    reader = SimpleNamespace(is_encrypted=False, pages=[page])
    monkeypatch.setattr("app.services.document_service.PdfReader", lambda *_args, **_kwargs: reader)
    captured = {}
    monkeypatch.setattr(
        "app.services.document_service.groq_service.analyze_image",
        lambda data, filename, prompt: captured.update(
            data=data,
            filename=filename,
            prompt=prompt,
        ) or "VIDYA admit card\nRoll No: 12345",
    )

    extraction = document_service._extract_pdf(b"%PDF-scanned")

    assert "VIDYA admit card" in extraction.text
    assert extraction.metadata["parser"] == "pypdf+vision-ocr"
    assert extraction.metadata["ocr_pages"] == [1]
    assert captured["data"] == b"largest-image"
    assert "Do not summarize" in captured["prompt"]


def test_text_pdf_keeps_fast_path_without_ocr(monkeypatch):
    page = SimpleNamespace(extract_text=lambda: "Already readable", images=[])
    reader = SimpleNamespace(is_encrypted=False, pages=[page])
    monkeypatch.setattr("app.services.document_service.PdfReader", lambda *_args, **_kwargs: reader)
    monkeypatch.setattr(
        "app.services.document_service.groq_service.analyze_image",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("OCR should not run")),
    )

    extraction = document_service._extract_pdf(b"%PDF-text")

    assert extraction.text == "Already readable"
    assert extraction.metadata["parser"] == "pypdf"
    assert extraction.metadata["ocr_pages"] == []
