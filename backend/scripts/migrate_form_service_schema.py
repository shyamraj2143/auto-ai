"""Apply the additive AutoAI Service Execution Engine schema and registry."""

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app import models  # noqa: F401
from sqlalchemy import func, inspect, select

from app.db.session import SessionLocal, engine, init_db
from app.models.form_service import ServiceDefinition
from app.services.form_service_registry import ensure_service_registry


REQUIRED_TABLES = {
    "service_definitions",
    "service_portals",
    "service_tasks",
    "service_audit_events",
    "service_action_receipts",
    "service_document_assets",
    "service_human_handoffs",
    "seva_agent_profiles",
    "seva_notifications",
    "seva_assignments",
    "seva_case_events",
}


def migrate() -> None:
    init_db()
    with SessionLocal() as db:
        ensure_service_registry(db)
        registry_count = int(db.scalar(select(func.count()).select_from(ServiceDefinition)) or 0)
    present = set(inspect(engine).get_table_names())
    missing = sorted(REQUIRED_TABLES - present)
    if missing:
        raise RuntimeError(f"Form service schema validation failed; missing tables: {', '.join(missing)}")
    if registry_count < 6:
        raise RuntimeError("Form service registry validation failed; expected at least six services")
    print(f"Validated {len(REQUIRED_TABLES)} required tables and {registry_count} service definitions.")


if __name__ == "__main__":
    migrate()
    print("Form service schema and verified registry are current.")
