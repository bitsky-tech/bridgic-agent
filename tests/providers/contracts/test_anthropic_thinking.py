from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicConfiguration, AnthropicLlm


class _ThinkingParameterError(RuntimeError):
    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.body = {"error": {"message": message, "type": "invalid_request_error"}}


def _llm(model: str, temperature: float = 0.7) -> AnthropicLlm:
    return AnthropicLlm(
        api_key="test-key",
        configuration=AnthropicConfiguration(model=model, temperature=temperature),
    )


def _record_stream(reject: Callable[[dict[str, Any] | None], str | None]) -> tuple[list[dict[str, Any]], Any]:
    attempts: list[dict[str, Any]] = []

    async def run(params: dict[str, Any], _publish: Callable[..., None]) -> StreamResult:
        attempts.append(dict(params))
        message = reject(params.get("thinking"))
        if message is not None:
            raise _ThinkingParameterError(message)
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    return attempts, run


async def _close(llm: AnthropicLlm) -> None:
    llm.client.close()
    await llm.async_client.close()


async def test_streaming_thinking_ladder_learns_the_supported_tier() -> None:
    """Streaming starts with summarized thinking and remembers the accepted fallback."""
    summarized = {"type": "adaptive", "display": "summarized"}
    adaptive = {"type": "adaptive"}

    def reject(thinking: dict[str, Any] | None) -> str | None:
        if thinking == summarized:
            return "thinking.display: Extra inputs are not permitted"
        if thinking == adaptive:
            return "thinking.type: Input should be 'enabled' or 'disabled'"
        return None

    attempts, run = _record_stream(reject)
    llm = _llm("claude-sonnet-4-5")
    llm._run_stream = run  # type: ignore[method-assign]
    try:
        first = await llm.stream_turn([], None, publish=lambda *_args, **_kwargs: None)
        second = await llm.stream_turn([], None, publish=lambda *_args, **_kwargs: None)
    finally:
        await _close(llm)

    assert first.content == second.content == "done"
    assert [attempt["thinking"] for attempt in attempts] == [
        summarized,
        adaptive,
        {"type": "enabled", "budget_tokens": 4096},
        {"type": "enabled", "budget_tokens": 4096},
    ]
    assert all("temperature" not in attempt for attempt in attempts)


async def test_streaming_thinking_fallback_restores_and_heals_sampling() -> None:
    """An incompatible endpoint reaches plain generation and still self-heals sampling params."""
    attempts: list[dict[str, Any]] = []

    async def run(params: dict[str, Any], _publish: Callable[..., None]) -> StreamResult:
        attempts.append(dict(params))
        if "thinking" in params:
            raise _ThinkingParameterError("adaptive thinking is not supported")
        if "temperature" in params:
            raise _ThinkingParameterError("`temperature` is deprecated for this model")
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    llm = _llm("relay-model")
    llm._run_stream = run  # type: ignore[method-assign]
    try:
        result = await llm.stream_turn([], None, publish=lambda *_args, **_kwargs: None)
    finally:
        await _close(llm)

    assert result.content == "done"
    assert [("thinking" in attempt, "temperature" in attempt) for attempt in attempts] == [
        (True, False),
        (True, False),
        (True, False),
        (False, True),
        (False, False),
    ]


async def test_streaming_thinking_does_not_mask_unrelated_errors() -> None:
    attempts, run = _record_stream(lambda _thinking: "tools.0.input_schema: Field required")
    llm = _llm("claude-sonnet-5")
    llm._run_stream = run  # type: ignore[method-assign]
    try:
        with pytest.raises(_ThinkingParameterError, match="input_schema"):
            await llm.stream_turn([], None, publish=lambda *_args, **_kwargs: None)
    finally:
        await _close(llm)

    assert len(attempts) == 1


async def test_anthropic_chat_forwards_override_without_default_thinking() -> None:
    """The safety-classifier path forwards its override but never starts the streaming ladder."""
    calls: list[dict[str, Any]] = []

    async def create(**params: Any) -> SimpleNamespace:
        calls.append(dict(params))
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="pong")])

    llm = _llm("claude-opus-5")
    original_async_client = llm.async_client
    llm.async_client = SimpleNamespace(messages=SimpleNamespace(create=create))
    try:
        result = await llm.achat(
            [Message.from_text("ping", role=Role.USER)],
            extra_body={"output_config": {"effort": "low"}},
        )
    finally:
        llm.client.close()
        await original_async_client.close()

    assert result == "pong"
    assert calls[0]["output_config"] == {"effort": "low"}
    assert "thinking" not in calls[0]
