"""CodexResponsesLlm — Responses-API adapter over httpx + SSE.

Invariant: stream-only Responses wire, model gpt-5.4, headers carry the
account id + responses=experimental. SSE is mocked via httpx.MockTransport;
no real network.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms._codex_credentials import CodexAuthError, CodexCreds
from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms.codex_llm import (
    DEFAULT_CODEX_MODEL,
    CodexResponsesLlm,
    parse_sse_event,
    resolve_responses_url,
)


def _creds(access_token: str, refresh_token: str = "rt") -> CodexCreds:
    return CodexCreds(
        access_token=access_token, refresh_token=refresh_token,
        account_id="acct-9", id_token=None,
    )


def _recording_provider(by_force: dict, calls: list):
    """A credential provider that returns ``by_force[force]`` and records each
    ``force`` flag it was called with."""
    def provider(*, force: bool = False) -> CodexCreds:
        calls.append(force)
        return by_force[force]
    return provider


def _sse(*deltas: str) -> str:
    out = ["event: response.created", 'data: {"type":"response.created"}', ""]
    for d in deltas:
        out += [
            "event: response.output_text.delta",
            "data: " + json.dumps({"type": "response.output_text.delta", "delta": d}),
            "",
        ]
    out += ["event: response.completed", 'data: {"type":"response.completed"}', ""]
    return "\n".join(out)


def _llm(handler=None, **kw) -> CodexResponsesLlm:
    transport = httpx.MockTransport(handler) if handler else None
    return CodexResponsesLlm(
        access_token="at-tok",
        account_id="acct-9",
        transport=transport,
        async_transport=transport,
        **kw,
    )


def test_client_wiring_protocol_url_and_headers() -> None:
    """How the client is wired: protocol marker, /codex/responses URL resolution
    (already-suffixed + bare proxy), and the auth/account/beta/originator headers."""
    llm = _llm()
    assert llm.protocol == "openai-codex"

    assert (
        resolve_responses_url("https://chatgpt.com/backend-api/codex")
        == "https://chatgpt.com/backend-api/codex/responses"
    )
    assert resolve_responses_url("https://x/codex/responses") == "https://x/codex/responses"
    assert resolve_responses_url("https://proxy.example") == "https://proxy.example/codex/responses"

    h = llm.async_client.headers
    assert h["authorization"] == "Bearer at-tok"
    assert h["chatgpt-account-id"] == "acct-9"
    assert h["openai-beta"] == "responses=experimental"
    assert h["originator"] == "codex_cli_rs"


def test_missing_local_login_error_follows_active_backend_locale() -> None:
    with use_locale("en"):
        with pytest.raises(CodexAuthError) as exc_info:
            _llm()._apply_creds(None)

    assert exc_info.value.code == "codex_login_missing"
    assert str(exc_info.value) == "No Codex sign-in details were found. Please sign in again."


def test_connection_hardening_timeout_and_no_keepalive() -> None:
    """连接健壮性:读超时即 idle 超时,对齐官方 codex-rs 300s(静默死流 5 分钟
    内被客户端主动掐断并走重连,而不是干等);连接超时快失败;不复用空闲连接。"""
    from src.amphi_service.protocol.llms.codex_llm import (
        _CONNECT_TIMEOUT,
        _DEFAULT_TIMEOUT,
        _NO_KEEPALIVE_LIMITS,
        _READ_IDLE_TIMEOUT,
        _build_timeout,
    )

    t = _build_timeout()
    assert t.connect == _CONNECT_TIMEOUT     # 链路不通 → 快速失败
    assert t.read == _READ_IDLE_TIMEOUT == 300.0  # idle 超时对齐官方 300_000ms
    assert t.write == _DEFAULT_TIMEOUT
    assert t.pool == _DEFAULT_TIMEOUT
    assert _NO_KEEPALIVE_LIMITS.max_keepalive_connections == 0


def test_real_clients_construct_with_hardening() -> None:
    """无注入 transport 时构造真实 httpx 客户端(http2=False + 无保活 limits)不报错。"""
    llm = _llm()  # 不传 handler → 走真实 httpx.Client / AsyncClient
    assert isinstance(llm.client, httpx.Client)
    assert isinstance(llm.async_client, httpx.AsyncClient)


def test_build_parameters_text_and_tools() -> None:
    msgs = [
        Message.from_text("be terse", role=Role.SYSTEM),
        Message.from_text("hi", role=Role.USER),
    ]
    body = _llm()._build_parameters(msgs)
    assert body["model"] == DEFAULT_CODEX_MODEL
    assert body["stream"] is True
    assert body["store"] is False
    assert body["instructions"] == "be terse"
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["input"][0] == {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "hi"}],
    }
    # gpt-5.4 (reasoning) rejects temperature on the Codex endpoint — never send it.
    assert "temperature" not in body

    # tools are passed through verbatim.
    tools = [{"type": "function", "name": "bash", "parameters": {"type": "object"}}]
    body = _llm()._build_parameters([Message.from_text("hi", role=Role.USER)], tools=tools)
    assert body["tools"] == tools


async def test_sse_parse_and_achat_assembles_text() -> None:
    # parse_sse_event grammar: data-JSON kept, event/[DONE]/non-json dropped.
    assert parse_sse_event('data: {"type":"x"}') == {"type": "x"}
    assert parse_sse_event("event: x") is None
    assert parse_sse_event("data: [DONE]") is None
    assert parse_sse_event("data: not json") is None

    # end-to-end: mocked streaming Responses wire assembles to the full text.
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/codex/responses")
        body = json.loads(request.content)
        assert body["stream"] is True
        return httpx.Response(
            200, text=_sse("Hel", "lo"), headers={"content-type": "text/event-stream"}
        )

    out = await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])
    assert out == "Hello"


async def test_stream_turn_retries_transient_503(monkeypatch) -> None:
    """Codex uses a raw httpx client with no built-in status retry; ``stream_turn``
    now wraps the open in ``open_stream_with_retry``, so a transient 503 (e.g. an
    upstream capacity blip) is retried and the turn still assembles. Delay stubbed
    to 0 so the test is instant."""
    import src.amphi_service.protocol.llms._streaming as s

    monkeypatch.setattr(s, "rate_limit_delay", lambda exc, attempt: 0.0)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="No backends available")
        return httpx.Response(
            200, text=_sse("Hi"), headers={"content-type": "text/event-stream"}
        )

    result = await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
    )
    assert calls["n"] == 2  # failed once (503), retried, succeeded
    assert result.content == "Hi"


async def test_stream_turn_retries_incomplete_chunked_read_and_discards_partial_deltas(
    monkeypatch,
) -> None:
    """A body truncated after HTTP 200 retries without retaining its partial output."""
    import src.amphi_service.protocol.llms._streaming as streaming_module

    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield _sse("partial").encode()
            raise httpx.RemoteProtocolError(
                "peer closed connection without sending complete message body "
                "(incomplete chunked read)"
            )

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(
                200,
                stream=BrokenBody(),
                headers={"content-type": "text/event-stream"},
            )
        return httpx.Response(
            200,
            text=_sse("complete"),
            headers={"content-type": "text/event-stream"},
        )

    events = []
    result = await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)],
        None,
        publish=lambda channel, **payload: events.append((channel, payload)),
    )

    assert calls["n"] == 2
    assert result.content == "complete"
    assert events == [
        ("token", {"text": "partial"}),
        ("model_retry", {
            "active": True,
            "attempt": 1,
            "max_retries": 5,
            "delay_seconds": 1.0,
            "discard_text_chars": 7,
            "discard_reasoning_chars": 0,
        }),
        ("model_retry", {
            "active": False,
            "attempt": 1,
            "max_retries": 5,
            "delay_seconds": 0.0,
        }),
        ("token", {"text": "complete"}),
    ]


async def test_stream_turn_retries_wrapped_connect_error(monkeypatch) -> None:
    """Connection establishment failures use the same visible bounded retry path."""
    import src.amphi_service.protocol.llms._streaming as streaming_module

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            try:
                raise httpx.ConnectError("connection refused", request=request)
            except httpx.ConnectError as exc:
                raise RuntimeError("SDK connection failed") from exc
        return httpx.Response(
            200,
            text=_sse("connected"),
            headers={"content-type": "text/event-stream"},
        )

    events = []
    result = await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)],
        None,
        publish=lambda channel, **payload: events.append((channel, payload)),
    )

    assert calls == 2
    assert result.content == "connected"
    assert [event for event in events if event[0] == "model_retry"] == [
        ("model_retry", {
            "active": True,
            "attempt": 1,
            "max_retries": 5,
            "delay_seconds": 1.0,
            "discard_text_chars": 0,
            "discard_reasoning_chars": 0,
        }),
        ("model_retry", {
            "active": False,
            "attempt": 1,
            "max_retries": 5,
            "delay_seconds": 0.0,
        }),
    ]


async def test_stream_turn_does_not_retry_400(monkeypatch) -> None:
    """A 400 is a real request error — surfaced immediately, not retried."""
    import src.amphi_service.protocol.llms._streaming as s

    monkeypatch.setattr(s, "rate_limit_delay", lambda exc, attempt: 0.0)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad request")

    with pytest.raises(httpx.HTTPStatusError):
        await _llm(handler).stream_turn(
            [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
        )
    assert calls["n"] == 1  # no retry on 400


async def test_preemptive_refresh_sends_provider_token() -> None:
    """With a credential_provider, every request resolves fresh creds first and
    sends the provider's token — not the (possibly stale) token baked at build."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        return httpx.Response(200, text=_sse("ok"), headers={"content-type": "text/event-stream"})

    calls: list[bool] = []
    fresh = _creds("fresh-tok")
    llm = _llm(handler, credential_provider=_recording_provider({False: fresh, True: fresh}, calls))
    out = await llm.achat([Message.from_text("hi", role=Role.USER)])

    assert out == "ok"
    assert seen == ["Bearer fresh-tok"]   # provider token, not the baked "at-tok"
    assert calls == [False]               # resolved once, preemptively (no force)


