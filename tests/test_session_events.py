import asyncio

import pytest

from src.amphi_service.protocol import FinalEvent
from src.amphi_service.runtime import SessionEventBroker


async def test_session_event_broker_fans_out_and_keeps_subscriptions() -> None:
    broker = SessionEventBroker()
    first = broker.subscribe("session-1")
    second = broker.subscribe("session-1")

    first_event = asyncio.create_task(anext(first))
    second_event = asyncio.create_task(anext(second))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish("token", text="one")
    assert (await first_event).payload() == {"text": "one"}
    assert (await second_event).payload() == {"text": "one"}

    first_final = asyncio.create_task(anext(first))
    second_final = asyncio.create_task(anext(second))
    publisher.finish(FinalEvent(answer="done"))
    assert (await first_final).name == "final"
    assert (await second_final).name == "final"

    next_event = asyncio.create_task(anext(first))
    await asyncio.sleep(0)
    resumed = broker.open("session-1")
    resumed.publish("token", text="two")
    assert (await next_event).payload() == {"text": "two"}
    resumed.finish()

    await first.aclose()
    await second.aclose()


async def test_session_event_broker_replays_only_the_active_attempt() -> None:
    broker = SessionEventBroker(buffer_size=2)
    publisher = broker.open("session-1")
    publisher.publish("token", text="discarded")
    publisher.publish("token", text="kept-1")
    publisher.publish("token", text="kept-2")

    replay = broker.subscribe("session-1")
    assert (await anext(replay)).payload() == {"text": "kept-1"}
    assert (await anext(replay)).payload() == {"text": "kept-2"}
    publisher.finish(FinalEvent(answer="done"))
    assert (await anext(replay)).name == "final"
    await replay.aclose()

    after_finish = broker.subscribe("session-1")
    waiting = asyncio.create_task(anext(after_finish))
    await asyncio.sleep(0)
    next_attempt = broker.open("session-1")
    next_attempt.publish("token", text="new")
    assert (await waiting).payload() == {"text": "new"}
    next_attempt.finish()
    await after_finish.aclose()


async def test_session_event_stream_disposes_only_after_producer_and_consumer_release() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    received = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish("token", text="partial")
    assert (await received).payload() == {"text": "partial"}
    assert publisher.consumer_count == 1

    publisher.finish(FinalEvent(answer="done"))
    assert publisher.closed is True
    assert publisher.consumer_count == 1
    assert publisher.buffered_event_count == 2

    await subscription.aclose()
    assert publisher.consumer_count == 0
    assert publisher.buffered_event_count == 0


async def test_session_event_stream_retains_buffer_while_producer_remains() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    received = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish("token", text="partial")
    assert (await received).payload() == {"text": "partial"}

    await subscription.aclose()
    assert publisher.consumer_count == 0
    assert publisher.buffered_event_count == 1

    publisher.finish()
    assert publisher.buffered_event_count == 0


async def test_session_event_stream_waits_for_every_attached_consumer() -> None:
    broker = SessionEventBroker()
    first = broker.subscribe("session-1")
    second = broker.subscribe("session-1")
    first_event = asyncio.create_task(anext(first))
    second_event = asyncio.create_task(anext(second))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish("token", text="shared")
    assert (await first_event).payload() == {"text": "shared"}
    assert (await second_event).payload() == {"text": "shared"}
    publisher.finish()

    await first.aclose()
    assert publisher.consumer_count == 1
    assert publisher.buffered_event_count == 1

    await second.aclose()
    assert publisher.consumer_count == 0
    assert publisher.buffered_event_count == 0


async def test_session_event_stream_disposes_immediately_without_consumers() -> None:
    broker = SessionEventBroker()
    publisher = broker.open("session-1")
    publisher.publish("token", text="unobserved")

    publisher.finish(FinalEvent(answer="done"))

    assert publisher.closed is True
    assert publisher.consumer_count == 0
    assert publisher.buffered_event_count == 0


async def test_session_event_broker_drop_closes_subscribers() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    waiting = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    await broker.drop("session-1")

    with pytest.raises(StopAsyncIteration):
        await waiting


async def test_session_event_broker_does_not_retain_parked_interactions() -> None:
    broker = SessionEventBroker()
    publisher = broker.open("child-1")
    publisher.publish("token", text="not replayed")
    publisher.publish(
        "human_request",
        prompt="See [context](https://example.com).",
        questions=[{"question": "Continue?", "options": [{"label": "yes"}]}],
        request_id="request-1",
    )
    publisher.finish(FinalEvent(answer=""))

    replay = broker.subscribe("child-1")
    event = asyncio.create_task(anext(replay))
    await asyncio.sleep(0)
    assert not event.done()

    resumed = broker.open("child-1")
    resumed.publish("token", text="new attempt")
    assert (await event).payload() == {"text": "new attempt"}
    resumed.finish()
    await replay.aclose()


async def test_session_event_broker_publishes_build_confirmation() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish(
        "build_confirm_request",
        request_id="build-1",
        goal="Generate a weekly report",
        reason="The task repeats every week.",
    )

    published = await event
    assert published.name == "build_confirm_request"
    assert published.payload() == {
        "request_id": "build-1",
        "goal": "Generate a weekly report",
        "reason": "The task repeats every week.",
    }
    publisher.finish()
    await subscription.aclose()


async def test_session_event_broker_publishes_workflow_progress() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish(
        "workflow_progress",
        workflow_id="wf-report",
        generation="generation-1",
        workflow_name="生成报告",
        phase="execute",
        step_index=0,
        step_count=2,
        title="收集数据",
        status="running",
    )

    published = await event
    assert published.name == "workflow_progress"
    assert published.payload()["title"] == "收集数据"
    assert published.payload()["status"] == "running"
    assert published.payload()["generation"] == "generation-1"
    assert "run_id" not in published.payload()
    publisher.finish()
    await subscription.aclose()


async def test_session_event_broker_publishes_terminal_workflow_result() -> None:
    broker = SessionEventBroker()
    subscription = broker.subscribe("session-1")
    event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    publisher = broker.open("session-1")
    publisher.publish(
        "workflow_result",
        run_id="wfr-report",
        workflow_id="wf-report",
        workflow_name="生成报告",
        status="completed",
        validation_status="passed",
        created_at="2026-08-03T06:00:00+00:00",
        result_file_count=1,
        summary="报告已生成并通过验证。",
    )

    published = await event
    assert published.name == "workflow_result"
    assert published.payload() == {
        "run_id": "wfr-report",
        "workflow_id": "wf-report",
        "workflow_name": "生成报告",
        "status": "completed",
        "validation_status": "passed",
        "created_at": "2026-08-03T06:00:00+00:00",
        "result_file_count": 1,
        "summary": "报告已生成并通过验证。",
    }
    publisher.finish()
    await subscription.aclose()
