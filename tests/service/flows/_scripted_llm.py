from __future__ import annotations

import asyncio
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from bridgic.core.model.types import Message, Response, Role, TokenUsage

from src.amphi_service.protocol.llms._streaming import StreamResult


FLOW_MODEL = "flow-model"


@dataclass(frozen=True, slots=True)
class LlmCall:
    """One immutable snapshot of a call made by the Agent."""

    messages: list[Message]
    tools: list[Any] | None
    extra_body: dict[str, Any] | None


class ScriptGate:
    """Hold one scripted response until the test releases or cancels it."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.released = asyncio.Event()

    async def wait_started(self) -> None:
        await asyncio.wait_for(self.started.wait(), timeout=2)

    async def wait(self) -> None:
        self.started.set()
        await self.released.wait()

    def release(self) -> None:
        self.released.set()


@dataclass(frozen=True, slots=True)
class ScriptedTurn:
    """The model result consumed by one Agent reasoning round."""

    content: str = ""
    chunks: tuple[str, ...] = ()
    reasoning: str = ""
    tool_calls: tuple[dict[str, Any], ...] = ()
    input_tokens: int = 0
    output_tokens: int = 0
    error: BaseException | None = None
    gate: ScriptGate | None = None
    match_last_role: Role | None = None


@dataclass(slots=True)
class ScriptedLlm:
    """A strict in-memory LLM used only at the external model boundary."""

    model: str
    title: str = "Flow session"
    protocol: str = "openai"
    api_base: str = "http://model.invalid/v1"
    configuration: Any = field(init=False)
    turn_calls: list[LlmCall] = field(default_factory=list, init=False)
    chat_calls: list[list[Message]] = field(default_factory=list, init=False)
    _turns: deque[ScriptedTurn] = field(default_factory=deque, init=False)
    _unexpected_calls: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.configuration = SimpleNamespace(model=self.model)

    def enqueue_text(
        self,
        content: str,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        chunks: tuple[str, ...] = (),
        reasoning: str = "",
        match_last_role: Role | None = None,
    ) -> None:
        self._turns.append(ScriptedTurn(
            content=content,
            chunks=chunks,
            reasoning=reasoning,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            match_last_role=match_last_role,
        ))

    def enqueue_tool(self, name: str, arguments: dict[str, Any], *, call_id: str = "call_flow") -> None:
        self._turns.append(ScriptedTurn(tool_calls=(
            {"name": name, "arguments": arguments, "call_id": call_id},
        )))

    def enqueue_tools(self, calls: list[tuple[str, dict[str, Any], str]]) -> None:
        self._turns.append(ScriptedTurn(tool_calls=tuple(
            {"name": name, "arguments": arguments, "call_id": call_id}
            for name, arguments, call_id in calls
        )))

    def enqueue_error(self, error: BaseException) -> None:
        self._turns.append(ScriptedTurn(error=error))

    def enqueue_blocked(self, content: str = "", *, match_last_role: Role | None = None) -> ScriptGate:
        gate = ScriptGate()
        self._turns.append(ScriptedTurn(content=content, gate=gate, match_last_role=match_last_role))
        return gate

    async def stream_turn(
        self,
        messages: list[Message],
        tools: list[Any] | None,
        *,
        publish: Any,
        extra_body: dict[str, Any] | None = None,
    ) -> StreamResult:
        self.turn_calls.append(LlmCall(
            messages=deepcopy(messages),
            tools=deepcopy(tools),
            extra_body=deepcopy(extra_body),
        ))
        if not self._turns:
            self._unexpected_calls += 1
            raise AssertionError("The Agent made an unscripted LLM turn call")
        if self._turns[0].match_last_role is None:
            turn = self._turns.popleft()
        else:
            last_role = messages[-1].role if messages else None
            index = next((
                index for index, candidate in enumerate(self._turns)
                if candidate.match_last_role is last_role
            ), None)
            if index is None:
                self._unexpected_calls += 1
                raise AssertionError(f"No scripted LLM turn matches final role {last_role!r}")
            turn = self._turns[index]
            del self._turns[index]
        if turn.error is not None:
            raise turn.error
        if turn.reasoning:
            publish("reasoning", text=turn.reasoning)
        for chunk in turn.chunks or ((turn.content,) if turn.content else ()):
            publish("token", text=chunk)
        if turn.gate is not None:
            await turn.gate.wait()
        usage = TokenUsage(
            model=self.model,
            prompt_tokens=turn.input_tokens,
            completion_tokens=turn.output_tokens,
            total_tokens=turn.input_tokens + turn.output_tokens,
        )
        return StreamResult(
            tool_calls=list(turn.tool_calls),
            content=turn.content,
            usage=usage,
        )

    async def achat(self, messages: list[Message], **_: Any) -> Response:
        self.chat_calls.append(deepcopy(messages))
        return Response(message=Message.from_text(self.title, role=Role.AI))

    def assert_finished(self) -> None:
        assert not self._turns, f"{len(self._turns)} scripted LLM turn(s) were not consumed"
        assert self._unexpected_calls == 0, f"{self._unexpected_calls} unscripted LLM turn(s) occurred"


__all__ = ["FLOW_MODEL", "LlmCall", "ScriptGate", "ScriptedLlm"]
