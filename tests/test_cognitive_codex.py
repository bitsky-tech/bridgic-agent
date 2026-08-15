"""Codex Responses SSE reduction — CodexResponsesLlm.stream_turn internals.

The HTTP/stream plumbing in ``stream_turn`` is thin; the grammar lives in the
pure ``CodexResponsesLlm._reduce_event`` + the shared parsers, tested directly
here by feeding event sequences (no live stream, no worker construction).
"""

from __future__ import annotations

from src.amphi_agent import AmphiOTAContext
from src.amphi_agent._cognitive import MainThink  # retained for _usage_pair (worker-level helper)
from src.amphi_service.protocol.llms._streaming import convert_tools, parse_tool_calls
from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm, parse_sse_event


def _new_state() -> dict:
    return {"content": [], "tool_items": {}, "order": [], "usage": None, "reasoning_items": []}


def _parse(items: dict, order: list) -> list:
    """Codex tool-items in emission order → wire dicts (shared parse_tool_calls)."""
    return parse_tool_calls(items[i] for i in order if i in items)


def _turn_messages(ota: AmphiOTAContext) -> list:
    return MainThink().turn_messages_block(ota, None)


class _Pub:
    def __init__(self) -> None:
        self.calls: list = []

    def __call__(self, channel: str, **kw) -> None:
        self.calls.append((channel, kw))


def test_reduce_codex_event_lifecycle() -> None:
    """Full SSE reduction: text delta + reasoning + function_call (added/delta/done)
    + completed-usage, asserting content stream, publish channels, tool_calls, usage."""
    state, pub = _new_state(), _Pub()

    # text delta → accumulated content + token publish
    CodexResponsesLlm._reduce_event(
        {"type": "response.output_text.delta", "delta": "Hi"}, state, pub
    )
    # reasoning delta → reasoning publish, NOT added to content
    CodexResponsesLlm._reduce_event(
        {"type": "response.reasoning_summary_text.delta", "delta": "think"}, state, pub
    )
    # function_call lifecycle: added → args-delta (x2) → done
    CodexResponsesLlm._reduce_event(
        {
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "bash", "arguments": ""},
        },
        state,
        pub,
    )
    CodexResponsesLlm._reduce_event(
        {"type": "response.function_call_arguments.delta", "item_id": "fc1", "delta": '{"command"'},
        state,
        pub,
    )
    CodexResponsesLlm._reduce_event(
        {"type": "response.function_call_arguments.delta", "item_id": "fc1", "delta": ':"ls"}'},
        state,
        pub,
    )
    CodexResponsesLlm._reduce_event(
        {
            "type": "response.output_item.done",
            "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "bash", "arguments": '{"command":"ls"}'},
        },
        state,
        pub,
    )
    # completed → usage captured (read directly via _usage_pair, no wrapper object)
    CodexResponsesLlm._reduce_event(
        {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}},
        state,
        pub,
    )

    assert state["content"] == ["Hi"]
    assert pub.calls == [("token", {"text": "Hi"}), ("reasoning", {"text": "think"})]
    assert _parse(state["tool_items"], state["order"]) == [
        {"name": "bash", "arguments": {"command": "ls"}, "call_id": "c1"}
    ]
    assert MainThink._usage_pair(state["usage"]) == (10, 5)

    # _parse_tool_calls edge cases: malformed JSON args degrade to {};
    # unnamed items are dropped entirely.
    assert _parse({"a": {"name": "x", "arguments": "{bad"}}, ["a"]) == [
        {"name": "x", "arguments": {}}
    ]
    assert _parse({"a": {"name": "", "arguments": "{}"}}, ["a"]) == []


def test_parse_codex_sse() -> None:
    """A ``data:`` line parses to its dict; non-data / ``[DONE]`` / empty → None."""
    assert parse_sse_event('data: {"type":"x"}') == {"type": "x"}
    assert parse_sse_event("event: x") is None
    assert parse_sse_event("") is None
    assert parse_sse_event("data: [DONE]") is None


def test_convert_tools_flat_and_envelope() -> None:
    class T:
        name = "bash"
        description = "run"
        parameters = {"type": "object", "properties": {}}

    assert convert_tools([T()], "responses") == [
        {
            "type": "function",
            "name": "bash",
            "description": "run",
            "parameters": {"type": "object", "properties": {}},
            "strict": False,
        }
    ]

    tools = [{"type": "function", "function": {"name": "x", "description": "d", "parameters": {"type": "object"}}}]
    out = convert_tools(tools, "responses")
    assert out[0]["name"] == "x"
    assert out[0]["type"] == "function"
    assert "function" not in out[0]


