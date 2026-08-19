"""DeepSeek thinking-mode passback — capture the assistant turn's reasoning and
replay it on the next request, for BOTH protocols.

DeepSeek (thinking mode) rejects a follow-up whose assistant turn made parallel
tool calls unless that turn's reasoning is passed back: the Anthropic endpoint
wants a ``thinking`` content block, the OpenAI endpoint wants a top-level
``reasoning_content`` field (errors: ``content[].thinking`` / ``reasoning_content``
"must be passed back to the API"). The framework dropped both. These tests pin
the capture (``_stream_*`` → round record) → carry (``turn_messages`` extras) →
emit (provider adapter) chain.
"""

from __future__ import annotations

import asyncio

from anthropic.types import (
    InputJSONDelta,
    RawContentBlockDeltaEvent,
    RawContentBlockStartEvent,
    RawContentBlockStopEvent,
    SignatureDelta,
    ThinkingBlock,
    ThinkingDelta,
    ToolUseBlock,
)
from bridgic.core.model.types import Message, Role, TextBlock, ToolCallBlock
from bridgic.llms.openai import OpenAIConfiguration, OpenAILlm

from src.amphi_agent import AmphiContext, AmphiOTAContext
from src.amphi_agent._cognitive import MainThink
from src.amphi_agent._state import BuildStageState
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicLlm


def _ai_toolcall_msg(extras: dict) -> Message:
    """An assistant turn that called a tool, with optional reasoning in ``extras``."""
    return Message(
        role=Role.AI,
        blocks=[
            TextBlock(text="let me check"),
            ToolCallBlock(id="c1", name="get_weather", arguments={"city": "BJ"}),
        ],
        extras=extras,
    )


############################################################################
# Anthropic adapter — emit the thinking block, first, in the assistant content
############################################################################
def test_anthropic_emits_thinking_block_first() -> None:
    """A captured thinking block on ``extras`` becomes content[0] of the assistant
    message (Anthropic requires thinking before text/tool_use)."""
    llm = AnthropicLlm(api_key="k")
    tb = [{"type": "thinking", "thinking": "reasoning...", "signature": "SIG"}]
    _, api = llm._extract_system_and_messages([
        Message.from_text("ask", role=Role.USER),
        _ai_toolcall_msg({"thinking_blocks": tb}),
    ])
    content = api[-1]["content"]
    assert content[0] == {"type": "thinking", "thinking": "reasoning...", "signature": "SIG"}
    assert [b["type"] for b in content] == ["thinking", "text", "tool_use"]


def test_anthropic_no_thinking_without_extras() -> None:
    """No captured reasoning → no thinking block (unchanged behavior)."""
    llm = AnthropicLlm(api_key="k")
    _, api = llm._extract_system_and_messages([
        Message.from_text("ask", role=Role.USER),
        _ai_toolcall_msg({}),
    ])
    assert [b["type"] for b in api[-1]["content"]] == ["text", "tool_use"]


def test_anthropic_thinking_first_after_fold() -> None:
    """When a thought-only AI message folds into the tool-call AI message, the
    thinking block still ends up first in the merged content."""
    llm = AnthropicLlm(api_key="k")
    tb = [{"type": "thinking", "thinking": "r", "signature": "S"}]
    _, api = llm._extract_system_and_messages([
        Message.from_text("ask", role=Role.USER),
        Message.from_text("thought-only", role=Role.AI),
        _ai_toolcall_msg({"thinking_blocks": tb}),
    ])
    assistant = [m for m in api if m["role"] == "assistant"]
    assert len(assistant) == 1  # the two AI messages folded
    types = [b["type"] for b in assistant[0]["content"]]
    assert types[0] == "thinking"
    assert types.index("thinking") < types.index("text") < types.index("tool_use")


############################################################################
# OpenAI adapter — emit reasoning_content via Message.extras (already splatted)
############################################################################
def test_openai_emits_reasoning_content_from_extras() -> None:
    """The bridgic OpenAI adapter splats ``message.extras`` onto the assistant
    message, so a captured ``reasoning_content`` rides along automatically."""
    llm = OpenAILlm(api_key="k", configuration=OpenAIConfiguration(model="deepseek-chat"))
    msg = _ai_toolcall_msg({"reasoning_content": "reasoning..."})
    out = llm._convert_chat_completions_message(msg)
    assert out["role"] == "assistant"
    assert out["reasoning_content"] == "reasoning..."
    assert out.get("tool_calls")


