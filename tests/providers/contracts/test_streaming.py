import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from anthropic.types import RawContentBlockDeltaEvent, RawContentBlockStartEvent, RawContentBlockStopEvent
from bridgic.core.model.types import Message, Role
from bridgic.llms.openai import OpenAIConfiguration
from google.genai import types

from src.amphi_service.protocol.llms._codex_credentials import CodexCreds
from src.amphi_service.protocol.llms._streaming import ModelNotFoundError, StreamResult, stream_with_transport_retry
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicConfiguration, AnthropicLlm
from src.amphi_service.protocol.llms.codex_llm import CodexConfiguration, CodexResponsesLlm
from src.amphi_service.protocol.llms.google_llm import GoogleConfiguration, GoogleLlm
from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm


def _events() -> tuple[list[tuple[str, dict[str, Any]]], Any]:
    events: list[tuple[str, dict[str, Any]]] = []

    def publish(channel: str, **payload: Any) -> None:
        events.append((channel, payload))

    return events, publish


async def test_transport_retry_discards_partial_attempt(monkeypatch) -> None:
    """A retry announces exactly what the caller must discard before clean output."""
    import src.amphi_service.protocol.llms._streaming as streaming_module

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    attempts = 0
    events, publish = _events()

    async def run(attempt_publish) -> StreamResult:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            attempt_publish("token", text="partial")
            attempt_publish("reasoning", text="plan")
            raise httpx.ConnectError("connection reset")
        attempt_publish("token", text="complete")
        return StreamResult(tool_calls=[], content="complete")

    result = await stream_with_transport_retry(run, publish)

    assert result.content == "complete"
    assert attempts == 2
    assert events == [
        ("token", {"text": "partial"}),
        ("reasoning", {"text": "plan"}),
        (
            "model_retry",
            {
                "active": True,
                "attempt": 1,
                "max_retries": 2,
                "delay_seconds": 1.0,
                "discard_text_chars": 7,
                "discard_reasoning_chars": 4,
            },
        ),
        ("model_retry", {"active": False, "attempt": 1, "max_retries": 2, "delay_seconds": 0.0}),
        ("token", {"text": "complete"}),
    ]


async def test_openai_stream_open_self_heals_and_caches_rejected_parameter(monkeypatch: pytest.MonkeyPatch) -> None:
    """A compatible endpoint learns one rejected parameter and omits it thereafter."""
    class UnsupportedParameterError(RuntimeError):
        code = "unsupported_parameter"
        param = "temperature"

    llm = OpenAICompatLlm(
        api_key="test-key",
        configuration=OpenAIConfiguration(model="gpt-test"),
    )
    attempts: list[dict[str, Any]] = []
    response = object()

    async def open_stream(params: dict[str, Any]) -> object:
        attempts.append(dict(params))
        if len(attempts) == 1:
            raise UnsupportedParameterError("temperature is unsupported")
        return response

    monkeypatch.setattr(llm, "_open_stream_request", open_stream)
    parameters = {"model": "gpt-test", "temperature": 0.2, "stream": True}
    try:
        first = await llm._create_stream(dict(parameters), lambda *_args, **_kwargs: None)
        second = await llm._create_stream(dict(parameters), lambda *_args, **_kwargs: None)
    finally:
        llm.client.close()
        await llm.async_client.close()

    assert first is response and second is response
    assert attempts == [
        parameters,
        {"model": "gpt-test", "stream": True},
        {"model": "gpt-test", "stream": True},
    ]


async def test_openai_stream_open_translates_missing_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """An opaque provider model error becomes the actionable shared domain error."""
    class MissingModelError(RuntimeError):
        code = "model_not_found"

    llm = OpenAICompatLlm(
        api_key="test-key",
        configuration=OpenAIConfiguration(model="missing-model"),
    )

    async def open_stream(_params: dict[str, Any]) -> object:
        raise MissingModelError("model missing-model was not found")

    monkeypatch.setattr(llm, "_open_stream_request", open_stream)
    try:
        with pytest.raises(ModelNotFoundError, match="missing-model"):
            await llm._create_stream(
                {"model": "missing-model", "stream": True},
                lambda *_args, **_kwargs: None,
            )
    finally:
        llm.client.close()
        await llm.async_client.close()


