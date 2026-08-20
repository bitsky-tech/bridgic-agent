from bridgic.core.model.types import Message, Role, TextBlock, ToolCallBlock, ToolResultBlock

from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_service.protocol.llms.anthropic_llm import (
    _CACHE_UNSUPPORTED,
    AnthropicConfiguration,
    AnthropicLlm,
)


TOOLS = [
    {"name": "alpha", "description": "a", "input_schema": {"type": "object", "properties": {}}},
    {"name": "beta", "description": "b", "input_schema": {"type": "object", "properties": {}}},
]


def _llm(model: str = "claude-sonnet-5") -> AnthropicLlm:
    return AnthropicLlm(api_key="test-key", configuration=AnthropicConfiguration(model=model))


def _history() -> list[Message]:
    return [
        Message.from_text("persona", role=Role.SYSTEM),
        Message.from_text("do the task", role=Role.USER),
        Message(
            role=Role.AI,
            blocks=[
                TextBlock(text="calling"),
                ToolCallBlock(id="call-1", name="alpha", arguments={}),
            ],
            extras={
                "thinking_blocks": [
                    {"type": "thinking", "thinking": "consider", "signature": "signed"}
                ]
            },
        ),
        Message(role=Role.TOOL, blocks=[ToolResultBlock(id="call-1", content="done")]),
        Message.from_text(
            "<runtime_state>changed</runtime_state>",
            role=Role.USER,
            extras={VOLATILE_TAIL_EXTRA: True},
        ),
    ]


def _capture_stream(seen: list[dict]):
    async def run(params, _publish):
        seen.append(params)
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    return run


def _breakpoints(params: dict) -> list[str]:
    marks: list[str] = []
    system = params.get("system")
    if isinstance(system, list):
        marks.extend(
            f"system[{index}]"
            for index, block in enumerate(system)
            if block.get("cache_control")
        )
    marks.extend(
        f"tools[{index}]"
        for index, tool in enumerate(params.get("tools") or [])
        if tool.get("cache_control")
    )
    for message_index, message in enumerate(params.get("messages") or []):
        for block_index, block in enumerate(message["content"]):
            if isinstance(block, dict) and block.get("cache_control"):
                marks.append(
                    f"messages[{message_index}].content[{block_index}]:{block.get('type')}"
                )
    return marks


async def test_stream_turn_caches_only_the_stable_request_prefix() -> None:
    history = _history()
    thinking = history[2].extras["thinking_blocks"][0]
    seen: list[dict] = []
    llm = _llm()
    llm._run_stream = _capture_stream(seen)  # type: ignore[method-assign]

    await llm.stream_turn(history, TOOLS, publish=lambda *_args, **_options: None)

    marks = _breakpoints(seen[0])
    assert marks[0] == "system[0]"
    assert "tools[1]" in marks
    assert "tools[0]" not in marks
    assert any(mark.endswith(":tool_result") for mark in marks)
    assert not any(mark.endswith(":text") and "messages[2]" in mark for mark in marks)
    assert not any(mark.endswith(":thinking") for mark in marks)
    assert len(marks) == 3
    assert "cache_control" not in thinking


async def test_stream_turn_remembers_relays_that_reject_caching() -> None:
    seen: list[dict] = []

    class CacheRejected(Exception):
        status_code = 400

        def __init__(self) -> None:
            super().__init__("cache_control is not supported")
            self.body = {"error": {"message": "cache_control: Extra inputs are not permitted"}}

    async def run(params, _publish):
        seen.append(params)
        if _breakpoints(params):
            raise CacheRejected()
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    llm = _llm("relay-alias")
    llm._run_stream = run  # type: ignore[method-assign]

    result = await llm.stream_turn(_history(), TOOLS, publish=lambda *_args, **_options: None)
    await llm.stream_turn(_history(), TOOLS, publish=lambda *_args, **_options: None)

    assert result.content == "done"
    assert len(seen) == 3
    assert _breakpoints(seen[0])
    assert not _breakpoints(seen[1])
    assert not _breakpoints(seen[2])
    assert llm._reject_key() in _CACHE_UNSUPPORTED


async def test_long_history_keeps_a_cache_anchor_inside_anthropic_lookback() -> None:
    history: list[Message] = [Message.from_text("persona", role=Role.SYSTEM)]
    for index in range(30):
        role = Role.USER if index % 2 == 0 else Role.AI
        history.append(Message.from_text(f"message-{index}", role=role))
    history.append(
        Message.from_text(
            "<runtime_state>changed</runtime_state>",
            role=Role.USER,
            extras={VOLATILE_TAIL_EXTRA: True},
        )
    )
    seen: list[dict] = []
    llm = _llm()
    llm._run_stream = _capture_stream(seen)  # type: ignore[method-assign]

    await llm.stream_turn(history, TOOLS, publish=lambda *_args, **_options: None)

    marks = _breakpoints(seen[0])
    message_marks = [mark for mark in marks if mark.startswith("messages[")]
    assert len(message_marks) == 2
    assert len(marks) == 4