############################################################################
# turn_messages — carry the captured reasoning on the rebuilt AI message
############################################################################
def _ota_with_record(record_extra: dict) -> AmphiOTAContext:
    record = {
        "think_result": {"step_content": "let me check", "tool_calls": ["x"]},
        "action_result": {"results": [{
            "tool_id": "c1", "tool_name": "get_weather",
            "tool_arguments": {"city": "BJ"}, "tool_result": "ok", "success": True}]},
    }
    record.update(record_extra)
    return AmphiOTAContext.model_validate({"user_input": "go", "ota_record": [record]})


def _turn_messages(ota: AmphiOTAContext) -> list:
    return MainThink().turn_messages_block(ota, None)


def test_turn_messages_attaches_thinking_blocks() -> None:
    tb = [{"type": "thinking", "thinking": "r", "signature": "S"}]
    msgs = _turn_messages(_ota_with_record({"thinking_blocks": tb}))
    assert msgs[0].role == Role.AI
    assert msgs[0].extras.get("thinking_blocks") == tb


def test_turn_messages_attaches_reasoning_content() -> None:
    msgs = _turn_messages(_ota_with_record({"reasoning_content": "r"}))
    assert msgs[0].extras.get("reasoning_content") == "r"


def test_turn_messages_no_extras_without_capture() -> None:
    """No round ever reasoned → not a thinking model → no extras, no fallback."""
    msgs = _turn_messages(_ota_with_record({}))
    assert not msgs[0].extras


def test_turn_messages_attaches_reasoning_details() -> None:
    """OpenRouter: a round's captured structured ``reasoning_details`` ride on the
    rebuilt AI tool-call message's extras (bridgic splats them onto the wire so the
    routed model gets its signed reasoning back verbatim)."""
    rd = [{"type": "reasoning.text", "text": "r", "signature": "S", "index": 0}]
    msgs = _turn_messages(_ota_with_record({"reasoning_details": rd}))
    assert msgs[0].role == Role.AI
    assert msgs[0].extras.get("reasoning_details") == rd


def test_turn_messages_no_reasoning_details_without_capture() -> None:
    """A round that captured only plaintext reasoning (non-OpenRouter / unsigned)
    gets no ``reasoning_details`` key — added only when actually present."""
    msgs = _turn_messages(_ota_with_record({"reasoning_content": "r"}))
    assert "reasoning_details" not in (msgs[0].extras or {})


def test_turn_messages_attaches_thought_signatures() -> None:
    """Gemini: the round's captured per-call signatures ride on the rebuilt AI
    message's extras (GoogleLlm reads them to re-sign the function_call parts)."""
    sigs = ["c2lnMA=="]
    msgs = _turn_messages(_ota_with_record({"thought_signatures": sigs}))
    assert msgs[0].role == Role.AI
    assert msgs[0].extras.get("thought_signatures") == sigs


def test_turn_messages_skips_misaligned_signatures() -> None:
    """If the model emitted more calls than were executed (one dropped as an
    unknown-tool hallucination), the captured signature list is longer than the
    replayed calls — attaching by index would bind the wrong signature, so the
    whole list is skipped rather than misaligned."""
    # _ota_with_record builds a record with ONE executed step; pass TWO sigs.
    msgs = _turn_messages(_ota_with_record({"thought_signatures": ["sig_a", "sig_b"]}))
    assert "thought_signatures" not in (msgs[0].extras or {})


def _ota_two_tool_rounds(r0_extra: dict, r1_extra: dict) -> AmphiOTAContext:
    def rec(extra: dict) -> dict:
        d = {
            "think_result": {"step_content": "t", "tool_calls": ["x"]},
            "action_result": {"results": [{
                "tool_id": "c", "tool_name": "get_weather",
                "tool_arguments": {"city": "BJ"}, "tool_result": "ok", "success": True}]},
        }
        d.update(extra)
        return d
    return AmphiOTAContext.model_validate(
        {"user_input": "go", "ota_record": [rec(r0_extra), rec(r1_extra)]})


def test_turn_messages_openai_empty_reasoning_fallback() -> None:
    """Thinking mode active (round 0 reasoned) but round 1 emitted none → round 1
    still gets a ``reasoning_content`` field (empty), which DeepSeek requires."""
    msgs = _turn_messages(_ota_two_tool_rounds({"reasoning_content": "r0"}, {}))
    ai0, ai1 = msgs[0], msgs[2]
    assert ai0.extras["reasoning_content"] == "r0"
    assert ai1.extras["reasoning_content"] == ""


def test_turn_messages_anthropic_round_without_thinking_gets_no_fake_block() -> None:
    """Anthropic shape: adaptive thinking may skip a round entirely (Sonnet 5 on a
    trivial tool-call round). That round must replay WITHOUT a thinking block — a
    synthesized ``{"thinking": "", "signature": ""}`` has no valid signature and
    Anthropic (and relays in front of it) 400 with "each thinking block must
    contain thinking"."""
    tb = [{"type": "thinking", "thinking": "", "signature": "S"}]
    msgs = _turn_messages(_ota_two_tool_rounds({"thinking_blocks": tb}, {}))
    ai0, ai1 = msgs[0], msgs[2]
    assert ai0.extras["thinking_blocks"] == tb
    assert "thinking_blocks" not in (ai1.extras or {})


