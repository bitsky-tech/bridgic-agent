"""Anthropic prompt-caching breakpoints on the agent's streaming path.

``stream_turn`` marks three ``cache_control: ephemeral`` breakpoints — the
system block, the last tool definition, and the last STABLE content block of
the message history (skipping the ``volatile_tail`` runtime-state message that
changes every round) — so each round reads the previous round's prefix from
cache at ~1/10 price instead of re-paying ~30K input tokens at full price.
A relay that rejects ``cache_control`` (400 naming it) drops caching for that
(base_url, model) and retries without it.
"""

from __future__ import annotations

from bridgic.core.model.types import Message, Role, TextBlock, ToolCallBlock, ToolResultBlock

from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_service.protocol.llms.anthropic_llm import (
    _CACHE_UNSUPPORTED,
    _REJECTED_PARAMS,
    _THINKING_TIERS,
    AnthropicConfiguration,
    AnthropicLlm,
)

_EPHEMERAL = {"type": "ephemeral"}

_TOOLS = [
    {"name": "alpha", "description": "a", "input_schema": {"type": "object", "properties": {}}},
    {"name": "beta", "description": "b", "input_schema": {"type": "object", "properties": {}}},
]


def _llm(model: str = "claude-sonnet-5") -> AnthropicLlm:
    return AnthropicLlm(api_key="k", configuration=AnthropicConfiguration(model=model))


def _reset() -> None:
    _REJECTED_PARAMS.clear()
    _THINKING_TIERS.clear()
    _CACHE_UNSUPPORTED.clear()


def _history() -> list[Message]:
    """system → user ask → assistant tool call → tool result → volatile tail."""
    return [
        Message.from_text("persona", role=Role.SYSTEM),
        Message.from_text("do the task", role=Role.USER),
        Message(
            role=Role.AI,
            blocks=[
                TextBlock(text="calling"),
                ToolCallBlock(id="c1", name="alpha", arguments={}),
            ],
            extras={"thinking_blocks": [{"type": "thinking", "thinking": "t", "signature": "S"}]},
        ),
        Message(role=Role.TOOL, blocks=[ToolResultBlock(id="c1", content="ok")]),
        Message.from_text(
            "<runtime_state>\n- Changed files: none\n</runtime_state>",
            role=Role.USER,
            extras={VOLATILE_TAIL_EXTRA: True},
        ),
    ]


def _fake_stream(seen: list):
    async def run(params, publish):
        seen.append(params)
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})
    return run


def _breakpoints(params: dict) -> list[str]:
    """Every location carrying a cache_control marker, as readable labels."""
    out = []
    system = params.get("system")
    if isinstance(system, list):
        out += [f"system[{i}]" for i, b in enumerate(system) if b.get("cache_control")]
    for i, tool in enumerate(params.get("tools") or []):
        if tool.get("cache_control"):
            out.append(f"tools[{i}]")
    for m, msg in enumerate(params.get("messages") or []):
        for b, block in enumerate(msg["content"]):
            if isinstance(block, dict) and block.get("cache_control"):
                out.append(f"messages[{m}].content[{b}]:{block.get('type')}")
    return out


async def test_stream_turn_marks_three_breakpoints_skipping_volatile_tail() -> None:
    _reset()
    seen: list = []
    llm = _llm()
    llm._run_stream = _fake_stream(seen)  # type: ignore[method-assign]

    await llm.stream_turn(_history(), _TOOLS, publish=lambda *a, **k: None)

    marks = _breakpoints(seen[0])
    assert "system[0]" in marks, "system must be a cache breakpoint"
    assert "tools[1]" in marks and "tools[0]" not in marks, "only the LAST tool def is marked"
    # The folded final user message is [tool_result, volatile text]; the rolling
    # breakpoint must sit on the tool_result — the volatile tail changes every round.
    assert any(m.endswith(":tool_result") for m in marks), marks
    volatile = [m for m in marks if m.endswith(":text") and "messages[2]" in m]
    assert not volatile, f"volatile tail must not carry a breakpoint: {marks}"
    assert len(marks) == 3
    _reset()


async def test_stream_turn_breakpoint_lands_on_last_block_without_tail() -> None:
    _reset()
    seen: list = []
    llm = _llm()
    llm._run_stream = _fake_stream(seen)  # type: ignore[method-assign]

    await llm.stream_turn(_history()[:-1], _TOOLS, publish=lambda *a, **k: None)

    marks = _breakpoints(seen[0])
    assert any(m.endswith(":tool_result") for m in marks), marks
    assert len(marks) == 3
    _reset()


async def test_stream_turn_does_not_mutate_replayed_thinking_extras() -> None:
    """Breakpoint application must copy blocks — the thinking dicts in extras are
    shared with the persisted OTA record."""
    _reset()
    history = _history()
    thinking_dict = history[2].extras["thinking_blocks"][0]
    llm = _llm()
    llm._run_stream = _fake_stream([])  # type: ignore[method-assign]

    await llm.stream_turn(history, _TOOLS, publish=lambda *a, **k: None)

    assert "cache_control" not in thinking_dict
    _reset()


async def test_stream_turn_drops_caching_when_relay_rejects_it() -> None:
    _reset()
    seen: list = []

    class _Exc400(Exception):
        status_code = 400

        def __init__(self) -> None:
            super().__init__("Error code: 400 - cache_control is not supported")
            self.body = {"error": {"message": "cache_control: Extra inputs are not permitted"}}

    async def run(params, publish):
        seen.append(params)
        if _breakpoints(params):
            raise _Exc400()
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    llm = _llm("relay-alias")
    llm._run_stream = run  # type: ignore[method-assign]

    result = await llm.stream_turn(_history(), _TOOLS, publish=lambda *a, **k: None)

    assert result.content == "done"
    assert len(seen) == 2 and not _breakpoints(seen[1])
    assert llm._reject_key() in _CACHE_UNSUPPORTED, "the rejection must be remembered"

    await llm.stream_turn(_history(), _TOOLS, publish=lambda *a, **k: None)
    assert len(seen) == 3 and not _breakpoints(seen[2]), "next turn starts without caching"
    _reset()


async def test_chat_paths_do_not_cache() -> None:
    """chat/achat (probe, classifier) are one-shot — no cache_control there."""
    _reset()
    from types import SimpleNamespace

    calls: list = []

    async def create(**params):
        calls.append(params)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="pong")])

    llm = _llm()
    llm.async_client = SimpleNamespace(messages=SimpleNamespace(create=create))
    await llm.achat([Message.from_text("ping", role=Role.USER)])

    assert not _breakpoints(calls[0])
    assert isinstance(calls[0].get("system", ""), str) or "system" not in calls[0]
    _reset()
