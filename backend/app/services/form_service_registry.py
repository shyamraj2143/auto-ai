from __future__ import annotations

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.form_service import PortalAdapterRecord, ServiceDefinition, ServicePortal


SAFE_SHORTENER_HOSTS = {"bit.ly", "tinyurl.com", "t.co", "goo.gl", "rb.gy"}


class RegistrySecurityError(ValueError):
    pass


def normalized_https_origin(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RegistrySecurityError("Portal must use an authenticated HTTPS origin")
    host = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    if host in SAFE_SHORTENER_HOSTS or parsed.port not in {None, 443}:
        raise RegistrySecurityError("Shortened or non-standard portal destinations are blocked")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        raise RegistrySecurityError("Private and local portal destinations are blocked")
    return f"https://{host}"


def validate_portal_url(portal: ServicePortal, destination: str | None = None) -> str:
    if not portal.verified:
        raise RegistrySecurityError("Portal is not verified")
    target = destination or portal.entry_url
    origin = normalized_https_origin(target)
    allowed = {portal.origin, *(portal.allowed_redirect_origins or [])}
    if origin not in allowed:
        raise RegistrySecurityError("Destination does not match the verified service portal")
    return target


@dataclass(frozen=True)
class RegistryResolution:
    service: ServiceDefinition
    portal: ServicePortal | None
    adapter: PortalAdapterRecord
    confidence: float


SERVICE_SEEDS: tuple[dict, ...] = (
    {
        "id": "autoai.safe-test-form",
        "name": "AutoAI Safe Test Form",
        "provider": "AutoAI",
        "category": "demonstration",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST", "EXECUTE_WITH_CONFIRMATION"],
        "requirements": [
            {"key": "applicant_name", "label": "Applicant name", "type": "text", "required": True, "min_length": 2, "max_length": 120, "explanation": "Name shown on the test receipt."},
            {"key": "email", "label": "Email", "type": "email", "required": True, "max_length": 254, "explanation": "Used only in this test application."},
            {"key": "date_of_birth", "label": "Date of birth", "type": "date", "required": True, "explanation": "Must be a date in the past."},
            {"key": "district", "label": "District", "type": "select", "required": True, "options": ["Patna", "Gaya", "Muzaffarpur", "Other"], "explanation": "Choose the applicable district."},
        ],
        "required_documents": [],
        "eligibility_rules": [],
        "fee": {"amount": 0, "currency": "INR", "label": "No fee"},
        "processing_information": "Immediate local test verification.",
        "authentication_type": "none",
        "tracking_method": "local_receipt",
        "support_contact": {"label": "AutoAI support"},
        "adapter": {"key": "local_verified", "type": "local_verified", "capabilities": ["prepare", "validate", "submit", "verify", "track"]},
    },
    {
        "id": "autoai.safe-test-unverified-form",
        "name": "AutoAI Unverified Outcome Test Form",
        "provider": "AutoAI",
        "category": "demonstration",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "EXECUTE_WITH_CONFIRMATION"],
        "requirements": [
            {"key": "applicant_name", "label": "Applicant name", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "email", "label": "Email", "type": "email", "required": True, "max_length": 254},
        ],
        "required_documents": [],
        "eligibility_rules": [],
        "fee": {"amount": 0, "currency": "INR", "label": "No fee"},
        "processing_information": "The test adapter intentionally returns no verifiable completion signal.",
        "authentication_type": "none",
        "tracking_method": "local_receipt",
        "support_contact": {"label": "AutoAI support"},
        "adapter": {"key": "local_unverified", "type": "local_verified", "capabilities": ["prepare", "validate", "submit", "track"], "configuration": {"submission_outcome": "unknown"}},
    },
    {
        "id": "autoai.safe-test-otp-form",
        "name": "AutoAI Safe OTP Test Form",
        "provider": "AutoAI",
        "category": "demonstration",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST", "EXECUTE_WITH_CONFIRMATION"],
        "requirements": [
            {"key": "applicant_name", "label": "Applicant name", "type": "text", "required": True, "min_length": 2, "max_length": 120, "explanation": "Name shown on the test receipt."},
            {"key": "phone", "label": "Mobile number", "type": "phone", "required": True, "pattern": "^[0-9]{10}$", "explanation": "Used only by the isolated test verification session."},
        ],
        "required_documents": [],
        "eligibility_rules": [],
        "fee": {"amount": 0, "currency": "INR", "label": "No fee"},
        "processing_information": "Immediate local test verification after a six-digit ephemeral code.",
        "authentication_type": "otp",
        "tracking_method": "local_receipt",
        "support_contact": {"label": "AutoAI support"},
        "adapter": {"key": "local_verified_otp", "type": "local_verified", "capabilities": ["prepare", "validate", "ephemeral_auth", "submit", "verify", "track"]},
    },
    {
        "id": "bihar.income-certificate",
        "name": "Bihar Income Certificate",
        "provider": "Government of Bihar — ServicePlus",
        "region": "Bihar",
        "category": "government",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST"],
        "requirements": [
            {"key": "applicant_name", "label": "Applicant name", "type": "text", "required": True, "min_length": 2, "max_length": 120, "explanation": "Enter the name exactly as on the identity document."},
            {"key": "father_name", "label": "Father's name", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "date_of_birth", "label": "Date of birth", "type": "date", "required": True},
            {"key": "district", "label": "District", "type": "text", "required": True, "min_length": 2, "max_length": 100},
            {"key": "block", "label": "Block", "type": "text", "required": True, "min_length": 2, "max_length": 100},
            {"key": "address", "label": "Address", "type": "textarea", "required": True, "min_length": 10, "max_length": 500},
            {"key": "annual_income", "label": "Annual income", "type": "number", "required": True, "min": 0, "max": 100000000},
        ],
        "required_documents": [
            {"key": "identity", "label": "Identity proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152},
            {"key": "residence", "label": "Residence proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152},
            {"key": "photo", "label": "Applicant photograph", "accepted": ["image/jpeg", "image/png"], "max_bytes": 1048576},
        ],
        "eligibility_rules": [{"description": "Applicant must provide accurate Bihar residence and income information."}],
        "fee": {"amount": None, "currency": "INR", "label": "Confirm on official portal"},
        "processing_information": "The official portal publishes service-specific delivery information.",
        "authentication_type": "portal_session",
        "tracking_method": "application_reference",
        "support_contact": {"portal": "https://serviceonline.bihar.gov.in/"},
        "portal": {"name": "RTPS Bihar ServicePlus", "origin": "https://serviceonline.bihar.gov.in", "entry_url": "https://serviceonline.bihar.gov.in/", "terms_note": "Guided user completion only; no autonomous submission is represented."},
        "adapter": {"key": "bihar_serviceplus_guided", "type": "guided_browser", "capabilities": ["prepare", "guided_open", "track"]},
    },
    {
        "id": "india.national-scholarship",
        "name": "National Scholarship Application",
        "provider": "National Scholarship Portal",
        "category": "education",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST"],
        "requirements": [
            {"key": "student_name", "label": "Student name", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "email", "label": "Email", "type": "email", "required": True, "max_length": 254},
            {"key": "phone", "label": "Mobile number", "type": "phone", "required": True, "pattern": "^[0-9]{10}$"},
            {"key": "course", "label": "Course", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "annual_income", "label": "Annual family income", "type": "number", "required": True, "min": 0, "max": 100000000},
        ],
        "required_documents": [
            {"key": "marksheet", "label": "Latest marksheet", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152},
            {"key": "photo", "label": "Student photograph", "accepted": ["image/jpeg", "image/png"], "max_bytes": 1048576},
            {"key": "signature", "label": "Student signature", "accepted": ["image/jpeg", "image/png"], "max_bytes": 524288},
        ],
        "eligibility_rules": [{"description": "Eligibility depends on the selected scholarship scheme."}],
        "fee": {"amount": None, "currency": "INR", "label": "Scheme dependent"},
        "processing_information": "Varies by scholarship scheme and verification authorities.",
        "authentication_type": "otp",
        "tracking_method": "application_reference",
        "support_contact": {"portal": "https://scholarships.gov.in/"},
        "portal": {"name": "National Scholarship Portal", "origin": "https://scholarships.gov.in", "entry_url": "https://scholarships.gov.in/", "terms_note": "Guided user completion; OTP and declarations remain user-controlled."},
        "adapter": {"key": "national_scholarship_guided", "type": "guided_browser", "capabilities": ["prepare", "guided_open", "ephemeral_auth", "track"]},
    },
    {
        "id": "india.ors-appointment",
        "name": "Government Hospital Appointment",
        "provider": "Online Registration System",
        "category": "medical",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST"],
        "requirements": [
            {"key": "patient_name", "label": "Patient name", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "phone", "label": "Mobile number", "type": "phone", "required": True, "pattern": "^[0-9]{10}$"},
            {"key": "hospital", "label": "Hospital", "type": "text", "required": True, "min_length": 2, "max_length": 180},
            {"key": "department", "label": "Department", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "preferred_date", "label": "Preferred date", "type": "date", "required": True},
        ],
        "required_documents": [],
        "eligibility_rules": [],
        "fee": {"amount": None, "currency": "INR", "label": "Hospital dependent"},
        "processing_information": "Appointment availability depends on the selected hospital and department.",
        "authentication_type": "otp",
        "tracking_method": "appointment_reference",
        "support_contact": {"portal": "https://ors.gov.in/"},
        "portal": {"name": "ORS Patient Portal", "origin": "https://ors.gov.in", "entry_url": "https://ors.gov.in/index_1_1.html", "terms_note": "User-guided booking; identity verification remains on the official portal."},
        "adapter": {"key": "ors_guided", "type": "guided_browser", "capabilities": ["prepare", "guided_open", "ephemeral_auth", "track"]},
    },
)


SERVICE_ALIASES: tuple[tuple[str, tuple[str, ...], float], ...] = (
    ("autoai.safe-test-unverified-form", ("unverified test form", "timeout test form", "unknown outcome test form"), 0.99),
    ("autoai.safe-test-otp-form", ("otp test form", "test otp form", "otp demo form", "otp वाला टेस्ट फॉर्म"), 0.99),
    (
        "bihar.income-certificate",
        (
            "income certificate",
            "incom certificate",
            "income certficate",
            "income certifcate",
            "income certificate apply",
            "aay praman",
            "aay praman patra",
            "aay certificate",
            "income praman patra",
            "आय प्रमाण",
            "आय प्रमाण पत्र",
            "इनकम सर्टिफिकेट",
        ),
        0.97,
    ),
    ("india.national-scholarship", ("scholarship", "scholar ship", "छात्रवृत्ति", "स्कॉलरशिप"), 0.96),
    ("india.ors-appointment", ("doctor appointment", "hospital appointment", "opd appointment", "डॉक्टर अपॉइंटमेंट", "अस्पताल अपॉइंटमेंट"), 0.94),
    ("autoai.safe-test-form", ("test form", "demo form", "simple information form", "टेस्ट फॉर्म"), 0.99),
)

_COMMON_CORRECTIONS = {
    "incom": "income",
    "incme": "income",
    "certficate": "certificate",
    "certifcate": "certificate",
    "certicate": "certificate",
    "sertificate": "certificate",
    "scholership": "scholarship",
    "scholarhip": "scholarship",
    "aply": "apply",
    "aplly": "apply",
}


def normalize_service_message(message: str) -> str:
    normalized = unicodedata.normalize("NFKC", message).casefold()
    normalized = re.sub(r"[^\w\s\u0900-\u097f-]", " ", normalized)
    words = [_COMMON_CORRECTIONS.get(word, word) for word in normalized.split()]
    return " ".join(words)


def _alias_score(normalized: str, alias: str) -> float:
    candidate = normalize_service_message(alias)
    if candidate in normalized:
        return 1.0
    query_tokens = set(normalized.split())
    alias_tokens = set(candidate.split())
    token_overlap = len(query_tokens & alias_tokens) / max(1, len(alias_tokens))
    sequence = SequenceMatcher(None, normalized, candidate).ratio()
    return max(token_overlap, sequence)


def match_service_alias(message: str) -> tuple[str, float] | None:
    normalized = normalize_service_message(message)
    best: tuple[str, float] | None = None
    for service_id, aliases, base_confidence in SERVICE_ALIASES:
        score = max(_alias_score(normalized, alias) for alias in aliases)
        if score < 0.78:
            continue
        confidence = round(min(base_confidence, max(0.78, score * base_confidence)), 4)
        if best is None or confidence > best[1]:
            best = (service_id, confidence)
    return best


def ensure_service_registry(db: Session) -> None:
    now = datetime.utcnow()
    for seed in SERVICE_SEEDS:
        service = db.get(ServiceDefinition, seed["id"])
        values = {key: value for key, value in seed.items() if key not in {"portal", "adapter", "id"}}
        if service is None:
            service = ServiceDefinition(id=seed["id"], last_verified_at=now, **values)
            db.add(service)
            db.flush()
        else:
            for key, value in values.items():
                setattr(service, key, value)
            service.last_verified_at = now
        portal_seed = seed.get("portal")
        if portal_seed:
            origin = normalized_https_origin(portal_seed["origin"])
            normalized_https_origin(portal_seed["entry_url"])
            portal = db.scalar(select(ServicePortal).where(ServicePortal.service_id == service.id, ServicePortal.origin == origin))
            portal_values = {**portal_seed, "origin": origin, "verified": True, "last_verified_at": now}
            if portal is None:
                portal = ServicePortal(service_id=service.id, allowed_redirect_origins=[], **portal_values)
                db.add(portal)
            else:
                for key, value in portal_values.items():
                    setattr(portal, key, value)
        adapter_seed = seed["adapter"]
        adapter = db.scalar(select(PortalAdapterRecord).where(PortalAdapterRecord.service_id == service.id, PortalAdapterRecord.adapter_key == adapter_seed["key"]))
        adapter_values = {
            "adapter_type": adapter_seed["type"],
            "capabilities": adapter_seed["capabilities"],
            "enabled": True,
            "configuration": adapter_seed.get("configuration", {}),
            "timeout_seconds": 30,
            "retry_policy": {"max_attempts": 2, "backoff_seconds": [1, 3]},
        }
        if adapter is None:
            db.add(PortalAdapterRecord(service_id=service.id, adapter_key=adapter_seed["key"], **adapter_values))
        else:
            for key, value in adapter_values.items():
                setattr(adapter, key, value)
    db.commit()


def resolve_service(db: Session, message: str) -> RegistryResolution | None:
    match = match_service_alias(message)
    if match is None:
        return None
    service = db.get(ServiceDefinition, match[0])
    if not service or not service.active:
        return None
    portal = db.scalar(select(ServicePortal).where(ServicePortal.service_id == service.id, ServicePortal.verified.is_(True)))
    adapter = db.scalar(select(PortalAdapterRecord).where(PortalAdapterRecord.service_id == service.id, PortalAdapterRecord.enabled.is_(True)))
    if not adapter:
        return None
    return RegistryResolution(service=service, portal=portal, adapter=adapter, confidence=match[1])