############################################################################
# OpenAICompatLlm.stream_turn — capture reasoning_content onto the round record
############################################################################
class _Delta:
    def __init__(self, *, reasoning=None, content=None, tool_calls=None, reasoning_details=None) -> None:
        self.reasoning_content = reasoning
        self.content = content
        self.tool_calls = tool_calls or []
        self.reasoning_details = reasoning_details


class _Choice:
    def __init__(self, delta) -> None:
        self.delta = delta


class _Chunk:
    def __init__(self, *, delta=None, usage=None) -> None:
        self.choices = [_Choice(delta)] if delta is not None else []
        self.usage = usage


class _AsyncIter:
    def __init__(self, items) -> None:
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)

    async def close(self) -> None:
        pass


class _FakeOpenAIClient:
    def __init__(self, resp) -> None:
        async def _create(**_kw):
            return resp
        self.chat = type("C", (), {"completions": type("CC", (), {"create": staticmethod(_create)})()})()


async def test_openai_stream_turn_captures_reasoning_content() -> None:
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm
    resp = _AsyncIter([
        _Chunk(delta=_Delta(reasoning="think ")),
        _Chunk(delta=_Delta(reasoning="more")),
        _Chunk(delta=_Delta(content="hi")),
    ])
    llm = OpenAICompatLlm(api_key="k")
    llm.async_client = _FakeOpenAIClient(resp)
    collected: list = []
    result = await llm.stream_turn([], None, publish=lambda c, **k: collected.append((c, k)))
    assert result.content == "hi"
    assert result.tool_calls == []
    assert result.capture == {"reasoning_content": "think more"}
    assert ("reasoning", {"text": "think "}) in collected


async def test_openai_stream_turn_captures_reasoning_details() -> None:
    """OpenRouter returns BOTH plaintext ``reasoning`` and structured
    ``reasoning_details``; the adapter captures the per-index-merged details
    (signature preserved) alongside the plaintext, so a signature-class routed
    model (Claude/Gemini) can replay them on the next tool-call turn."""
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm
    resp = _AsyncIter([
        _Chunk(delta=_Delta(reasoning="We ",
            reasoning_details=[{"type": "reasoning.text", "text": "We ", "index": 0}])),
        _Chunk(delta=_Delta(reasoning="think",
            reasoning_details=[{"type": "reasoning.text", "text": "think", "signature": "SIG", "index": 0}])),
        _Chunk(delta=_Delta(content="hi")),
    ])
    llm = OpenAICompatLlm(api_key="k")
    llm.async_client = _FakeOpenAIClient(resp)
    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)
    assert result.content == "hi"
    assert result.capture["reasoning_content"] == "We think"
    assert result.capture["reasoning_details"] == [
        {"type": "reasoning.text", "text": "We think", "signature": "SIG", "index": 0}
    ]


async def test_openai_stream_turn_no_reasoning_details_key_when_absent() -> None:
    """A plain OpenAI-compat model (no ``reasoning_details`` on the wire) must NOT
    grow a ``reasoning_details`` capture key — the passback is opt-in per presence."""
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm
    resp = _AsyncIter([_Chunk(delta=_Delta(reasoning="r")), _Chunk(delta=_Delta(content="hi"))])
    llm = OpenAICompatLlm(api_key="k")
    llm.async_client = _FakeOpenAIClient(resp)
    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)
    assert "reasoning_details" not in result.capture


############################################################################
# AnthropicLlm.stream_turn — capture the thinking block (text + signature)
############################################################################
class _FakeAnthropicStream:
    def __init__(self, events) -> None:
        self._events = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    def __aiter__(self):
        self._it = iter(self._events)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration

    async def get_final_message(self):
        return type("M", (), {"usage": None})()


class _FakeAnthropicLlm:
    protocol = "anthropic"

    def __init__(self, stream) -> None:
        messages = type("MS", (), {"stream": staticmethod(lambda **_kw: stream)})()
        self.async_client = type("AC", (), {"messages": messages})()

    def _build_parameters(self, **_kw) -> dict:
        return {}


