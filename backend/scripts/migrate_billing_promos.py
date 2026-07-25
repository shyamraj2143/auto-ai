"""Apply the additive billing/promo schema using the project's runtime migration convention."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import models  # noqa: F401
from app.db.base import Base
from app.db.session import engine, ensure_runtime_schema


def main() -> None:
    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    print("Billing promo and receipt schema is up to date.")


if __name__ == "__main__":
    main()
