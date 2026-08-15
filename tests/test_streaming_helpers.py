import httpx
import pytest

from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms._streaming import (
    ModelNotFoundError,
    StreamResult,
    convert_tools,
    is_daily_quota_error,
    is_incomplete_stream_error,
    is_model_not_found_error,
    is_rate_limit_error,
    is_retryable_stream_error,
    is_retryable_transport_error,
    is_transient_server_error,
    model_not_found_message,
    open_stream_with_retry,
    parse_tool_calls,
    rate_limit_delay,
    stream_with_transport_retry,
)


def test_incomplete_chunked_read_detects_direct_and_wrapped_transport_errors() -> None:
    direct = httpx.RemoteProtocolError(
        "peer closed connection without sending complete message body (incomplete chunked read)"
    )
    wrapped = RuntimeError("provider stream failed")
    wrapped.__cause__ = direct

    assert is_incomplete_stream_error(direct)
    assert is_incomplete_stream_error(wrapped)
    assert not is_incomplete_stream_error(httpx.ReadTimeout("slow response"))


@pytest.mark.parametrize("error", [
    httpx.ConnectError("connection refused"),
    httpx.ConnectTimeout("connect timed out"),
    httpx.ReadError("connection reset by peer"),
    httpx.ReadTimeout("read timed out"),
    httpx.WriteError("broken pipe"),
    httpx.WriteTimeout("write timed out"),
    httpx.PoolTimeout("pool timed out"),
    httpx.ProxyError("proxy connection failed"),
    httpx.CloseError("close failed"),
    httpx.RemoteProtocolError("server disconnected"),
    TimeoutError("provider timed out"),
    ConnectionResetError("connection reset"),
])
def test_retryable_transport_error_covers_transient_io(error: BaseException) -> None:
    wrapped = RuntimeError("Worker failed")
    wrapped.__cause__ = error
    assert is_retryable_transport_error(error)
    assert is_retryable_transport_error(wrapped)


def test_retryable_transport_error_covers_sdk_wrappers_and_exception_groups() -> None:
    api_connection_error = type("APIConnectionError", (Exception,), {})("request failed")
    grouped = ExceptionGroup("provider failures", [ValueError("bad chunk"), api_connection_error])

    assert is_retryable_transport_error(api_connection_error)
    assert is_retryable_transport_error(grouped)


@pytest.mark.parametrize("error", [
    ValueError("invalid request"),
    httpx.LocalProtocolError("illegal request shape"),
    httpx.DecodingError("invalid gzip body"),
    httpx.HTTPStatusError(
        "bad request",
        request=httpx.Request("POST", "https://example.test"),
        response=httpx.Response(400),
    ),
])
def test_retryable_transport_error_excludes_permanent_failures(error: BaseException) -> None:
    assert not is_retryable_transport_error(error)


async def test_stream_transport_retry_rolls_back_partial_deltas(monkeypatch) -> None:
    import src.amphi_service.protocol.llms._streaming as streaming_module

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = 0
    events = []

    async def factory(publish):
        nonlocal calls
        calls += 1
        if calls == 1:
            publish("token", text="半截🙂")
            publish("reasoning", text="thinking")
            try:
                raise httpx.ConnectError("connection reset")
            except httpx.ConnectError as exc:
                raise RuntimeError("provider stream failed") from exc
        return StreamResult(tool_calls=[], content="complete")

    result = await stream_with_transport_retry(
        factory,
        lambda channel, **payload: events.append((channel, payload)),
    )

    assert result.content == "complete"
    assert calls == 2
    assert events[-2:] == [
        ("model_retry", {
            "active": True,
            "attempt": 1,
            "max_retries": 2,
            "delay_seconds": 1.0,
            "discard_text_chars": 3,
            "discard_reasoning_chars": 8,
        }),
        ("model_retry", {
            "active": False,
            "attempt": 1,
            "max_retries": 2,
            "delay_seconds": 0.0,
        }),
    ]


async def test_stream_transport_retry_clears_status_before_recovered_output(monkeypatch) -> None:
    import src.amphi_service.protocol.llms._streaming as streaming_module

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = 0
    events = []

    async def factory(publish):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("connection reset")
        publish("token", text="恢复")
        return StreamResult(tool_calls=[], content="恢复")

    await stream_with_transport_retry(
        factory,
        lambda channel, **payload: events.append((channel, payload)),
    )

    assert [channel for channel, _payload in events] == [
        "model_retry", "model_retry", "token",
    ]
    assert events[1][1]["active"] is False


async def test_stream_transport_retry_is_bounded_and_reraises_last_error(monkeypatch) -> None:
    import src.amphi_service.protocol.llms._streaming as streaming_module

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = 0

    async def factory(_publish):
        nonlocal calls
        calls += 1
        raise httpx.ConnectError(f"connection attempt {calls} failed")

    with pytest.raises(httpx.ConnectError, match="attempt 3"):
        await stream_with_transport_retry(factory, lambda _channel, **_payload: None)
    assert calls == 3