async def test_401_forces_refresh_and_retries_once() -> None:
    """A 401 triggers a force-refresh and exactly ONE retry; the retry carries
    the force-refreshed token and succeeds."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        if len(seen) == 1:
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(200, text=_sse("recovered"), headers={"content-type": "text/event-stream"})

    calls: list[bool] = []
    tokens = {False: _creds("stale-tok"), True: _creds("forced-tok", refresh_token="rt2")}
    llm = _llm(handler, credential_provider=_recording_provider(tokens, calls))
    out = await llm.achat([Message.from_text("hi", role=Role.USER)])

    assert out == "recovered"
    assert seen == ["Bearer stale-tok", "Bearer forced-tok"]
    assert calls == [False, True]         # preemptive, then forced on the 401


async def test_stream_turn_preemptive_and_401_retry() -> None:
    """The agent's main path (stream_turn) also refreshes preemptively and
    retries once on 401 with a force-refreshed token."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        if len(seen) == 1:
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(200, text=_sse("hi"), headers={"content-type": "text/event-stream"})

    calls: list[bool] = []
    tokens = {False: _creds("s-tok"), True: _creds("f-tok")}
    llm = _llm(handler, credential_provider=_recording_provider(tokens, calls))
    result = await llm.stream_turn(
        [Message.from_text("hi", role=Role.USER)], None, publish=lambda *a, **k: None,
    )

    assert result.content == "hi"
    assert seen == ["Bearer s-tok", "Bearer f-tok"]
    assert calls == [False, True]