def test_usage_pair_reads_codex_dict_and_missing() -> None:
    assert MainThink._usage_pair({"input_tokens": 10, "output_tokens": 5}) == (10, 5)
    assert MainThink._usage_pair(None) == (0, 0)


############################################################################
# Reasoning item capture — _reduce_event appends reasoning items to state
############################################################################

def test_reduce_event_captures_reasoning_item_done() -> None:
    """output_item.done with type=reasoning appends the FULL item to state["reasoning_items"]."""
    state = _new_state()
    pub = _Pub()
    CodexResponsesLlm._reduce_event(
        {
            "type": "response.output_item.done",
            "item": {
                "type": "reasoning",
                "id": "r1",
                "encrypted_content": "ENC==",
                "summary": [],
            },
        },
        state,
        pub,
    )
    assert state["reasoning_items"] == [
        {"type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []}
    ]
    # No publish emitted for reasoning item capture
    assert pub.calls == []


def test_reduce_event_function_call_done_does_not_pollute_reasoning_items() -> None:
    """output_item.done with type=function_call must NOT go into reasoning_items."""
    state = _new_state()
    # First add the item via output_item.added so buf exists
    CodexResponsesLlm._reduce_event(
        {
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "bash", "arguments": ""},
        },
        state,
        _Pub(),
    )
    CodexResponsesLlm._reduce_event(
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "id": "fc1",
                "call_id": "c1",
                "name": "bash",
                "arguments": '{"cmd":"ls"}',
            },
        },
        state,
        _Pub(),
    )
    assert state["reasoning_items"] == []


############################################################################
# Reasoning item carry — turn_messages attaches reasoning_items on AI message
############################################################################

