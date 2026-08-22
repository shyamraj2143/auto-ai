from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    path = ROOT / "frontend/src/features/userMessages/userMessages.css"
    content = path.read_text(encoding="utf-8")
    old = ".um-thread-copy strong {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}"
    new = ".um-thread-copy strong {\n  display: block;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.um-thread-copy strong small {\n  display: inline;\n  min-width: 0;\n  margin-left: 7px;\n  color: #94a3b8;\n  font-weight: 500;\n}\n\n@media (max-width: 599px) {\n  .um-thread-copy { min-width: 0; }\n  .um-thread-copy strong { max-width: 100%; }\n  .um-thread-copy em { max-width: 100%; }\n}"
    if old not in content:
        if new in content:
            return
        raise RuntimeError("message thread CSS pattern not found")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")
    print("Fixed mobile message thread text layout.")


if __name__ == "__main__":
    main()