async def test_anthropic_stream_turn_captures_thinking_block() -> None:
    events = [
        RawContentBlockStartEvent(
            type="content_block_start", index=0,
            content_block=ThinkingBlock(type="thinking", thinking="", signature="")),
        RawContentBlockDeltaEvent(
            type="content_block_delta", index=0,
            delta=ThinkingDelta(type="thinking_delta", thinking="reason")),
        RawContentBlockDeltaEvent(
            type="content_block_delta", index=0,
            delta=SignatureDelta(type="signature_delta", signature="SIG")),
        RawContentBlockStopEvent(type="content_block_stop", index=0),
        RawContentBlockStartEvent(
            type="content_block_start", index=1,
            content_block=ToolUseBlock(type="tool_use", id="tu1", name="get_weather", input={})),
        RawContentBlockDeltaEvent(
            type="content_block_delta", index=1,
            delta=InputJSONDelta(type="input_json_delta", partial_json='{"city":"BJ"}')),
        RawContentBlockStopEvent(type="content_block_stop", index=1),
    ]
    llm = AnthropicLlm(api_key="k")
    llm.async_client = _FakeAnthropicLlm(_FakeAnthropicStream(events)).async_client
    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)
    assert result.tool_calls == [
        {"name": "get_weather", "arguments": {"city": "BJ"}, "call_id": "tu1"}
    ]
    assert result.content == ""
    assert result.capture["thinking_blocks"] == [
        {"type": "thinking", "thinking": "reason", "signature": "SIG"}
    ]


############################################################################
# GoogleLlm.stream_turn — capture each function call's thought_signature
############################################################################
class _FakeGoogleLlm:
    def __init__(self, chunks) -> None:
        models = type("M", (), {
            "generate_content_stream": staticmethod(
                lambda **_kw: _awaitable(_AsyncIter(chunks))
            )
        })()
        self.async_client = type("AC", (), {"models": models})()

    def _build_parameters(self, *_a, **_kw) -> dict:
        return {}


async def _awaitable(value):
    """Wrap a value so ``await generate_content_stream(...)`` yields it (the SDK's
    async stream entrypoint is a coroutine returning the async iterator)."""
    return value


async def test_google_stream_turn_captures_signature() -> None:
    import base64

    from google.genai import types as gtypes

    from src.amphi_service.protocol.llms.google_llm import GoogleLlm

    chunk = gtypes.GenerateContentResponse.model_validate({
        "candidates": [{"content": {"role": "model", "parts": [
            {"text": "let me check"},
            {"function_call": {"id": "g1", "name": "get_weather", "args": {"city": "BJ"}},
             "thought_signature": b"SIG"},
        ]}}],
        "usage_metadata": {"prompt_token_count": 3, "candidates_token_count": 2},
    })
    llm = GoogleLlm(api_key="k")
    llm.async_client = _FakeGoogleLlm([chunk]).async_client
    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)
    assert result.tool_calls == [
        {"name": "get_weather", "arguments": {"city": "BJ"}, "call_id": "g1"}
    ]
    assert result.content == "let me check"
    assert result.capture["thought_signatures"] == [base64.b64encode(b"SIG").decode()]


############################################################################
# MainThink.thinking — worker-level polymorphic contract (stub LLM)
############################################################################
async def test_thinking_applies_capture_and_records_usage() -> None:
    from src.amphi_service.protocol.llms._streaming import StreamResult

    class _StubLlm:
        protocol = "openai"
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            publish("token", text="hi")
            return StreamResult(
                tool_calls=[{"name": "t", "arguments": {}}], content="hi",
                usage={"prompt_tokens": 3, "completion_tokens": 2},
                capture={"reasoning_content": "r"})

    mt = MainThink()
    mt._llm = _StubLlm()
    ota = AmphiOTAContext(user_input="x")
    ota.transition_think(BuildStageState(stage="explore"))
    ota.open_record()
    tool_calls, content = await mt.thinking(ota, AmphiContext())
    assert content == "hi"
    assert tool_calls == [{"name": "t", "arguments": {}}]
    assert ota._current_record().reasoning_content == "r"
    assert ota._current_record().build_stage == "explore"
    assert ota.input_tokens == 3 and ota.output_tokens == 2


async def test_thinking_checkpoints_visible_partial_output_on_cancellation() -> None:
    started = asyncio.Event()

    class _BlockingLlm:
        protocol = "openai"

        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            publish("token", text="discarded")
            publish("model_retry", attempt=2, max_attempts=3, error="retry")
            publish("reasoning", text="正在分析")
            publish("token", text="已经生成的部分回答")
            started.set()
            await asyncio.Event().wait()

    worker = MainThink()
    worker._llm = _BlockingLlm()
    ota = AmphiOTAContext(user_input="x")
    task = asyncio.create_task(worker.thinking(ota, AmphiContext()))
    await started.wait()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    record = ota._current_record()
    assert record.think_result == {
        "step_content": "已经生成的部分回答",
        "tool_calls": [],
    }
    assert record.reasoning_content == "正在分析"
    assert record.build_stage is None
