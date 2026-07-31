import asyncio

from app.services.presence_fallback import ResilientPresenceService
from app.services.presence_service import PresenceService, RealtimeUnavailable


def unavailable_service() -> ResilientPresenceService:
    base = PresenceService()

    def down_client():
        raise RealtimeUnavailable("redis down")

    base.client = down_client  # type: ignore[method-assign]
    return ResilientPresenceService(base)


def test_local_ticket_is_one_time_when_redis_is_down():
    service = unavailable_service()

    async def run():
        ticket = await service.create_ticket("user-1")
        assert await service.consume_ticket(ticket) == "user-1"
        assert await service.consume_ticket(ticket) is None

    asyncio.run(run())


def test_local_presence_publish_rate_and_locks_survive_redis_outage():
    service = unavailable_service()

    async def run():
        queue = service.subscribe_local("user-2")
        await service.register_connection("user-2", "connection-1", "background")
        presence = await service.presence_for_user("user-2")
        assert presence["reachable"] is True
        assert presence["state"] == "background"

        delivered = await service.publish("user-2", {"type": "call.incoming"})
        assert delivered == 1
        assert "call.incoming" in await queue.get()

        assert await service.allow_rate("attempt", "user-1", 2, 60) is True
        assert await service.allow_rate("attempt", "user-1", 2, 60) is True
        assert await service.allow_rate("attempt", "user-1", 2, 60) is False

        assert await service.acquire_call_locks("call-1", "user-1", "user-2") is True
        assert await service.acquire_call_locks("call-2", "user-1", "user-3") is False
        await service.release_call_locks("call-1", ["user-1", "user-2"])
        assert await service.acquire_call_locks("call-2", "user-1", "user-3") is True

        assert await service.claim_event("user-1", "event-1") is True
        assert await service.claim_event("user-1", "event-1") is False
        service.unsubscribe_local("user-2", queue)

    asyncio.run(run())
