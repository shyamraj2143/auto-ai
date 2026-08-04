from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.form_service import PortalAdapterRecord, ServiceDefinition


DEMO_SERVICE_ID = "autoai.demo-bihar-income-certificate"


def ensure_autoai_seva_demo(db: Session) -> None:
    """Create/update the safe Income Certificate simulator used by the Seva demo UI.

    The service uses the existing local verified adapter. It never contacts a government
    system and is clearly labelled as a demonstration in every user-visible field.
    """
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
            {"key": "identity", "label": "Sample identity proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152},
            {"key": "residence", "label": "Sample residence proof", "accepted": ["application/pdf", "image/jpeg", "image/png"], "max_bytes": 2097152},
            {"key": "photo", "label": "Sample applicant photograph", "accepted": ["image/jpeg", "image/png"], "max_bytes": 1048576},
        ],
        "eligibility_rules": [{"description": "This is a safe demonstration and has no legal validity."}],
        "fee": {"amount": 0, "currency": "INR", "label": "Demo — no fee"},
        "processing_information": "Immediate local verification. No information is sent to a government portal.",
        "authentication_type": "none",
        "tracking_method": "local_receipt",
        "support_contact": {"label": "AutoAI Seva demo"},
        "active": True,
        "last_verified_at": datetime.utcnow(),
    }
    if service is None:
        service = ServiceDefinition(id=DEMO_SERVICE_ID, **values)
        db.add(service)
    else:
        for key, value in values.items():
            setattr(service, key, value)

    adapter = db.scalar(
        select(PortalAdapterRecord).where(
            PortalAdapterRecord.service_id == DEMO_SERVICE_ID,
            PortalAdapterRecord.adapter_key == "autoai_seva_demo_local_verified",
        )
    )
    adapter_values = {
        "adapter_type": "local_verified",
        "enabled": True,
        "capabilities": ["prepare", "validate", "submit", "verify", "track"],
        "configuration": {
            "simulation": True,
            "service_label": "Demo Bihar Income Certificate",
            "submission_outcome": "verified",
        },
        "timeout_seconds": 30,
        "retry_policy": {"max_attempts": 1, "retry_unknown_outcome": False},
    }
    if adapter is None:
        adapter = PortalAdapterRecord(
            service_id=DEMO_SERVICE_ID,
            adapter_key="autoai_seva_demo_local_verified",
            **adapter_values,
        )
        db.add(adapter)
    else:
        for key, value in adapter_values.items():
            setattr(adapter, key, value)
    db.commit()
