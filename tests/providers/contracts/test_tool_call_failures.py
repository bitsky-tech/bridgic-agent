"""Malformed and interrupted calls remain independent action outcomes."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from anthropic import AsyncAnthropic
from anthropic.types import RawContentBlockDeltaEvent, RawContentBlockStartEvent, RawContentBlockStopEvent
from bridgic.core.model.types import Message
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms._streaming import parse_tool_calls
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicConfiguration, AnthropicLlm
from src.amphi_service.protocol.llms.codex_llm import CodexConfiguration, CodexResponsesLlm
from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm


@pytest.mark.parametrize("raw", ['', '{"value":', '{"value":"bad\\q"}', '[]', 'null', '"text"'])
def test_parse_failure_keeps_raw_arguments_and_valid_sibling(raw: str) -> None:
    arguments = {"value": "x" * 100_000}
    good, bad = parse_tool_calls([
        {"name": "A", "call_id": "a", "arguments": json.dumps(arguments)},
        {"name": "B", "call_id": "b", "arguments": raw},
    ])
    assert good == {"name": "A", "call_id": "a", "arguments": arguments}
    assert bad["name"] == "B" and bad["call_id"] == "b"
    assert bad["arguments"] == {}
    assert bad["raw_arguments"] == raw
    assert "not executed" in bad["error"]


@pytest.mark.parametrize("error", [ValueError("integer conversion limit"), RecursionError("decoder recursion limit")])
def test_decoder_limits_fail_only_the_affected_call(monkeypatch, error: Exception) -> None:
    original_loads = json.loads

    def loads(raw):
        if raw == "limited input":
            raise error
        return original_loads(raw)

    monkeypatch.setattr("src.amphi_service.protocol.llms._streaming.json.loads", loads)
    good, bad = parse_tool_calls([
        {"name": "A", "arguments": "{}"},
        {"name": "B", "arguments": "limited input"},
    ])
    assert good == {"name": "A", "arguments": {}}
    assert str(error) in bad["error"]
    assert bad["raw_arguments"] == "limited input"


def test_parse_distinguishes_empty_object_unfinished_call_and_unidentified_fragment() -> None:
    calls = parse_tool_calls([
        {"name": "A", "arguments": "{}"},
        {"name": "B", "arguments": "{}", "incomplete": True},
        {"arguments": '{"value":'},
    ])
    assert calls[0] == {"name": "A", "arguments": {}}
    assert calls[1]["raw_arguments"] == "{}"
    assert "before this call completed" in calls[1]["error"]
    assert len(calls) == 2


def _call_events(provider: str, index: int, raw: str, complete: bool) -> list:
    name, call_id = ("A", "a") if index == 0 else ("B", "b")
    if provider == "openai":
        return [SimpleNamespace(usage=None, choices=[SimpleNamespace(
            finish_reason=None,
            delta=SimpleNamespace(content=None, tool_calls=[SimpleNamespace(
                index=index, id=call_id, function=SimpleNamespace(name=name, arguments=raw),
            )]),
        )])]
    if provider == "codex":
        item = {"type": "function_call", "id": f"item-{index}", "call_id": call_id, "name": name, "arguments": ""}
        events = [
            {"type": "response.output_item.added", "item": item},
            {"type": "response.function_call_arguments.delta", "item_id": item["id"], "delta": raw},
        ]
        if complete:
            events.append({"type": "response.output_item.done", "item": {**item, "arguments": raw}})
        return events
    events = [
        RawContentBlockStartEvent(type="content_block_start", index=index, content_block={"type": "tool_use", "id": call_id, "name": name, "input": {}}),
    ]
    if raw:
        events.append(RawContentBlockDeltaEvent(type="content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": raw}))
    if complete:
        events.append(RawContentBlockStopEvent(type="content_block_stop", index=index))
    return events


@pytest.fixture(params=["openai", "codex", "anthropic"])
async def adapter(request, monkeypatch):
    """Exercise each real adapter loop with a controlled native stream."""
    provider = request.param
    if provider == "openai":
        llm = OpenAICompatLlm(api_key="test-key", configuration=OpenAIConfiguration(model="test-model"))
    elif provider == "codex":
        llm = CodexResponsesLlm(access_token="test-token", account_id="test-account", configuration=CodexConfiguration(model="test-model"))
    else:
        llm = AnthropicLlm(api_key="test-key", configuration=AnthropicConfiguration(model="test-model"))
    client = llm.async_client
    stats = SimpleNamespace(attempts=0, published=[])

    async def no_sleep(_delay):
        pass

    monkeypatch.setattr("src.amphi_service.protocol.llms._streaming.asyncio.sleep", no_sleep)

    async def run(events, failure=None):
        class Response:
            async def __aenter__(self):
                stats.attempts += 1
                return self

            async def __aexit__(self, *_args):
                pass

            def __aiter__(self):
                return self.iterate()

            async def iterate(self):
                for event in events:
                    yield event
                if failure is not None:
                    raise failure

            async def aiter_lines(self):
                async for event in self.iterate():
                    yield f"data: {json.dumps(event)}"

            async def close(self):
                pass

        if provider == "openai":
            async def create_stream(_params, _publish):
                stats.attempts += 1
                return Response()
            monkeypatch.setattr(llm, "_create_stream", create_stream)
        elif provider == "codex":
            async def consume_stream(_body, consume, _publish):
                stats.attempts += 1
                return await consume(Response())
            monkeypatch.setattr(llm, "_astream_responses", consume_stream)
        else:
            async def create(**params):
                assert params["stream"] is True
                return Response()
            monkeypatch.setattr(llm, "async_client", SimpleNamespace(messages=SimpleNamespace(create=create)))

        return await llm.stream_turn(
            [Message.from_text("Exercise a tool call")], None,
            publish=lambda event, **payload: stats.published.append((event, payload)),
        )

    yield SimpleNamespace(provider=provider, run=run, stats=stats)
    llm.client.close()
    if provider == "codex":
        await client.aclose()
    else:
        await client.close()


@pytest.mark.parametrize("ending", ["complete", "eof", "transport"])
async def test_valid_and_malformed_calls_are_not_retried_as_a_batch(adapter, ending: str) -> None:
    raw = '{"value":"unfinished'
    events = _call_events(adapter.provider, 0, '{"value":"valid"}', True)
    events += _call_events(adapter.provider, 1, raw, ending == "complete")
    error = httpx.ReadError("connection reset") if ending == "transport" else None
    result = await adapter.run(events, error)
    good, bad = result.tool_calls
    assert good == {"name": "A", "call_id": "a", "arguments": {"value": "valid"}}
    assert bad["raw_arguments"] == raw and bad["arguments"] == {}
    assert "not executed" in bad["error"]
    assert adapter.stats.attempts == 1
    assert all(event != "model_retry" for event, _ in adapter.stats.published)


async def test_no_identifiable_call_keeps_the_thinking_transport_error(adapter) -> None:
    with pytest.raises(httpx.ReadError):
        await adapter.run([], httpx.ReadError("connection reset"))
    assert adapter.stats.attempts == (6 if adapter.provider == "codex" else 3)
    assert any(event == "model_retry" for event, _ in adapter.stats.published)


async def test_user_stop_is_never_recovered_as_a_failed_action(adapter) -> None:
    events = _call_events(adapter.provider, 0, '{"value":', False)
    with pytest.raises(asyncio.CancelledError):
        await adapter.run(events, asyncio.CancelledError())
    assert adapter.stats.attempts == 1


async def test_normal_text_without_tool_calls_remains_a_normal_reply(adapter) -> None:
    if adapter.provider == "openai":
        events = [SimpleNamespace(usage=None, choices=[SimpleNamespace(
            finish_reason="stop", delta=SimpleNamespace(content="Finished normally", tool_calls=None),
        )])]
    elif adapter.provider == "codex":
        events = [{"type": "response.output_text.delta", "delta": "Finished normally"}, {"type": "response.completed"}]
    else:
        events = [RawContentBlockDeltaEvent(type="content_block_delta", index=0, delta={"type": "text_delta", "text": "Finished normally"})]
    result = await adapter.run(events)
    assert result.content == "Finished normally"
    assert result.tool_calls == []
    assert adapter.stats.attempts == 1


@pytest.mark.parametrize("terminal", ["response.incomplete", "response.failed", "error"])
@pytest.mark.parametrize("adapter", ["codex"], indirect=True)
async def test_codex_terminal_failure_keeps_finished_call_and_fails_unfinished_call(adapter, terminal: str) -> None:
    events = _call_events("codex", 0, "{}", True) + _call_events("codex", 1, "{}", False)
    events.append({"type": terminal, "response": {"incomplete_details": {"reason": "max_output_tokens"}}})
    result = await adapter.run(events)
    assert "error" not in result.tool_calls[0]
    assert terminal in result.tool_calls[1]["error"]
    assert result.tool_calls[1]["raw_arguments"] == "{}"
    assert adapter.stats.attempts == 1


@pytest.mark.parametrize("adapter", ["anthropic"], indirect=True)
async def test_anthropic_completed_zero_argument_call_is_not_a_parse_error(adapter) -> None:
    result = await adapter.run(_call_events("anthropic", 0, "", True))
    assert result.tool_calls == [{"name": "A", "call_id": "a", "arguments": {}}]


@pytest.mark.parametrize("adapter", ["openai"], indirect=True)
@pytest.mark.parametrize("reason", ["length", "content_filter"])
async def test_openai_finish_reason_is_retained_in_failed_call(adapter, reason: str) -> None:
    events = _call_events("openai", 0, "{}", True) + _call_events("openai", 1, '{"value":', False)
    events[-1].choices[0].finish_reason = reason
    result = await adapter.run(events)
    assert reason in result.tool_calls[1]["error"]
    assert ("error" in result.tool_calls[0]) == (reason == "content_filter")


@pytest.mark.parametrize("adapter", ["codex"], indirect=True)
async def test_codex_explicit_failure_without_a_call_is_not_normal_completion(adapter) -> None:
    with pytest.raises(RuntimeError, match="response.failed"):
        await adapter.run([{"type": "response.failed", "response": {"error": {"code": "server_error"}}}])


@pytest.mark.parametrize("error_type", [AssertionError, ValueError])
async def test_internal_programming_error_is_not_converted_to_a_tool_failure(adapter, error_type) -> None:
    events = _call_events(adapter.provider, 0, '{"value":', False)
    with pytest.raises(error_type, match="internal bug"):
        await adapter.run(events, error_type("internal bug"))
    assert adapter.stats.attempts == 1


@pytest.mark.parametrize("adapter", ["anthropic"], indirect=True)
async def test_anthropic_sse_json_failure_retains_the_started_call(adapter) -> None:
    events = _call_events("anthropic", 0, "{}", True) + _call_events("anthropic", 1, '{"value":', False)
    result = await adapter.run(events, json.JSONDecodeError("invalid SSE JSON", "{", 1))
    assert "error" not in result.tool_calls[0]
    assert "JSONDecodeError" in result.tool_calls[1]["error"]
    assert adapter.stats.attempts == 1


@pytest.mark.parametrize("raw", ['{"value":"bad\\q"}', '{"value":"unfinished', '[]'])
@pytest.mark.parametrize("bad_first", [True, False])
async def test_anthropic_raw_sdk_stream_keeps_malformed_arguments_and_valid_siblings(raw: str, bad_first: bool) -> None:
    """The real SDK must not parse tool JSON before the adapter receives it."""
    requests = []
    published = []
    good_arguments = {"value": "完整参数" * 1000}
    calls = [("bad", raw), ("good", json.dumps(good_arguments, ensure_ascii=False))]
    if not bad_first:
        calls.reverse()
    events = [{"type": "message_start", "message": {
        "id": "msg-test", "type": "message", "role": "assistant", "model": "test-model",
        "content": [], "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 5},
    }}]
    events.extend([
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "plan"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_stop", "index": 0},
    ])
    for index, (name, arguments) in enumerate(calls, start=1):
        events.append({"type": "content_block_start", "index": index, "content_block": {
            "type": "tool_use", "id": name, "name": name, "input": {},
        }})
        middle = len(arguments) // 2
        for fragment in (arguments[:middle], arguments[middle:]):
            events.append({"type": "content_block_delta", "index": index, "delta": {
                "type": "input_json_delta", "partial_json": fragment,
            }})
        events.append({"type": "content_block_stop", "index": index})
    events.extend([
        {"type": "message_delta", "delta": {"stop_reason": None, "stop_sequence": None}, "usage": {"output_tokens": 12}},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {
            "output_tokens": 30, "input_tokens": 11, "cache_creation_input_tokens": 0,
        }},
        {"type": "message_stop"},
    ])
    payload = "".join(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n' for event in events)

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["stream"] is True
        return httpx.Response(200, text=payload, headers={"content-type": "text/event-stream"})

    llm = AnthropicLlm(api_key="test-key", configuration=AnthropicConfiguration(model="test-model"))
    await llm.async_client.close()
    llm.async_client = AsyncAnthropic(
        api_key="test-key", max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
    )
    try:
        result = await llm.stream_turn(
            [Message.from_text("Exercise both tools")], None,
            publish=lambda event, **data: published.append((event, data)),
        )
    finally:
        llm.client.close()
        await llm.async_client.close()

    assert len(requests) == 1
    assert [call["call_id"] for call in result.tool_calls] == [name for name, _ in calls]
    by_id = {call["call_id"]: call for call in result.tool_calls}
    assert by_id["good"] == {"name": "good", "call_id": "good", "arguments": good_arguments}
    assert by_id["bad"]["arguments"] == {}
    assert by_id["bad"]["raw_arguments"] == raw
    assert "not executed" in by_id["bad"]["error"]
    assert result.usage == {"input_tokens": 11, "output_tokens": 30, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 0}
    assert result.capture == {"thinking_blocks": [{"type": "thinking", "thinking": "plan", "signature": "sig"}]}
    assert published == [("reasoning", {"text": "plan"})]
