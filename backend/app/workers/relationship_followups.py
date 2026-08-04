import asyncio
import logging
import signal

from app.db.session import init_db
from app.services.relationship_followup_scheduler import relationship_followup_worker

logger = logging.getLogger(__name__)


async def main() -> None:
    init_db()
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def request_stop(*_: object) -> None:
        loop.call_soon_threadsafe(stop_event.set)

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, request_stop)
            except (OSError, RuntimeError, ValueError) as exc:
                logger.warning("Unable to register %s shutdown handler: %s", name, exc)
    await relationship_followup_worker(stop_event)


if __name__ == "__main__":
    asyncio.run(main())