async def test_openai_stream_turn_reduces_native_deltas() -> None:
    """The OpenAI adapter joins text, reasoning, tools, usage, and replay capture."""
    llm = OpenAICompatLlm(
        api_key="test-key",
        configuration=OpenAIConfiguration(model="gpt-test"),
    )
    events, publish = _events()

    class Response:
        def __init__(self) -> None:
            self.chunks = [
                SimpleNamespace(
                    usage=None,
                    choices=[SimpleNamespace(delta=SimpleNamespace(
                        reasoning_content="plan ",
                        reasoning_details=[{"index": 0, "type": "reasoning.text", "text": "plan", "signature": "sig"}],
                        content="hello ",
                        tool_calls=[SimpleNamespace(
                            index=0,
                            id="call-1",
                            function=SimpleNamespace(name="inspect", arguments='{"path":'),
                        )],
                    ))],
                ),
                SimpleNamespace(
                    usage=None,
                    choices=[SimpleNamespace(delta=SimpleNamespace(
                        reasoning_content=None,
                        reasoning_details=None,
                        content="world",
                        tool_calls=[SimpleNamespace(
                            index=0,
                            id=None,
                            function=SimpleNamespace(name=None, arguments='"."}'),
                        )],
                    ))],
                ),
                SimpleNamespace(usage={"prompt_tokens": 4, "completion_tokens": 2}, choices=[]),
            ]

        def __aiter__(self):
            return self._iterate()

        async def _iterate(self):
            for chunk in self.chunks:
                yield chunk

        async def close(self) -> None:
            return None

    async def create_stream(_params, _publish):
        return Response()

    llm._create_stream = create_stream  # type: ignore[method-assign]
    try:
        result = await llm.stream_turn(
            [Message.from_text("inspect", role=Role.USER)],
            None,
            publish=publish,
        )
    finally:
        llm.client.close()
        await llm.async_client.close()

    assert result.content == "hello world"
    assert result.tool_calls == [{"name": "inspect", "arguments": {"path": "."}, "call_id": "call-1"}]
    assert result.usage == {"prompt_tokens": 4, "completion_tokens": 2}
    assert result.capture == {
        "reasoning_content": "plan ",
        "reasoning_details": [{"index": 0, "type": "reasoning.text", "text": "plan", "signature": "sig"}],
    }
    assert events == [
        ("reasoning", {"text": "plan "}),
        ("token", {"text": "hello "}),
        ("token", {"text": "world"}),
    ]


async def test_anthropic_stream_turn_reduces_native_events() -> None:
    """The Anthropic adapter preserves thinking, tool identity, text, and usage."""
    llm = AnthropicLlm(
        api_key="test-key",
        configuration=AnthropicConfiguration(model="claude-test"),
    )
    original_async_client = llm.async_client
    events, publish = _events()
    raw_events = [
        RawContentBlockStartEvent(type="content_block_start", index=0, content_block={"type": "thinking", "thinking": "", "signature": ""}),
        RawContentBlockDeltaEvent(type="content_block_delta", index=0, delta={"type": "thinking_delta", "thinking": "plan"}),
        RawContentBlockDeltaEvent(type="content_block_delta", index=0, delta={"type": "signature_delta", "signature": "sig"}),
        RawContentBlockStopEvent(type="content_block_stop", index=0),
        RawContentBlockStartEvent(type="content_block_start", index=1, content_block={"type": "text", "text": "", "citations": None}),
        RawContentBlockDeltaEvent(type="content_block_delta", index=1, delta={"type": "text_delta", "text": "done"}),
        RawContentBlockStopEvent(type="content_block_stop", index=1),
        RawContentBlockStartEvent(type="content_block_start", index=2, content_block={"type": "tool_use", "id": "call-1", "name": "inspect", "input": {}}),
        RawContentBlockDeltaEvent(type="content_block_delta", index=2, delta={"type": "input_json_delta", "partial_json": '{"path":"."}'}),
        RawContentBlockStopEvent(type="content_block_stop", index=2),
    ]

    class Response:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        def __aiter__(self):
            return self._iterate()

        async def _iterate(self):
            for event in raw_events:
                yield event

        async def get_final_message(self):
            return SimpleNamespace(usage={"input_tokens": 3, "output_tokens": 2})

    llm.async_client = SimpleNamespace(messages=SimpleNamespace(stream=lambda **_params: Response()))
    try:
        result = await llm.stream_turn(
            [Message.from_text("inspect", role=Role.USER)],
            None,
            publish=publish,
        )
    finally:
        llm.client.close()
        await original_async_client.close()

    assert result.content == "done"
    assert result.tool_calls == [{"name": "inspect", "arguments": {"path": "."}, "call_id": "call-1"}]
    assert result.usage == {"input_tokens": 3, "output_tokens": 2}
    assert result.capture == {"thinking_blocks": [{"type": "thinking", "thinking": "plan", "signature": "sig"}]}
    assert events == [("reasoning", {"text": "plan"}), ("token", {"text": "done"})]