async def test_stream_transport_retry_does_not_retry_permanent_error() -> None:
    calls = 0

    async def factory(_publish):
        nonlocal calls
        calls += 1
        raise ValueError("invalid request")

    with pytest.raises(ValueError, match="invalid request"):
        await stream_with_transport_retry(factory, lambda _channel, **_payload: None)
    assert calls == 1


def test_convert_tools_anthropic_from_flat_tool() -> None:
    class T:
        name = "bash"; description = "run"; parameters = {"type": "object", "properties": {}}
    out = convert_tools([T()], "anthropic")
    assert out == [{"name": "bash", "description": "run",
                    "input_schema": {"type": "object", "properties": {}}}]


def test_convert_tools_responses_shape() -> None:
    class T:
        name = "bash"; description = "run"; parameters = {"type": "object", "properties": {}}
    out = convert_tools([T()], "responses")
    assert out[0]["type"] == "function" and out[0]["name"] == "bash"


def test_parse_tool_calls_skips_noname_and_bad_json() -> None:
    calls = parse_tool_calls([
        {"name": "", "arguments": "{}"},
        {"name": "ok", "arguments": '{"a":1}', "call_id": "call_1"},
        {"name": "bad", "arguments": "not json"},
    ])
    assert calls == [{"name": "ok", "arguments": {"a": 1}, "call_id": "call_1"},
                     {"name": "bad", "arguments": {}}]


def test_accumulate_tool_deltas_merges_fragments_by_index() -> None:
    from src.amphi_service.protocol.llms._streaming import accumulate_tool_deltas

    class _Fn:
        def __init__(self, name="", arguments=""):
            self.name = name; self.arguments = arguments

    class _D:
        def __init__(self, index, name="", arguments="", function=..., tool_id=None):
            self.index = index
            self.id = tool_id
            self.function = _Fn(name, arguments) if function is ... else function

    buffers: dict = {}
    accumulate_tool_deltas(buffers, [_D(0, name="get_weather", tool_id="call_openai_1")])
    accumulate_tool_deltas(buffers, [_D(0, arguments='{"city":')])
    accumulate_tool_deltas(buffers, [_D(0, arguments='"BJ"}')])
    # A None-function delta seeds nothing new — the buffer already exists and the
    # guard skips it without raising.
    accumulate_tool_deltas(buffers, [_D(0, function=None)])
    assert buffers == {
        0: {
            "name": "get_weather",
            "arguments": '{"city":"BJ"}',
            "call_id": "call_openai_1",
        }
    }


def test_accumulate_reasoning_details_merges_text_and_keeps_signature() -> None:
    """OpenRouter streams ``reasoning_details`` as per-index fragments: the ``text``
    accumulates across chunks while a trailing ``signature`` (Anthropic/Gemini
    via OpenRouter) must be preserved verbatim — that signature is what lets the
    routed model continue reasoning across a tool-call turn without a 400."""
    from src.amphi_service.protocol.llms._streaming import accumulate_reasoning_details

    buffers: dict = {}
    accumulate_reasoning_details(buffers, [
        {"type": "reasoning.text", "text": "We ", "format": "anthropic-claude-v1", "index": 0}])
    accumulate_reasoning_details(buffers, [{"type": "reasoning.text", "text": "think", "index": 0}])
    # A later fragment for the same block carries the signature (last-wins).
    accumulate_reasoning_details(buffers, [{"type": "reasoning.text", "signature": "SIG", "index": 0}])
    # A non-dict fragment is skipped without raising.
    accumulate_reasoning_details(buffers, ["garbage"])
    assert buffers == {0: {
        "type": "reasoning.text", "text": "We think",
        "format": "anthropic-claude-v1", "signature": "SIG", "index": 0}}


def test_stream_result_defaults() -> None:
    r = StreamResult(tool_calls=[], content="hi")
    assert r.usage is None and r.capture == {}


# ── retry-classification helpers ─────────────────────────────────────────────


class _Err(Exception):
    """Exception carrying a ``status_code`` like the OpenAI/Anthropic SDK errors."""

    def __init__(self, message: str, status_code=None) -> None:
        super().__init__(message)
        self.status_code = status_code


