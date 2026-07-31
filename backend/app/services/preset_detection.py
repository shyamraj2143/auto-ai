from dataclasses import dataclass
import re


PRESETS = {"instant", "medium", "high", "deep_research", "coding"}
CODING_SYSTEM_INSTRUCTION = """
You are in Coding preset. Focus exclusively on the user's software-engineering task.
Preserve the programming language, framework, repository architecture, naming, and conventions
provided by the user. Produce complete, usable implementations instead of placeholders,
pseudocode, TODOs, or incomplete snippets. For debugging, identify the root cause, account for
related failure paths, and give concrete fixes. For refactoring, preserve behavior and public
interfaces unless the user explicitly requests a breaking change. Keep explanations concise and
technical; do not drift into generic conversation.
""".strip()

_CODING = re.compile(
    r"\b(code|coding|program|debug|bug|exception|stack trace|api|git|github|database|sql|"
    r"frontend|backend|react|typescript|javascript|python|java|kotlin|swift|rust|golang|"
    r"docker|kubernetes|css|html|function|class|repository|repo|compile|build|test|refactor)\b",
    re.IGNORECASE,
)
_RESEARCH = re.compile(
    r"\b(deep research|investigate|systematic review|literature review|compare sources|"
    r"source-backed|citations?|latest evidence|comprehensive research)\b",
    re.IGNORECASE,
)
_HIGH = re.compile(
    r"\b(prove|derive|complex|strategy|architecture|analy[sz]e|reasoning|optimi[sz]e|"
    r"trade-?offs?|root cause|design a system)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PresetResolution:
    preset_mode: str
    preset_source: str
    selected_preset: str
    detected_preset: str
    manual_preset_locked: bool


def detect_preset(message: str, *, has_attachments: bool = False) -> str:
    normalized = " ".join((message or "").strip().split())
    if _CODING.search(normalized):
        return "coding"
    if _RESEARCH.search(normalized):
        return "deep_research"
    if has_attachments:
        return "high"
    if _HIGH.search(normalized) or len(normalized) > 500:
        return "high"
    if len(normalized.split()) <= 8:
        return "instant"
    return "medium"


def resolve_preset(
    *,
    message: str,
    preset_mode: str | None,
    selected_preset: str | None,
    manual_preset_locked: bool,
    has_attachments: bool = False,
) -> PresetResolution:
    mode = "manual" if preset_mode == "manual" or manual_preset_locked else "auto"
    detected = detect_preset(message, has_attachments=has_attachments)
    if mode == "manual":
        selected = selected_preset if selected_preset in PRESETS else "medium"
        return PresetResolution("manual", "manual", selected, detected, True)
    return PresetResolution("auto", "auto", detected, detected, False)
