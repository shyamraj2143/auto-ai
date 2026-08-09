from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.form_service import PortalAdapterRecord, ServiceDefinition


DEMO_SERVICE_ID = "autoai.demo-bihar-income-certificate"
ASSISTED_REQUEST_SERVICE_ID = "autoai.seva-assisted-request"
BIHAR_INCOME_SERVICE_ID = "bihar.income-certificate"
CATALOGUE_VERSION = "2026-08-07"


def _upsert_adapter(db: Session, service_id: str, adapter_key: str, values: dict) -> None:
    adapter = db.scalar(
        select(PortalAdapterRecord).where(
            PortalAdapterRecord.service_id == service_id,
            PortalAdapterRecord.adapter_key == adapter_key,
        )
    )
    if adapter is None:
        adapter = PortalAdapterRecord(service_id=service_id, adapter_key=adapter_key, **values)
        db.add(adapter)
    else:
        for key, value in values.items():
            setattr(adapter, key, value)


def _upsert_demo_service(db: Session) -> None:
    service = db.get(ServiceDefinition, DEMO_SERVICE_ID)
    values = {
        "name": "Demo Bihar Income Certificate",
        "provider": "AutoAI Safe Government-Service Simulator",
        "country": "IN",
        "region": "Bihar",
        "category": "demonstration",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST", "EXECUTE_WITH_CONFIRMATION"],
        "requirements": [
            {"key": "applicant_name", "label": "Applicant name / आवेदक का नाम", "type": "text", "required": True, "min_length": 2, "max_length": 120, "explanation": "Demo only. Enter the name exactly as shown on your sample identity document."},
            {"key": "father_name", "label": "Father's name / पिता का नाम", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "date_of_birth", "label": "Date of birth / जन्म तिथि", "type": "date", "required": True},
            {"key": "mobile", "label": "Mobile number / मोबाइल नंबर", "type": "phone", "required": True, "pattern": "^[0-9]{10}$"},
            {"key": "district", "label": "District / जिला", "type": "select", "required": True, "options": ["Patna", "Gaya", "Muzaffarpur", "Nalanda", "Darbhanga", "Bhagalpur", "Other"]},
            {"key": "block", "label": "Block / प्रखंड", "type": "text", "required": True, "min_length": 2, "max_length": 100},
            {"key": "address", "label": "Present address / वर्तमान पता", "type": "textarea", "required": True, "min_length": 10, "max_length": 500},
            {"key": "occupation", "label": "Occupation / व्यवसाय", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "annual_income", "label": "Annual household income / वार्षिक पारिवारिक आय", "type": "number", "required": True, "min": 0, "max": 100000000},
            {"key": "certificate_purpose", "label": "Certificate purpose / प्रमाण पत्र का उद्देश्य", "type": "select", "required": True, "options": ["Education", "Scholarship", "Government scheme", "Banking", "Other"]},
            {"key": "declaration", "label": "I confirm the demo details are accurate", "type": "checkbox", "required": True},
        ],
        "required_documents": [
            {"key": "identity", "label": "Sample identity proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152, "required": True},
            {"key": "residence", "label": "Sample residence proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152, "required": True},
            {"key": "photo", "label": "Sample applicant photograph", "accepted": ["image/jpeg", "image/png"], "max_bytes": 1048576, "required": True},
        ],
        "eligibility_rules": [{"description": "This is a safe demonstration and has no legal validity."}],
        "fee": {"amount": 0, "currency": "INR", "label": "Demo — no fee"},
        "processing_information": "Immediate local verification. No information is sent to a government portal.",
        "authentication_type": "none",
        "tracking_method": "local_receipt",
        "support_contact": {
            "label": "AutoAI Seva demo",
            "service_code": "AUTOAI_DEMO_BR_INCOME_CERTIFICATE",
            "catalogue_version": CATALOGUE_VERSION,
            "declaration_version": "autoai-seva-declaration-v1",
            "legal_validity": False,
        },
        "active": True,
        "last_verified_at": datetime.utcnow(),
    }
    if service is None:
        service = ServiceDefinition(id=DEMO_SERVICE_ID, **values)
        db.add(service)
    else:
        for key, value in values.items():
            setattr(service, key, value)

    _upsert_adapter(
        db,
        DEMO_SERVICE_ID,
        "autoai_seva_demo_local_verified",
        {
            "adapter_type": "local_verified",
            "enabled": True,
            "capabilities": ["prepare", "validate", "submit", "verify", "track", "ephemeral_auth"],
            "configuration": {
                "simulation": True,
                "service_label": "Demo Bihar Income Certificate",
                "submission_outcome": "verified",
                "demo_scenario": "success",
                "adapter_version": "autoai-seva-demo-v1",
                "kill_switch_active": False,
                "government_submission": False,
            },
            "timeout_seconds": 30,
            "retry_policy": {"max_attempts": 1, "retry_unknown_outcome": False},
        },
    )


def _upsert_assisted_request_service(db: Session) -> None:
    """Fallback for services not yet represented by a verified portal adapter."""
    service = db.get(ServiceDefinition, ASSISTED_REQUEST_SERVICE_ID)
    values = {
        "name": "AutoAI Seva Assisted Application Request",
        "provider": "AutoAI Seva Operations",
        "country": "IN",
        "region": None,
        "category": "assisted-service",
        "verified": True,
        "execution_modes": ["EXPLAIN", "PREPARE", "ASSIST"],
        "requirements": [
            {"key": "requested_service", "label": "What do you want to apply for? / क्या अप्लाई करना है?", "type": "textarea", "required": True, "min_length": 3, "max_length": 500, "explanation": "Describe the certificate, scholarship, admission, licence or other service."},
            {"key": "applicant_name", "label": "Applicant name / आवेदक का नाम", "type": "text", "required": True, "min_length": 2, "max_length": 120},
            {"key": "mobile", "label": "Mobile number / मोबाइल नंबर", "type": "phone", "required": True, "pattern": "^[0-9]{10}$"},
            {"key": "state", "label": "State / राज्य", "type": "text", "required": True, "min_length": 2, "max_length": 100},
            {"key": "district", "label": "District / जिला", "type": "text", "required": False, "max_length": 100},
            {"key": "preferred_language", "label": "Preferred language / भाषा", "type": "select", "required": True, "options": ["Hindi", "English", "Hinglish"]},
            {"key": "request_notes", "label": "Additional details / अतिरिक्त जानकारी", "type": "textarea", "required": False, "max_length": 1000},
        ],
        "required_documents": [],
        "eligibility_rules": [{"description": "An AutoAI employee confirms the official requirements before any external action."}],
        "fee": {"amount": None, "currency": "INR", "label": "Confirmed before submission"},
        "processing_information": "After the user submits the completed form, the request is automatically assigned to an eligible AutoAI Seva agent.",
        "authentication_type": "user_controlled",
        "tracking_method": "employee_work_order",
        "support_contact": {
            "label": "AutoAI Seva Operations",
            "service_code": "AUTOAI_SEVA_ASSISTED_REQUEST",
            "catalogue_version": CATALOGUE_VERSION,
            "protected_actions": ["otp", "captcha", "password", "payment", "final_submit"],
            "secret_policy": "Employees may request completion of a protected action but cannot receive or store the raw secret.",
        },
        "active": True,
        "last_verified_at": datetime.utcnow(),
    }
    if service is None:
        service = ServiceDefinition(id=ASSISTED_REQUEST_SERVICE_ID, **values)
        db.add(service)
    else:
        for key, value in values.items():
            setattr(service, key, value)

    _upsert_adapter(
        db,
        ASSISTED_REQUEST_SERVICE_ID,
        "autoai_seva_human_assistance",
        {
            "adapter_type": "human_handoff",
            "enabled": True,
            "capabilities": ["prepare", "human_handoff", "requirements", "deliverable", "track"],
            "configuration": {
                "employee_queue": True,
                "auto_submit": False,
                "government_submission": False,
                "raw_secret_sharing": False,
                "adapter_version": "autoai-seva-handoff-v1",
            },
            "timeout_seconds": 30,
            "retry_policy": {"max_attempts": 0, "retry_unknown_outcome": False},
        },
    )


def _harden_bihar_income_service(db: Session) -> None:
    service = db.get(ServiceDefinition, BIHAR_INCOME_SERVICE_ID)
    if not service:
        return
    service.execution_modes = ["EXPLAIN", "PREPARE", "ASSIST"]
    service.authentication_type = "portal_session"
    service.tracking_method = "application_reference"
    service.processing_information = (
        "AutoAI prepares the application. Delivery time, document requirements and final status "
        "must be confirmed on the official Bihar ServicePlus portal."
    )
    service.fee = {
        "amount": None,
        "currency": "INR",
        "label": "Confirm on the official portal before submission",
        "source_verified_at": CATALOGUE_VERSION,
    }
    service.required_documents = [
        {"key": "identity", "label": "Identity proof, if requested by the official form", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152, "required": False, "verification_status": "CONFIRM_ON_OFFICIAL_PORTAL"},
        {"key": "residence", "label": "Residence proof, if requested by the official form", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152, "required": False, "verification_status": "CONFIRM_ON_OFFICIAL_PORTAL"},
        {"key": "photo", "label": "Applicant photograph, if requested by the official form", "accepted": ["image/jpeg", "image/png"], "max_bytes": 1048576, "required": False, "verification_status": "CONFIRM_ON_OFFICIAL_PORTAL"},
    ]
    support = dict(service.support_contact or {})
    support.update(
        {
            "portal": "https://serviceonline.bihar.gov.in/",
            "source_url": "https://serviceonline.bihar.gov.in/",
            "source_verified_at": CATALOGUE_VERSION,
            "service_code": "BR_INCOME_CERTIFICATE_BLOCK",
            "catalogue_version": CATALOGUE_VERSION,
            "declaration_version": "autoai-seva-declaration-v1",
            "execution_mode_default": "USER_ASSISTED_BROWSER",
            "protected_actions": ["otp", "captcha", "declaration", "final_submit"],
            "document_requirement_note": "Confirm the current evidence list on the official portal.",
        }
    )
    service.support_contact = support
    service.last_verified_at = datetime.utcnow()

    adapter = db.scalar(
        select(PortalAdapterRecord).where(
            PortalAdapterRecord.service_id == BIHAR_INCOME_SERVICE_ID,
            PortalAdapterRecord.adapter_key == "bihar_serviceplus_guided",
        )
    )
    if adapter:
        configuration = dict(adapter.configuration or {})
        configuration.update(
            {
                "adapter_version": "bihar-serviceplus-assisted-v1",
                "catalogue_version": CATALOGUE_VERSION,
                "kill_switch_active": False,
                "assisted_only": True,
                "auto_submit": False,
                "government_submission": False,
            }
        )
        adapter.configuration = configuration
        adapter.enabled = True
        adapter.capabilities = ["prepare", "guided_open", "track", "user_reported_outcome", "human_handoff"]
        adapter.retry_policy = {"max_attempts": 0, "retry_unknown_outcome": False}


def ensure_autoai_seva_demo(db: Session) -> None:
    """Create safe demo, generic assisted fallback and hardened Bihar catalogue entry."""
    _upsert_demo_service(db)
    _upsert_assisted_request_service(db)
    _harden_bihar_income_service(db)
    db.commit()