def test_turn_messages_attaches_reasoning_items() -> None:
    """A round record with reasoning_items → turn_messages puts them on the AI message extras."""
    reasoning_items = [{"type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []}]
    record = {
        "think_result": {"step_content": "let me check", "tool_calls": ["x"]},
        "action_result": {"results": [{
            "tool_id": "c1", "tool_name": "get_weather",
            "tool_arguments": {"city": "BJ"}, "tool_result": "ok", "success": True,
        }]},
        "reasoning_items": reasoning_items,
    }
    ota = AmphiOTAContext.model_validate({"user_input": "go", "ota_record": [record]})
    msgs = _turn_messages(ota)
    assert msgs[0].role.value == "assistant"
    assert msgs[0].extras.get("reasoning_items") == reasoning_items


def test_turn_messages_no_reasoning_items_without_capture() -> None:
    """A round without reasoning_items → no reasoning_items key in AI message extras."""
    record = {
        "think_result": {"step_content": "let me check", "tool_calls": ["x"]},
        "action_result": {"results": [{
            "tool_id": "c1", "tool_name": "get_weather",
            "tool_arguments": {"city": "BJ"}, "tool_result": "ok", "success": True,
        }]},
    }
    ota = AmphiOTAContext.model_validate({"user_input": "go", "ota_record": [record]})
    msgs = _turn_messages(ota)
    assert "reasoning_items" not in (msgs[0].extras or {})


def test_turn_messages_think_only_round_carries_reasoning_items() -> None:
    """A think-only round (think text, NO tool call) that captured reasoning_items
    must carry them on its AI text message's extras.

    The think text becomes an assistant `message` item; if it ever gets replayed
    with no preceding reasoning, the Responses API 400s with "message ... without
    its required 'reasoning' item". Carrying reasoning_items lets _convert_messages
    emit the reasoning item before that message."""
    reasoning_items = [{"type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []}]
    record = {
        "think_result": {"step_content": "just thinking, no tools", "tool_calls": []},
        "reasoning_items": reasoning_items,
    }
    ota = AmphiOTAContext.model_validate({"user_input": "go", "ota_record": [record]})
    msgs = _turn_messages(ota)
    assert msgs[0].role.value == "assistant"
    assert msgs[0].extras.get("reasoning_items") == reasoning_items


def test_turn_messages_think_only_round_no_reasoning_items_unchanged() -> None:
    """A think-only round with no captured reasoning → bare AI text, no extras."""
    record = {"think_result": {"step_content": "just thinking", "tool_calls": []}}
    ota = AmphiOTAContext.model_validate({"user_input": "go", "ota_record": [record]})
    msgs = _turn_messages(ota)
    assert msgs[0].role.value == "assistant"
    assert "reasoning_items" not in (msgs[0].extras or {})


def test_convert_messages_think_only_reasoning_before_message() -> None:
    """A think-only AI text message carrying reasoning_items → _convert_messages
    emits the reasoning item BEFORE the assistant message item (400-prevention)."""
    from bridgic.core.model.types import Message, Role

    from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm

    llm = CodexResponsesLlm(access_token="t", account_id="a")
    reasoning_items = [{"type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []}]
    messages = [
        Message.from_text("hi", role=Role.USER),
        Message.from_text("just thinking", role=Role.AI, extras={"reasoning_items": reasoning_items}),
    ]
    _, items = llm._convert_messages(messages)
    reasoning_idx = next(
        (i for i, it in enumerate(items) if it.get("type") == "reasoning"), None
    )
    msg_idx = next(
        (i for i, it in enumerate(items)
         if it.get("type") == "message" and it.get("role") == "assistant"),
        None,
    )
    assert reasoning_idx is not None and msg_idx is not None
    assert reasoning_idx < msg_idx, (
        f"reasoning (idx={reasoning_idx}) must precede its message (idx={msg_idx})"
    )


############################################################################
# Round-trip correctness — reasoning items appear BEFORE function_call in input
############################################################################

def test_convert_messages_reasoning_items_preserve_output_order() -> None:
    """AI message with reasoning_items + TextBlock + ToolCallBlock → the Responses
    input must preserve the original output order: reasoning → message → function_call.

    Reasoning items go FIRST (verbatim), then the message's blocks in their original
    order. Reordering (e.g. the message item before its reasoning) triggers a 400
    "message ... without its required 'reasoning' item" (confirmed against the
    OpenAI Responses API contract)."""
    from bridgic.core.model.types import Message, Role, TextBlock, ToolCallBlock

    from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm

    llm = CodexResponsesLlm(access_token="t", account_id="a")
    reasoning_items = [
        {"type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []}
    ]
    messages = [
        Message.from_text("hi", role=Role.USER),
        Message(
            role=Role.AI,
            blocks=[
                TextBlock(text="thinking..."),
                ToolCallBlock(id="c1", name="get_weather", arguments={"city": "BJ"}),
            ],
            extras={"reasoning_items": reasoning_items},
        ),
    ]
    _, items = llm._convert_messages(messages)
    reasoning_idx = next(
        (i for i, it in enumerate(items) if it.get("type") == "reasoning"), None
    )
    msg_idx = next(
        (i for i, it in enumerate(items)
         if it.get("type") == "message" and it.get("role") == "assistant"),
        None,
    )
    fc_idx = next(
        (i for i, it in enumerate(items) if it.get("type") == "function_call"), None
    )
    assert reasoning_idx is not None, "reasoning item not found in input"
    assert msg_idx is not None, "assistant message item not found in input"
    assert fc_idx is not None, "function_call item not found in input"
    # reasoning must come FIRST, before its message (the 400-prevention property)
    assert reasoning_idx < msg_idx, (
        f"reasoning (idx={reasoning_idx}) must precede its message (idx={msg_idx})"
    )
    # original block order preserved: message before function_call
    assert msg_idx < fc_idx, (
        f"message (idx={msg_idx}) must precede function_call (idx={fc_idx})"
    )
    # The reasoning item must be verbatim
    assert items[reasoning_idx] == {
        "type": "reasoning", "id": "r1", "encrypted_content": "ENC==", "summary": []
    }


def test_convert_messages_no_reasoning_items_unchanged() -> None:
    """A message WITHOUT reasoning_items converts identically to before — no reasoning
    item injected, no crash."""
    from bridgic.core.model.types import Message, Role, TextBlock, ToolCallBlock

    from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm

    llm = CodexResponsesLlm(access_token="t", account_id="a")
    messages = [
        Message.from_text("hi", role=Role.USER),
        Message(
            role=Role.AI,
            blocks=[
                TextBlock(text="thinking..."),
                ToolCallBlock(id="c1", name="get_weather", arguments={"city": "BJ"}),
            ],
            extras={},
        ),
    ]
    _, items = llm._convert_messages(messages)
    types = [it["type"] for it in items]
    assert "reasoning" not in types
    assert "function_call" in types