async def test_google_stream_turn_reduces_native_chunks() -> None:
    """The Google adapter returns signed tool calls and normalized usage."""
    llm = GoogleLlm(
        api_key="test-key",
        configuration=GoogleConfiguration(model="gemini-test"),
    )
    original_async_client = llm.async_client
    events, publish = _events()

    def chunk(parts: list[dict[str, Any]], usage: dict[str, int] | None = None):
        payload: dict[str, Any] = {"candidates": [{"content": {"role": "model", "parts": parts}}]}
        if usage is not None:
            payload["usage_metadata"] = usage
        return types.GenerateContentResponse.model_validate(payload)

    class Stream:
        def __aiter__(self):
            return self._iterate()

        async def _iterate(self):
            yield chunk([{"text": "plan", "thought": True}])
            yield chunk([
                {"text": "done"},
                {"function_call": {"id": "call-1", "name": "inspect", "args": {"path": "."}}, "thought_signature": b"sig"},
            ], {"prompt_token_count": 3, "candidates_token_count": 1, "thoughts_token_count": 2})

    async def generate_content_stream(**_params):
        return Stream()

    llm.async_client = SimpleNamespace(models=SimpleNamespace(generate_content_stream=generate_content_stream))
    try:
        result = await llm.stream_turn(
            [Message.from_text("inspect", role=Role.USER)],
            None,
            publish=publish,
        )
    finally:
        llm.client.close()
        await original_async_client.aclose()

    assert result.content == "done"
    assert result.tool_calls == [{"name": "inspect", "arguments": {"path": "."}, "call_id": "call-1"}]
    assert result.usage == {"input_tokens": 3, "output_tokens": 3}
    assert result.capture == {"thought_signatures": ["c2ln"]}
    assert events == [("reasoning", {"text": "plan"}), ("token", {"text": "done"})]


async def test_codex_stream_turn_refreshes_401_and_reduces_sse() -> None:
    """The Codex adapter refreshes once on 401 and folds the complete Responses stream."""
    credential_calls: list[bool] = []

    def credentials(*, force: bool = False) -> CodexCreds:
        credential_calls.append(force)
        return CodexCreds(
            access_token="fresh-token" if force else "stale-token",
            refresh_token="refresh-token",
            account_id="account-id",
            id_token=None,
        )

    response_events = [
        {"type": "response.reasoning_summary_text.delta", "delta": "plan"},
        {"type": "response.output_text.delta", "delta": "done"},
        {"type": "response.output_item.added", "item": {"type": "function_call", "id": "item-1", "call_id": "call-1", "name": "inspect", "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "item_id": "item-1", "delta": '{"path":"."}'},
        {"type": "response.output_item.done", "item": {"type": "reasoning", "id": "reason-1", "encrypted_content": "opaque"}},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 2}}},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers["authorization"] == "Bearer stale-token":
            return httpx.Response(401, json={"error": "expired"})
        body = json.loads(request.content)
        assert body["reasoning"] == {"summary": "auto"}
        payload = "".join(f"data: {json.dumps(event)}\n\n" for event in response_events)
        return httpx.Response(200, text=payload, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    llm = CodexResponsesLlm(
        access_token="initial-token",
        account_id="account-id",
        configuration=CodexConfiguration(model="gpt-codex"),
        credential_provider=credentials,
        transport=transport,
        async_transport=transport,
    )
    events, publish = _events()
    try:
        result = await llm.stream_turn(
            [Message.from_text("inspect", role=Role.USER)],
            None,
            publish=publish,
        )
    finally:
        llm.client.close()
        await llm.async_client.aclose()

    assert credential_calls == [False, True]
    assert result.content == "done"
    assert result.tool_calls == [{"name": "inspect", "arguments": {"path": "."}, "call_id": "call-1"}]
    assert result.usage == {"input_tokens": 3, "output_tokens": 2}
    assert result.capture == {"reasoning_items": [{"type": "reasoning", "id": "reason-1", "encrypted_content": "opaque"}]}
    assert events == [("reasoning", {"text": "plan"}), ("token", {"text": "done"})]