async def test_401_without_provider_raises_without_retry() -> None:
    """No provider → a 401 can't be recovered; it raises and is NOT retried."""
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(1)
        return httpx.Response(401, json={"error": "expired"})

    with pytest.raises(httpx.HTTPStatusError):
        await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])
    assert len(seen) == 1                 # single attempt, no retry


async def test_persistent_401_gives_up_after_one_retry() -> None:
    """When the force-refreshed retry ALSO 401s, give up (one retry, then raise)."""
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(1)
        return httpx.Response(401, json={"error": "expired"})

    llm = _llm(handler, credential_provider=lambda *, force=False: _creds("x"))
    with pytest.raises(httpx.HTTPStatusError):
        await llm.achat([Message.from_text("hi", role=Role.USER)])
    assert len(seen) == 2                 # original + exactly one forced retry


_CODEX_LOGGER = "src.amphi_service.protocol.llms.codex_llm"


async def test_connectivity_diagnostic_logged_on_connect_error(caplog) -> None:
    """A transport/connection failure logs a one-line connectivity diagnostic that
    pinpoints the Codex endpoint host — the crux of 'Codex 连不上,换 DeepSeek 就行'."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with caplog.at_level(logging.WARNING, logger=_CODEX_LOGGER):
        with pytest.raises(httpx.ConnectError):
            await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])

    diagnostics = [
        r.getMessage() for r in caplog.records
        if "codex connectivity failure" in r.getMessage()
    ]
    assert diagnostics, "expected a connectivity diagnostic warning"
    assert "chatgpt.com" in diagnostics[0]
    assert "/codex/responses" in diagnostics[0]
    assert "at-tok" not in diagnostics[0]  # never log the token


async def test_connectivity_diagnostic_classifies_incomplete_stream(caplog) -> None:
    """The observed failure — a long SSE response cut mid-body — is diagnosed as a
    stream-cutoff (not a can't-connect), surfacing the incomplete-read root cause."""
    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise httpx.RemoteProtocolError(
                "peer closed connection without sending complete message body "
                "(incomplete chunked read)"
            )
            yield b""  # unreachable — makes this an async generator

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, stream=BrokenBody(), headers={"content-type": "text/event-stream"}
        )

    with caplog.at_level(logging.WARNING, logger=_CODEX_LOGGER):
        with pytest.raises(httpx.RemoteProtocolError):
            await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])

    diagnostics = [
        r.getMessage() for r in caplog.records
        if "codex connectivity failure" in r.getMessage()
    ]
    assert diagnostics, "expected a connectivity diagnostic warning"
    assert "流式响应中途被切断" in diagnostics[0]
    assert "incomplete chunked read" in diagnostics[0]


