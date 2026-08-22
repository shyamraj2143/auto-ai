from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    current = target.read_text(encoding="utf-8")
    if current != content:
        target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:100]!r}")
    write(path, content.replace(old, new, 1))


def patch_groq_vision() -> None:
    path = "backend/app/services/groq_service.py"
    content = read(path)
    if "from app.services.nvidia_vision_service import nvidia_vision_service" not in content:
        replace_once(
            path,
            "from app.core.config import settings\n",
            "from app.core.config import settings\nfrom app.services.nvidia_vision_service import nvidia_vision_service\n",
        )
    content = read(path)
    pattern = re.compile(r"    def analyze_image\(self, image_bytes: bytes, filename: str, prompt: str\) -> str:\n.*?(?=\n    def transcribe_audio\()", re.S)
    replacement = '''    def analyze_image(self, image_bytes: bytes, filename: str, prompt: str) -> str:\n        \"\"\"Analyze an uploaded image with Groq first and NVIDIA Vision as a real fallback.\"\"\"\n        if not image_bytes:\n            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=\"Image is empty.\")\n\n        errors: list[str] = []\n        suffix = Path(filename).suffix.lower().replace(\".\", \"\") or \"png\"\n        mime = \"jpeg\" if suffix == \"jpg\" else suffix\n        encoded = base64.b64encode(image_bytes).decode(\"ascii\")\n        messages = [{\"role\": \"user\", \"content\": [\n            {\"type\": \"text\", \"text\": prompt},\n            {\"type\": \"image_url\", \"image_url\": {\"url\": f\"data:image/{mime};base64,{encoded}\"}},\n        ]}]\n\n        try:\n            content, _, _ = self._complete_groq(\n                messages,\n                model=settings.GROQ_VISION_MODEL,\n                max_tokens=settings.GROQ_MAX_TOKENS,\n                request_timeout=90,\n            )\n            if content.strip():\n                return content.strip()\n        except Exception as exc:\n            errors.append(f\"groq:{type(exc).__name__}\")\n\n        try:\n            content = nvidia_vision_service.analyze_image(\n                image_bytes,\n                filename,\n                prompt,\n                mime_type=f\"image/{mime}\",\n                max_tokens=settings.GROQ_MAX_TOKENS,\n                timeout=90,\n            )\n            if content.strip():\n                return content.strip()\n        except Exception as exc:\n            errors.append(f\"nvidia:{type(exc).__name__}\")\n\n        detail = \"Image analysis failed for both Groq Vision and NVIDIA Vision.\"\n        if errors:\n            detail += \" Attempts: \" + \", \".join(errors)\n        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)\n'''
    updated, count = pattern.subn(replacement, content, count=1)
    if count != 1:
        raise RuntimeError("GroqService.analyze_image method was not found exactly once")
    write(path, updated)


def patch_orchestrator() -> None:
    path = "backend/app/services/orchestration/orchestrator.py"
    content = read(path)
    old = '"contributed_to_final_answer": True})'
    new = '"contributed_to_final_answer": True, "response_preview": result.content[:1200]})'
    # Add the preview to each successful model event in the normal synthesis path.
    if content.count(old):
        content = content.replace(old, new)
    old_meta = '"contributed": result.contributed} for result in results]'
    new_meta = '"contributed": result.contributed, "response_preview": (result.content or "")[:1600]} for result in results]'
    if old_meta not in content:
        raise RuntimeError("models_consulted metadata marker not found")
    content = content.replace(old_meta, new_meta, 1)
    write(path, content)


def patch_activity_ui() -> None:
    path = "frontend/src/components/chat/LiveModelActivity.tsx"
    content = read(path)
    old = '  const generatorLabel = providerLabels.length ? providerLabels.join(" + ") : "Available intelligence models";\n'
    new = old + '  type ActivityTaskWithPreview = (typeof tasks)[number] & { response_preview?: string };\n'
    if old in content and "ActivityTaskWithPreview" not in content:
        content = content.replace(old, new, 1)
    old_block = '          {tasks.map((task) => (\n            <article key={task.task_id} className={clsx("model-activity-card", `is-${task.status || "queued"}`)}>'
    new_block = '          {tasks.map((rawTask) => {\n            const task = rawTask as ActivityTaskWithPreview;\n            return (\n            <article key={task.task_id} className={clsx("model-activity-card", `is-${task.status || "queued"}`)}>'
    if old_block not in content:
        raise RuntimeError("LiveModelActivity task map marker not found")
    content = content.replace(old_block, new_block, 1)
    old_end = '              {task.failure_reason && <span className="model-activity-fallback">{task.failure_reason}</span>}\n            </article>\n          ))}'
    new_end = '              {task.failure_reason && <span className="model-activity-fallback">{task.failure_reason}</span>}\n              {task.response_preview && task.status === "completed" && (\n                <div className="model-response-preview">\n                  <span>Model response</span>\n                  <p>{task.response_preview}</p>\n                </div>\n              )}\n            </article>\n            );\n          })}'
    if old_end not in content:
        raise RuntimeError("LiveModelActivity task end marker not found")
    content = content.replace(old_end, new_end, 1)
    write(path, content)


def patch_activity_css() -> None:
    path = "frontend/src/components/chat/liveModelActivity.css"
    content = read(path)
    addition = '''\n.model-response-preview {\n  margin-top: 10px;\n  padding: 9px 10px;\n  border: 1px solid rgba(121, 183, 255, .14);\n  border-radius: 10px;\n  background: rgba(4, 13, 31, .38);\n}\n.model-response-preview > span {\n  display: block;\n  margin-bottom: 5px;\n  color: #8fa8c8;\n  font-size: 10px;\n  font-weight: 700;\n  text-transform: uppercase;\n  letter-spacing: .08em;\n}\n.model-response-preview p {\n  margin: 0;\n  color: #dce9ff;\n  font-size: 12px;\n  line-height: 1.55;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n'''
    if ".model-response-preview" not in content:
        write(path, content + addition)


patch_groq_vision()
patch_orchestrator()
patch_activity_ui()
patch_activity_css()
