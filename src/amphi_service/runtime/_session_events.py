import asyncio
from collections import deque
from typing import Any, AsyncIterator, ClassVar, Deque, Dict, Optional, Set, Type

from ..protocol import (
    BuildConfirmRequestEvent,
    ContextCompactionEvent,
    ContextUsageEvent,
    HumanRequestEvent,
    LoopAbortEvent,
    ModelRetryEvent,
    PermissionRequestEvent,
    ReasoningEvent,
    StageEvent,
    TaskConfirmRequestEvent,
    TitleEvent,
    TokenEvent,
    ToolEvent,
    ToolResultEvent,
    TurnEvent,
    WorkflowConfirmRequestEvent,
    WorkflowProgressEvent,
    WorkflowResultEvent,
)


class SessionEventBroker:
    """Fan out live Agent events to every subscriber of a Session topic.

    The broker is process-scoped and event-loop bound. Subscriptions may exist
    before an Agent attempt starts and remain open across attempts. A Publisher
    retains its bounded replay buffer while its producer is open or an attached
    consumer is still draining that attempt. Durable history remains the
    responsibility of Session persistence.
    """

    DEFAULT_BUFFER_SIZE = 200
    _END = object()
    _ATTEMPT_END = object()

    class Publisher:
        """Agent-facing event sink bound to one active Session attempt."""

        _EVENT_TYPES: ClassVar[Dict[str, Type[TurnEvent]]] = {
            TokenEvent.name: TokenEvent,
            ReasoningEvent.name: ReasoningEvent,
            ModelRetryEvent.name: ModelRetryEvent,
            ToolEvent.name: ToolEvent,
            ToolResultEvent.name: ToolResultEvent,
            LoopAbortEvent.name: LoopAbortEvent,
            ContextCompactionEvent.name: ContextCompactionEvent,
            ContextUsageEvent.name: ContextUsageEvent,
            StageEvent.name: StageEvent,
            WorkflowProgressEvent.name: WorkflowProgressEvent,
            WorkflowResultEvent.name: WorkflowResultEvent,
            TitleEvent.name: TitleEvent,
            HumanRequestEvent.name: HumanRequestEvent,
            PermissionRequestEvent.name: PermissionRequestEvent,
            BuildConfirmRequestEvent.name: BuildConfirmRequestEvent,
            TaskConfirmRequestEvent.name: TaskConfirmRequestEvent,
            WorkflowConfirmRequestEvent.name: WorkflowConfirmRequestEvent,
        }

        def __init__(
            self,
            broker: "SessionEventBroker",
            session_id: str,
            buffer_size: int,
        ) -> None:
            self._broker = broker
            self.session_id = session_id
            self._buffer: Deque[TurnEvent] = deque(maxlen=buffer_size)
            self._consumers: Set[asyncio.Queue[Any]] = set()
            self._closed = False
            self._disposed = False

        @property
        def closed(self) -> bool:
            return self._closed

        @property
        def consumer_count(self) -> int:
            """Return consumers still draining this attempt."""
            return len(self._consumers)

        @property
        def buffered_event_count(self) -> int:
            """Return events retained for active-attempt replay."""
            return len(self._buffer)

        def publish(self, event: str, **payload: Any) -> None:
            """Build and publish one typed Agent event."""
            try:
                event_type = self._EVENT_TYPES[event]
            except KeyError:
                raise ValueError(
                    f"unknown event type {event!r}; known: {sorted(self._EVENT_TYPES)}"
                ) from None
            self.publish_event(event_type(**payload))

        def publish_event(self, event: TurnEvent) -> None:
            """Publish an already constructed event to this Session topic."""
            if self._closed:
                return
            self._buffer.append(event)
            self._broker._publish_nowait(self.session_id, event)

        def finish(self, event: Optional[TurnEvent] = None) -> None:
            """Seal this attempt's producer and begin consumer-side draining."""
            if self._closed:
                return
            if event is not None:
                self.publish_event(event)
            self._closed = True
            self._broker._finish(self)

    def __init__(self, *, buffer_size: int = DEFAULT_BUFFER_SIZE) -> None:
        if buffer_size <= 0:
            raise ValueError("Session event buffer size must be positive")
        self._buffer_size = buffer_size
        self._active: Dict[str, SessionEventBroker.Publisher] = {}
        self._subscribers: Dict[str, Set[asyncio.Queue[Any]]] = {}
        self._consumer_publishers: Dict[
            asyncio.Queue[Any],
            Set[SessionEventBroker.Publisher],
        ] = {}

    def open(self, session_id: str) -> Publisher:
        """Open the live event publisher for one Agent attempt.

        Parameters
        ----------
        session_id : str
            Session topic receiving the attempt's events.

        Returns
        -------
        Publisher
            Producer handle passed into the Agent's OTA context.

        Raises
        ------
        RuntimeError
            If the Session already has an active publisher.
        """
        active = self._active.get(session_id)
        if active is not None and not active.closed:
            raise RuntimeError(
                f"Session {session_id!r} already has an active event publisher"
            )
        publisher = self.Publisher(self, session_id, self._buffer_size)
        self._active[session_id] = publisher
        for queue in self._subscribers.get(session_id, ()):
            self._attach_consumer(publisher, queue)
        return publisher

    async def subscribe(self, session_id: str) -> AsyncIterator[TurnEvent]:
        """Yield replayed and future events for one Session topic."""
        queue: asyncio.Queue[Any] = asyncio.Queue()
        self._subscribers.setdefault(session_id, set()).add(queue)
        active = self._active.get(session_id)
        if active is not None:
            for event in active._buffer:
                queue.put_nowait(event)
            self._attach_consumer(active, queue)
        try:
            while True:
                event = await queue.get()
                if event is self._END:
                    return
                if (
                    isinstance(event, tuple)
                    and len(event) == 2
                    and event[0] is self._ATTEMPT_END
                ):
                    self._release_consumer(event[1], queue)
                    continue
                yield event
        finally:
            subscribers = self._subscribers.get(session_id)
            if subscribers is not None:
                subscribers.discard(queue)
                if not subscribers:
                    self._subscribers.pop(session_id, None)
            for publisher in tuple(self._consumer_publishers.get(queue, ())):
                self._release_consumer(publisher, queue)

    async def drop(self, session_id: str) -> None:
        """Drop one Session topic and terminate all of its subscriptions."""
        active = self._active.pop(session_id, None)
        if active is not None:
            active._closed = True
        for queue in self._subscribers.pop(session_id, set()):
            for publisher in tuple(self._consumer_publishers.get(queue, ())):
                self._release_consumer(publisher, queue)
            queue.put_nowait(self._END)
        if active is not None:
            self._try_dispose(active)

    def emit(self, session_id: str, event: str, **payload: Any) -> None:
        """Emit one typed event to a Session topic OUTSIDE an active attempt's
        publisher — e.g. an async title update pushed after the turn's FinalEvent
        (the attempt publisher is already finished, but the topic's subscribers
        persist across turns, so the frontend still receives it)."""
        event_type = self.Publisher._EVENT_TYPES.get(event)
        if event_type is None:
            raise ValueError(f"unknown event type {event!r}; known: {sorted(self.Publisher._EVENT_TYPES)}")
        self._publish_nowait(session_id, event_type(**payload))

    def _publish_nowait(self, session_id: str, event: TurnEvent) -> None:
        for queue in tuple(self._subscribers.get(session_id, ())):
            queue.put_nowait(event)

    def _finish(self, publisher: Publisher) -> None:
        if self._active.get(publisher.session_id) is publisher:
            self._active.pop(publisher.session_id, None)
        for queue in tuple(publisher._consumers):
            queue.put_nowait((self._ATTEMPT_END, publisher))
        self._try_dispose(publisher)

    def _attach_consumer(
        self,
        publisher: Publisher,
        queue: asyncio.Queue[Any],
    ) -> None:
        if publisher.closed or queue in publisher._consumers:
            return
        publisher._consumers.add(queue)
        self._consumer_publishers.setdefault(queue, set()).add(publisher)

    def _release_consumer(
        self,
        publisher: Publisher,
        queue: asyncio.Queue[Any],
    ) -> None:
        publisher._consumers.discard(queue)
        publishers = self._consumer_publishers.get(queue)
        if publishers is not None:
            publishers.discard(publisher)
            if not publishers:
                self._consumer_publishers.pop(queue, None)
        self._try_dispose(publisher)

    @staticmethod
    def _try_dispose(publisher: Publisher) -> None:
        if not publisher.closed or publisher._consumers or publisher._disposed:
            return
        publisher._buffer.clear()
        publisher._disposed = True


__all__ = ["SessionEventBroker"]
