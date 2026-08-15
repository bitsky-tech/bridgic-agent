import asyncio
from typing import AsyncIterator, Dict

from ..protocol import SystemEvent


class SystemEventBroker:
    """Singleton-per-process broadcaster for :class:`SystemEvent`.

    Every subscriber carries a ``tag`` — the WS hello's ``client_type``
    ("gui" / "cli" / ...) — so producers that need a delivery guarantee
    for a *kind* of client (the scheduler's desktop-notification path)
    can use :meth:`publish_counting` and fall back when no such client
    is attached. Fan-out itself stays broadcast: tags never filter who
    receives an event, they only inform the returned count.

    Concurrency: a single :class:`asyncio.Lock` guards the subscriber
    map; publish + (un)subscribe are all event-loop bound so this is
    cheap.
    """

    def __init__(self) -> None:
        self._subscribers: Dict["asyncio.Queue[SystemEvent]", str] = {}
        self._lock = asyncio.Lock()

    # Producer-side
    async def publish(self, event: SystemEvent) -> int:
        """Fan out ``event`` to every live subscriber.

        Returns the count of subscribers the event was queued onto —
        useful for the lifespan hook's "broadcast went to N WS clients"
        instrumentation. Subscribers that were added concurrently are
        not retroactively delivered the event; we only see the set at
        the moment we hold the lock.
        """
        async with self._lock:
            return self._enqueue_all(event)

    async def publish_counting(self, event: SystemEvent, *, tag: str) -> int:
        """Fan out ``event`` to every subscriber; return the ``tag``-matching count.

        Enqueue and count happen under the same lock acquisition, so the
        returned number is exactly how many ``tag`` subscribers had the
        event queued — no separate check-then-publish race for callers
        that branch on "did a gui client get this?".
        """
        async with self._lock:
            self._enqueue_all(event)
            return sum(1 for t in self._subscribers.values() if t == tag)

    def publish_nowait(self, event: SystemEvent) -> int:
        """Fan out from synchronous Agent stream callbacks on this event loop."""
        return self._enqueue_all(event)

    def _enqueue_all(self, event: SystemEvent) -> int:
        # ``put_nowait`` is safe: queues are unbounded by default, and
        # subscribers consume from the same event loop.
        for q in self._subscribers:
            q.put_nowait(event)
        return len(self._subscribers)

    # Consumer-side
    async def subscribe(self, *, tag: str = "unknown") -> AsyncIterator[SystemEvent]:
        """Async-iterate events as they're published.

        ``tag`` labels this subscriber for :meth:`publish_counting`;
        pass the connection's ``client_type``.

        Yields forever — the iterator is meant to be driven by a task
        that gets cancelled when the consumer disconnects (typical:
        WS relay task). The ``finally`` here makes the un-subscribe
        cancel-safe.
        """
        q: "asyncio.Queue[SystemEvent]" = asyncio.Queue()
        async with self._lock:
            self._subscribers[q] = tag
        try:
            while True:
                yield await q.get()
        finally:
            async with self._lock:
                self._subscribers.pop(q, None)


__all__ = ["SystemEventBroker"]