async def test_no_connectivity_diagnostic_on_business_error(caplog) -> None:
    """A 400 is a real request error, not a connectivity failure — no diagnostic noise."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad request")

    with caplog.at_level(logging.WARNING, logger=_CODEX_LOGGER):
        with pytest.raises(httpx.HTTPStatusError):
            await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])

    assert not [
        r for r in caplog.records if "codex connectivity failure" in r.getMessage()
    ]


async def test_request_start_debug_log_records_endpoint(caplog) -> None:
    """Each request debug-logs the endpoint it hits, so the target is visible in logs."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_sse("ok"), headers={"content-type": "text/event-stream"})

    with caplog.at_level(logging.DEBUG, logger=_CODEX_LOGGER):
        await _llm(handler).achat([Message.from_text("hi", role=Role.USER)])

    starts = [r.getMessage() for r in caplog.records if r.getMessage().startswith("codex request")]
    assert starts and "chatgpt.com/backend-api/codex/responses" in starts[0]


async def test_provider_returning_none_raises_relogin() -> None:
    """A provider that returns None (local ~/.codex login vanished) surfaces a
    relogin CodexAuthError, not a confusing header/None error."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_sse("x"), headers={"content-type": "text/event-stream"})

    llm = _llm(handler, credential_provider=lambda *, force=False: None)
    with pytest.raises(CodexAuthError) as ei:
        await llm.achat([Message.from_text("hi", role=Role.USER)])
    assert ei.value.relogin_required is True


async def test_stream_turn_requests_reasoning_summary() -> None:
    """stream_turn 注入 reasoning.summary=auto:思考期保持 SSE 流量(防 idle 掐断)
    并点亮 UI reasoning 通道;对齐官方 codex-rs 的 build_reasoning。"""
    seen_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_bodies.append(json.loads(request.content))
        return httpx.Response(
            200, text=_sse("Hi"), headers={"content-type": "text/event-stream"}
        )

    await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
    )
    assert seen_bodies[0]["reasoning"] == {"summary": "auto"}


async def test_stream_turn_extra_body_reasoning_wins() -> None:
    """extra_body 显式指定 reasoning 时不被默认值覆盖(setdefault 语义)。"""
    seen_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_bodies.append(json.loads(request.content))
        return httpx.Response(
            200, text=_sse("Hi"), headers={"content-type": "text/event-stream"}
        )

    await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)], None,
        publish=lambda ch, **kw: None,
        extra_body={"reasoning": {"effort": "none"}},
    )
    assert seen_bodies[0]["reasoning"] == {"effort": "none"}


async def test_stream_turn_strips_reasoning_on_unsupported_400() -> None:
    """账号/模型不支持 reasoning 参数时(400 Unsupported parameter),剥参重试
    一次而不是让整轮失败——对齐分类器 _achat_reasoning_off 的自愈模式。"""
    seen_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen_bodies.append(body)
        if "reasoning" in body:
            return httpx.Response(
                400,
                json={"error": {"message": "Unsupported parameter: 'reasoning.summary'"}},
            )
        return httpx.Response(
            200, text=_sse("ok"), headers={"content-type": "text/event-stream"}
        )

    result = await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
    )
    assert len(seen_bodies) == 2
    assert "reasoning" in seen_bodies[0] and "reasoning" not in seen_bodies[1]
    assert result.content == "ok"


async def test_stream_turn_ordinary_400_still_raises() -> None:
    """与 reasoning 无关的 400 仍旧立即上抛,不触发剥参重试(也不走任何退避)。"""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad request")

    with pytest.raises(httpx.HTTPStatusError):
        await _llm(handler).stream_turn(
            [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
        )
    assert calls["n"] == 1


async def test_stream_turn_reconnects_up_to_five_times(monkeypatch) -> None:
    """流断开重连次数对齐官方 codex-rs DEFAULT_STREAM_MAX_RETRIES=5:
    连续 5 次 incomplete chunked read 后第 6 次尝试成功,整轮不失败。"""
    import src.amphi_service.protocol.llms._streaming as streaming_module

    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"event: response.created\n"
            raise httpx.RemoteProtocolError(
                "peer closed connection without sending complete message body "
                "(incomplete chunked read)"
            )

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= 5:
            return httpx.Response(
                200, stream=BrokenBody(), headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(
            200, text=_sse("finally"), headers={"content-type": "text/event-stream"}
        )

    result = await _llm(handler).stream_turn(
        [Message.from_text("hi", role=Role.USER)], None, publish=lambda ch, **kw: None
    )
    assert calls["n"] == 6
    assert result.content == "finally"


def test_probe_paths_do_not_request_reasoning() -> None:
    """chat/achat 探活路径不注入 reasoning——只有 agent 主路径需要保活。"""
    body = _llm()._build_parameters([Message.from_text("hi", role=Role.USER)])
    assert "reasoning" not in body
