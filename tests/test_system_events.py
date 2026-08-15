"""SystemEventBroker fan-out: tagged subscription + counting publish.

The tag ("gui" / "cli" / ...) mirrors the WS hello's ``client_type``;
``publish_counting`` is the scheduler's atomic "did any GUI actually get
this?" primitive — the count and the enqueue happen under one lock, so
there is no check-then-publish race.
"""

from __future__ import annotations

import asyncio
import contextlib

from src.amphi_service.protocol import SystemShutdownEvent
from src.amphi_service.runtime import SystemEventBroker


async def _subscribed(broker: SystemEventBroker, tag: str):
    """Start a subscription and return (generator, first-event task).

    ``subscribe`` is an async generator: registration only happens once the
    first ``__anext__`` runs, hence the sleep(0) to let the task start.
    """
    gen = broker.subscribe(tag=tag)
    task = asyncio.create_task(anext(gen))
    await asyncio.sleep(0)
    return gen, task


async def test_publish_counting_counts_only_matching_tag() -> None:
    broker = SystemEventBroker()
    gui_gen, gui_task = await _subscribed(broker, "gui")
    cli_gen, cli_task = await _subscribed(broker, "cli")

    event = SystemShutdownEvent(reason="x")
    delivered = await broker.publish_counting(event, tag="gui")

    assert delivered == 1
    # Fan-out is still broadcast: BOTH subscribers receive the event.
    assert await gui_task is event
    assert await cli_task is event
    await gui_gen.aclose()
    await cli_gen.aclose()


async def test_publish_counting_zero_after_gui_unsubscribes() -> None:
    broker = SystemEventBroker()
    gui_gen, gui_task = await _subscribed(broker, "gui")
    # Cancel the pending anext() first — the CancelledError unwinds the
    # generator body, running its cleanup; aclose() is then a no-op.
    gui_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await gui_task
    await gui_gen.aclose()

    delivered = await broker.publish_counting(SystemShutdownEvent(), tag="gui")

    assert delivered == 0


async def test_publish_counting_zero_when_only_other_tags_online() -> None:
    broker = SystemEventBroker()
    cli_gen, cli_task = await _subscribed(broker, "cli")

    delivered = await broker.publish_counting(SystemShutdownEvent(), tag="gui")

    assert delivered == 0
    # The cli subscriber still received the broadcast frame.
    assert isinstance(await cli_task, SystemShutdownEvent)
    await cli_gen.aclose()


async def test_publish_still_returns_total_subscriber_count() -> None:
    broker = SystemEventBroker()
    gui_gen, gui_task = await _subscribed(broker, "gui")
    cli_gen, cli_task = await _subscribed(broker, "cli")

    total = await broker.publish(SystemShutdownEvent())

    assert total == 2
    await gui_task
    await cli_task
    await gui_gen.aclose()
    await cli_gen.aclose()
