from collections import deque
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import OTARecord
from bridgic.core.model.types import Message

from src.amphi_agent import (
    AmphiContext,
    AmphiOTAContext,
    ContextWindowExceededError,
    LlmProvider,
    MainThink,
    Session,
)
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


class SummaryLlm:
    """Record internal summary calls and return scripted text or failures."""

    def __init__(self, *responses: str | BaseException) -> None:
        self.responses = deque(responses)
        self.calls: list[list[Message]] = []

    async def stream_turn(self, messages, tools, *, publish, extra_body=None):
        assert tools is None
        self.calls.append(deepcopy(messages))
        response = self.responses.popleft()
        if isinstance(response, BaseException):
            raise response
        return StreamResult(
            tool_calls=[],
            content=response,
            usage=SimpleNamespace(input_tokens=5, output_tokens=2),
        )


def _turn(session_id: str, ordinal: int, content: str) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=f"turn-{ordinal}",
        user_id="local",
        session_id=session_id,
        session_ordinal=ordinal,
        user_input=UserInput(text=f"Session question {ordinal}: {content}"),
        ota_records=[{
            "think_result": {
                "step_content": f"Session answer {ordinal}: {content}",
                "tool_calls": [],
            },
        }],
        agent_state={},
        status=TurnStatus.COMPLETED,
    )


def _context(root: str, turns: list[SessionTurnRecord], capacity: int) -> AmphiContext:
    record = SessionRecord(
        id="session-compaction-policy",
        user_id="local",
        workspace_root=root,
    )
    return AmphiContext(
        session=Session(record, turns),
        llm_provider=LlmProvider(
            model_id="compaction-model",
            model_limits={"input": capacity},
        ),
    )


async def test_compacts_session_and_turn_together_while_protecting_recent_suffixes(test_sandbox: IsolatedPaths) -> None:
    """One trigger summarizes both eligible prefixes and retains four raw units per scope."""
    content = "material history " * 200
    turns = [_turn("session-compaction-policy", index, content) for index in range(6)]
    records = [
        OTARecord(think_result={
            "step_content": f"Current round {index}: {content}",
            "tool_calls": [],
        })
        for index in range(6)
    ]
    llm = SummaryLlm("Compacted Session facts", "Compacted current-Turn progress")
    worker = MainThink(llm)
    ota_context = AmphiOTAContext(
        user_input="Continue the current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
        ota_record=records,
    )
    context = _context(str(test_sandbox.sessions / "both-scopes"), turns, 200_000)
    original = await worker.assemble_messages(ota_context, context)

    compacted = await worker.compact_messages(original, [], ota_context, context, target=1)

    state = ota_context.state.context_compaction
    assert state is not None
    assert state.session_summary == "Compacted Session facts"
    assert state.session_through_ordinal == 1
    assert state.turn_summary == "Compacted current-Turn progress"
    assert state.turn_through_round == 2
    assert len(llm.calls) == 2
    assert all(call[0].content.startswith("You compress historical agent context") for call in llm.calls)
    contents = [message.content for message in compacted]
    assert not any("Session question 0" in content for content in contents)
    assert not any("Session question 1" in content for content in contents)
    assert any("Session question 2" in content for content in contents)
    assert not any("Current round 0" in content for content in contents)
    assert not any("Current round 1" in content for content in contents)
    assert any("Current round 2" in content for content in contents)
    assert worker._estimate_request_tokens(compacted, []) > 1
    assert worker.spent_tokens == 14
    assert ota_context.context_usage.input_tokens == 10
    assert ota_context.context_usage.output_tokens == 4


async def test_summary_input_is_bounded_when_one_atomic_turn_is_huge(test_sandbox: IsolatedPaths) -> None:
    """An oversized Turn is truncated as one marked unit before reaching the summary model."""
    huge = "X" * 200_000
    turns = [_turn("session-compaction-policy", 0, huge)] + [
        _turn("session-compaction-policy", index, "recent")
        for index in range(1, 5)
    ]
    llm = SummaryLlm("Bounded Session summary")
    worker = MainThink(llm)
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
    )
    context = _context(str(test_sandbox.sessions / "bounded-input"), turns, 12_000)
    original = await worker.assemble_messages(ota_context, context)

    await worker.compact_messages(original, [], ota_context, context, target=1)

    assert len(llm.calls) == 1
    assert worker._estimate_request_tokens(llm.calls[0], []) <= 6_000
    assert "bytes omitted during compaction" in llm.calls[0][1].content
    assert ota_context.state.context_compaction is not None
    assert ota_context.state.context_compaction.session_through_ordinal == 0


async def test_summary_failure_uses_a_bounded_fallback_and_advances(test_sandbox: IsolatedPaths) -> None:
    """A failed internal model call cannot leave the same eligible prefix stuck forever."""
    content = "recoverable history " * 200
    turns = [_turn("session-compaction-policy", index, content) for index in range(5)]
    worker = MainThink(SummaryLlm(RuntimeError("summary unavailable")))
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
    )
    context = _context(str(test_sandbox.sessions / "fallback"), turns, 100_000)
    original = await worker.assemble_messages(ota_context, context)

    compacted = await worker.compact_messages(original, [], ota_context, context, target=1)

    state = ota_context.state.context_compaction
    assert state is not None
    assert state.session_through_ordinal == 0
    assert state.session_summary
    assert worker._estimate_request_tokens(compacted, []) < worker._estimate_request_tokens(original, [])


async def test_protected_context_over_hard_capacity_fails_before_provider_call(test_sandbox: IsolatedPaths) -> None:
    """The soft target is best-effort, but the model's hard input capacity is enforced."""
    worker = MainThink()
    ota_context = AmphiOTAContext(user_input="Current request")
    context = _context(str(test_sandbox.sessions / "hard-capacity"), [], 500)
    messages = [Message.from_text("X" * 4_000)]

    with pytest.raises(ContextWindowExceededError) as raised:
        await worker.compact_messages(messages, [], ota_context, context, target=100)

    assert raised.value.input_capacity == 500
    assert raised.value.estimated_tokens > 500