class _HttpxLikeErr(Exception):
    """Exception carrying status on ``.response.status_code`` like httpx.HTTPStatusError."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.response = type("R", (), {"status_code": status_code})()


def test_is_rate_limit_error_by_status_text_and_response() -> None:
    assert is_rate_limit_error(_Err("boom", status_code=429))
    assert is_rate_limit_error(_HttpxLikeErr("Too Many Requests", 429))  # httpx shape
    assert is_rate_limit_error(Exception("Error code: 429 - rate-limited upstream"))
    assert is_rate_limit_error(Exception("RESOURCE_EXHAUSTED"))
    assert not is_rate_limit_error(_Err("bad request", status_code=400))


def test_is_transient_server_error_covers_5xx_and_capacity_text() -> None:
    assert is_transient_server_error(_Err("boom", status_code=503))
    assert is_transient_server_error(_HttpxLikeErr("Service Unavailable", 502))
    assert is_transient_server_error(Exception("No backends available"))  # OpenRouter 503
    assert is_transient_server_error(Exception("Overloaded"))  # Anthropic 529 wording
    # 429 is a rate-limit, NOT a transient server error.
    assert not is_transient_server_error(_Err("rate", status_code=429))
    assert not is_transient_server_error(_Err("bad request", status_code=400))


def test_is_retryable_excludes_daily_quota_and_400() -> None:
    assert is_retryable_stream_error(_Err("rate", status_code=429))
    assert is_retryable_stream_error(_Err("capacity", status_code=503))
    assert not is_retryable_stream_error(_Err("bad request", status_code=400))
    # A per-day quota 429 is rate-limit-shaped but must NOT be retried.
    daily = Exception("429 RESOURCE_EXHAUSTED: requests per day exceeded")
    assert is_daily_quota_error(daily)
    assert not is_retryable_stream_error(daily)


def test_rate_limit_delay_is_short_and_bounded() -> None:
    assert [rate_limit_delay(Exception("overloaded"), attempt) for attempt in range(4)] == [
        1.0, 2.0, 4.0, 8.0,
    ]
    assert rate_limit_delay(Exception("retryDelay: 45s"), 0) == 10.0


async def test_open_stream_with_retry_recovers_from_503(monkeypatch) -> None:
    """A transient 503 on open is retried and then succeeds — no wasted wall clock
    (delay stubbed to 0)."""
    import src.amphi_service.protocol.llms._streaming as s

    monkeypatch.setattr(s, "rate_limit_delay", lambda exc, attempt: 0.0)
    calls = {"n": 0}
    events = []

    async def factory():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _Err("No backends available", status_code=503)
        return "stream-opened"

    def publish(event, **payload):
        events.append((event, payload))

    assert await open_stream_with_retry(factory, publish=publish) == "stream-opened"
    assert calls["n"] == 2  # failed once, retried, succeeded
    assert events == [
        ("model_retry", {
            "active": True,
            "attempt": 1,
            "max_retries": 3,
            "delay_seconds": 0.0,
        }),
        ("model_retry", {
            "active": False,
            "attempt": 1,
            "max_retries": 3,
            "delay_seconds": 0.0,
        }),
    ]


async def test_open_stream_with_retry_reraises_non_retryable() -> None:
    """A 400 is not retried — it surfaces immediately."""
    calls = {"n": 0}

    async def factory():
        calls["n"] += 1
        raise _Err("bad request", status_code=400)

    with pytest.raises(_Err):
        await open_stream_with_retry(factory)
    assert calls["n"] == 1  # no retry


async def test_open_stream_with_retry_daily_quota_fast_fails() -> None:
    """A per-day quota 429 fast-fails with a clear RuntimeError (no backoff loop)."""
    calls = {"n": 0}

    async def factory():
        calls["n"] += 1
        raise Exception("429 RESOURCE_EXHAUSTED: requests per day exceeded")

    with pytest.raises(RuntimeError, match="配额"):
        await open_stream_with_retry(factory)
    assert calls["n"] == 1


def test_model_not_found_message_uses_the_active_service_locale() -> None:
    """The stream's final, user-visible model error follows request locale."""
    with use_locale("en"):
        assert model_not_found_message("missing-model") == (
            "Model ID 'missing-model' is invalid or unavailable (the provider returned "
            "model-not-found / 404). Check the provider's model ID and select a valid model."
        )


async def test_open_stream_daily_quota_message_uses_the_active_service_locale() -> None:
    async def factory():
        raise Exception("429 RESOURCE_EXHAUSTED: requests per day exceeded")

    with use_locale("en"), pytest.raises(RuntimeError, match="daily request quota"):
        await open_stream_with_retry(factory)


# ── model-not-found classification (R6) ──────────────────────────────────────


def test_is_model_not_found_by_code_status_and_text() -> None:
    # httpx shape: 404 + "model" wording (Codex / raw client).
    assert is_model_not_found_error(_HttpxLikeErr("The model `x` does not exist", 404))
    # OpenAI-style ``.code``.
    bad_code = _Err("whatever")
    bad_code.code = "model_not_found"
    assert is_model_not_found_error(bad_code)
    # Text fallbacks.
    assert is_model_not_found_error(Exception("Error: model_not_found"))
    assert is_model_not_found_error(Exception("models/gemini-x is not found for API version v1"))
    # NOT a model error: a 404 without 'model', or a 400 params error.
    assert not is_model_not_found_error(_HttpxLikeErr("route not found", 404))
    assert not is_model_not_found_error(_Err("unsupported_parameter", status_code=400))


async def test_open_stream_with_retry_translates_model_not_found() -> None:
    """With ``model`` set, a model-not-found 404 becomes a clear ModelNotFoundError;
    without it, the original error surfaces unchanged."""
    async def factory():
        raise _HttpxLikeErr("The model `deepseek-v4-pro` does not exist", 404)

    with pytest.raises(ModelNotFoundError, match="deepseek-v4-pro"):
        await open_stream_with_retry(factory, model="deepseek-v4-pro")

    with pytest.raises(_HttpxLikeErr):
        await open_stream_with_retry(factory)  # no model → not translated
