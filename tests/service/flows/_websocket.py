from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any


RECEIVE_TIMEOUT_SECONDS = 5 if os.name == "nt" else 2


@dataclass(slots=True)
class WebSocketRecorder:
    """Send JSON frames and retain every received Service event."""

    connection: Any
    messages: list[dict[str, Any]] = field(default_factory=list)
    _claimed: set[int] = field(default_factory=set)

    async def send(self, message: dict[str, Any]) -> None:
        await self.connection.send(json.dumps(message))

    async def receive(self) -> dict[str, Any]:
        raw = await asyncio.wait_for(
            self.connection.recv(), timeout=RECEIVE_TIMEOUT_SECONDS,
        )
        message = json.loads(raw)
        self.messages.append(message)
        return message

    async def receive_until(self, message_type: str, *, session_id: str | None = None, for_type: str | None = None):
        def matches(message: dict[str, Any]) -> bool:
            return (
                message.get("type") == message_type
                and (session_id is None or message.get("session_id") == session_id)
                and (for_type is None or message.get("for") == for_type)
            )

        for index, message in enumerate(self.messages):
            if index not in self._claimed and matches(message):
                self._claimed.add(index)
                return message
        while True:
            message = await self.receive()
            if matches(message):
                self._claimed.add(len(self.messages) - 1)
                return message


__all__ = ["WebSocketRecorder"]
