import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


TIME_QUERY_PATTERN = re.compile(
    r"\b(date|time|datetime|clock)\b|तारीख|समय|टाइम|कितने बजे",
    re.IGNORECASE,
)
RESPONSE_LANGUAGE_PREFIX = "autoai-response-"


def response_language_instruction(locale: str) -> str:
    if not locale.startswith(RESPONSE_LANGUAGE_PREFIX):
        return ""
    preference = locale.removeprefix(RESPONSE_LANGUAGE_PREFIX)
    if preference == "en":
        return "Always answer in clear English. Keep code, commands, filenames, and technical identifiers unchanged."
    if preference == "hi":
        return "Always answer in clear Hindi using Devanagari script. Keep code, commands, filenames, and technical identifiers unchanged."
    return (
        "Match the language and script of the user's latest message. If the message mixes languages, "
        "use the dominant language while keeping code and technical identifiers unchanged."
    )


@dataclass(frozen=True)
class LiveRequestContext:
    started_at_utc: datetime
    timezone_name: str
    locale: str
    local_datetime: datetime
    request_id: str
    timezone_fallback: bool

    @classmethod
    def create(cls, timezone_name: str | None, locale: str | None) -> "LiveRequestContext":
        started = datetime.now(timezone.utc)
        requested_zone = (timezone_name or "UTC").strip()[:100]
        fallback = False
        try:
            zone = ZoneInfo(requested_zone)
        except (ZoneInfoNotFoundError, ValueError):
            requested_zone = "UTC"
            zone = timezone.utc
            fallback = True
        return cls(
            started_at_utc=started,
            timezone_name=requested_zone,
            locale=(locale or "en").strip()[:35] or "en",
            local_datetime=started.astimezone(zone),
            request_id=str(uuid.uuid4()),
            timezone_fallback=fallback,
        )

    def system_prompt(self) -> str:
        prompt = (
            "Authoritative per-request time context (server clock; never guess or replace it):\n"
            f"request_started_at_utc={self.started_at_utc.isoformat()}\n"
            f"request_started_at_epoch_ms={int(self.started_at_utc.timestamp() * 1000)}\n"
            f"user_timezone={self.timezone_name}\n"
            f"user_locale={self.locale}\n"
            f"user_local_datetime={self.local_datetime.isoformat()}\n"
            f"request_id={self.request_id}"
        )
        language_instruction = response_language_instruction(self.locale)
        return f"{prompt}\n\nResponse language instruction: {language_instruction}" if language_instruction else prompt

    def time_answer(self) -> str:
        rendered = self.local_datetime.strftime("%d %B %Y, %I:%M:%S %p")
        suffix = " (timezone unavailable; UTC fallback)" if self.timezone_fallback else ""
        return f"{rendered} ({self.timezone_name}){suffix}"


def is_time_query(value: str) -> bool:
    return bool(TIME_QUERY_PATTERN.search(value.strip()))
