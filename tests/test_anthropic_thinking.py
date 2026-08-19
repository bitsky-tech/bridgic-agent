"""Anthropic thinking self-heal ladder on the agent's streaming path.

``stream_turn`` asks for ``thinking: {type: adaptive, display: summarized}`` so the
UI gets readable reasoning on Sonnet 5 / Opus 5 / Fable 5 / Opus 4.7+ (whose
default ``display`` is ``omitted`` → empty thinking text). Older models reject
that shape, so on a thinking-related 400 the adapter steps down a ladder —
adaptive without ``display`` → ``enabled`` + ``budget_tokens`` → no thinking at
all — and remembers the tier that worked per (base_url, model). Relays (new-api)
expose arbitrary model names, so this is learned from the endpoint, not guessed
from the id. ``chat`` / ``achat`` (probe + safety classifier) never inject it.
"""
from types import SimpleNamespace

from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_service.protocol.llms.anthropic_llm import (
    _REJECTED_PARAMS,
    _THINKING_TIERS,
    AnthropicConfiguration,
    AnthropicLlm,
    _thinking_rejected,
)

_SUMMARIZED = {"type": "adaptive", "display": "summarized"}
_ADAPTIVE = {"type": "adaptive"}


class _Exc400(Exception):
    """A 400 in the Anthropic SDK's error shape (``status_code`` + ``body``)."""

    status_code = 400

    def __init__(self, msg: str) -> None:
        super().__init__(f"Error code: 400 - {{'error': {{'message': '{msg}'}}}}")
        self.message = msg
        self.body = {"error": {"type": "invalid_request_error", "message": msg}}


_DISPLAY_REJECTED = "thinking.display: Extra inputs are not permitted"
_ADAPTIVE_REJECTED = "thinking.type: Input should be 'enabled' or 'disabled'"
_BUDGET_REJECTED = "thinking.budget_tokens: Extra inputs are not permitted"


def _llm(model: str = "claude-sonnet-5") -> AnthropicLlm:
    return AnthropicLlm(api_key="k", configuration=AnthropicConfiguration(model=model))


def _reset() -> None:
    _REJECTED_PARAMS.clear()
    _THINKING_TIERS.clear()


def _fake_stream(accept):
    """A ``_run_stream`` stand-in: records each attempt's params, raises a 400 via
    ``accept(thinking) -> None | message`` until the endpoint "accepts" the shape."""
    seen: list = []

    async def run(params, publish):
        seen.append(dict(params))
        msg = accept(params.get("thinking"))
        if msg:
            raise _Exc400(msg)
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    return seen, run


# --- pure helper -----------------------------------------------------------

def test_thinking_rejected_recognizes_param_errors() -> None:
    assert _thinking_rejected(_Exc400(_DISPLAY_REJECTED))
    assert _thinking_rejected(_Exc400(_ADAPTIVE_REJECTED))
    assert _thinking_rejected(_Exc400("`budget_tokens` is not supported for this model"))
    # relay-mangled error with no status / body — text alone must suffice
    assert _thinking_rejected(ValueError("thinking: adaptive is not supported"))
    # real texts seen through new-api, which masks every path segment but the last
    # (``thinking.type.enabled`` → ``***.***.enabled``) — the hint must survive that
    assert _thinking_rejected(_Exc400("adaptive thinking is not supported on this model"))
    assert _thinking_rejected(_Exc400(
        '"***.***.enabled" is not supported for this model. Use "***.***.adaptive" '
        'and "output_config.effort" to control thinking behavior.'))
    assert _thinking_rejected(_Exc400("***.display: Extra inputs are not permitted"))
    assert _thinking_rejected(_Exc400("`max_tokens` must be greater than `***.budget_tokens`."))


def test_thinking_rejected_ignores_unrelated() -> None:
    assert not _thinking_rejected(_Exc400("tools.0.input_schema: Field required"))
    assert not _thinking_rejected(_Exc400("`temperature` is deprecated for this model."))
    # a sampling-param conflict is NOT a tier rejection — thinking itself is fine there
    assert not _thinking_rejected(_Exc400(
        "`temperature` may only be set to 1 when thinking is enabled or in adaptive mode."))
    assert not _thinking_rejected(_Exc400("`top_k` is not allowed when thinking is enabled."))
    # a 5xx that happens to mention thinking is transport, not a param rejection
    overloaded = _Exc400("thinking overloaded")
    overloaded.status_code = 529
    assert not _thinking_rejected(overloaded)


# --- stream_turn ladder ----------------------------------------------------

async def test_stream_turn_requests_summarized_adaptive_thinking_first() -> None:
    _reset()
    seen, run = _fake_stream(lambda _t: None)
    llm = _llm()
    llm._run_stream = run  # type: ignore[method-assign]

    await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert seen[0]["thinking"] == _SUMMARIZED, "default request must ask for adaptive + summarized, or the UI gets no thinking text"
    _reset()


async def test_stream_turn_steps_down_ladder_and_remembers_tier() -> None:
    _reset()

    def accept(thinking):
        if thinking == _SUMMARIZED:
            return _DISPLAY_REJECTED
        if thinking == _ADAPTIVE:
            return _ADAPTIVE_REJECTED
        return None  # enabled + budget accepted (a pre-4.6 model)

    seen, run = _fake_stream(accept)
    llm = _llm("claude-sonnet-4-5")
    llm._run_stream = run  # type: ignore[method-assign]

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "done"
    assert [s["thinking"] for s in seen] == [
        _SUMMARIZED,
        _ADAPTIVE,
        {"type": "enabled", "budget_tokens": 4096},
    ], "steps down the ladder one tier at a time: summarized → adaptive → enabled+budget"
    # the learned tier is reused: the next turn opens directly at enabled+budget
    await llm.stream_turn([], None, publish=lambda *a, **k: None)
    assert len(seen) == 4
    assert seen[3]["thinking"] == {"type": "enabled", "budget_tokens": 4096}
    _reset()


async def test_stream_turn_budget_stays_below_max_tokens() -> None:
    _reset()
    seen, run = _fake_stream(lambda t: None if (t or {}).get("type") == "enabled" else "thinking: no")
    llm = AnthropicLlm(
        api_key="k", configuration=AnthropicConfiguration(model="m", max_tokens=3000)
    )
    llm._run_stream = run  # type: ignore[method-assign]

    await llm.stream_turn([], None, publish=lambda *a, **k: None)

    budget = seen[-1]["thinking"]["budget_tokens"]
    assert 1024 <= budget < 3000, "budget_tokens must be >= 1024 and < max_tokens"
    _reset()


async def test_stream_turn_drops_thinking_when_every_tier_is_rejected() -> None:
    _reset()
    seen, run = _fake_stream(lambda t: "thinking: not supported" if t is not None else None)
    llm = _llm("some-relay-alias")
    llm._run_stream = run  # type: ignore[method-assign]

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "done"
    assert "thinking" not in seen[-1], "after every tier is rejected the final attempt carries no thinking"
    assert len(seen) == 4
    _reset()


async def test_stream_turn_reraises_unrelated_400_without_stepping_down() -> None:
    _reset()
    seen, run = _fake_stream(lambda _t: "tools.0.input_schema: Field required")
    llm = _llm()
    llm._run_stream = run  # type: ignore[method-assign]

    try:
        await llm.stream_turn([], None, publish=lambda *a, **k: None)
    except _Exc400:
        pass
    else:  # pragma: no cover - defensive
        raise AssertionError("a 400 unrelated to thinking must propagate unchanged")
    assert len(seen) == 1, "an unrelated 400 must not trigger a step-down retry"
    _reset()


async def test_stream_turn_does_not_remember_tier_when_request_still_fails() -> None:
    _reset()
    # Every attempt fails with a thinking-flavoured message (e.g. a replay error):
    # the ladder is exhausted, the error propagates, and nothing is learned — the
    # next turn starts at the top again instead of silently losing thinking.
    seen, run = _fake_stream(lambda _t: "messages.3.content.0.thinking: bad block")
    llm = _llm()
    llm._run_stream = run  # type: ignore[method-assign]

    try:
        await llm.stream_turn([], None, publish=lambda *a, **k: None)
    except _Exc400:
        pass
    assert llm._reject_key() not in _THINKING_TIERS
    _reset()


async def test_stream_turn_keeps_caller_supplied_thinking() -> None:
    _reset()
    seen, run = _fake_stream(lambda _t: None)
    llm = _llm()
    llm._run_stream = run  # type: ignore[method-assign]

    await llm.stream_turn(
        [], None, publish=lambda *a, **k: None,
        extra_body={"thinking": {"type": "disabled"}},
    )

    assert seen[0]["thinking"] == {"type": "disabled"}, "a caller-supplied thinking in extra_body wins and is never overwritten by the ladder"
    _reset()


async def test_stream_turn_omits_sampling_params_while_thinking_is_on() -> None:
    """Anthropic rejects temperature/top_p/top_k next to thinking ("`temperature` may
    only be set to 1 when thinking is enabled"), so thinking tiers never carry them."""
    _reset()
    seen, run = _fake_stream(lambda _t: None)
    llm = AnthropicLlm(
        api_key="k",
        configuration=AnthropicConfiguration(model="claude-sonnet-5", temperature=0.7),
    )
    llm._run_stream = run  # type: ignore[method-assign]

    await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert len(seen) == 1, "thinking tiers omit temperature up front — no wasted round trip"
    assert seen[0]["thinking"] == _SUMMARIZED
    assert "temperature" not in seen[0]
    _reset()


async def test_stream_turn_ladder_bottom_restores_sampling_and_self_heals() -> None:
    """Every thinking tier rejected, and the model also rejects ``temperature``: the
    no-thinking attempt carries temperature again, the deprecated-param self-heal
    strips it, and the request finally succeeds (the path seen live on Sonnet 5
    before the sampling rule above existed)."""
    _reset()
    seen: list = []

    async def run(params, publish):
        seen.append(dict(params))
        if params.get("thinking") is not None:
            raise _Exc400("adaptive thinking is not supported on this model")
        if "temperature" in params:
            raise _Exc400("`temperature` is deprecated for this model.")
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    llm = AnthropicLlm(
        api_key="k",
        configuration=AnthropicConfiguration(model="claude-sonnet-5", temperature=0.7),
    )
    llm._run_stream = run  # type: ignore[method-assign]

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "done"
    assert [("thinking" in s, "temperature" in s) for s in seen] == [
        (True, False), (True, False), (True, False),  # tiers 0-2, sampling dropped
        (False, True),                                # no-thinking tier sends temperature
        (False, False),                               # deprecated → stripped → ok
    ]
    assert "temperature" in _REJECTED_PARAMS.get(llm._reject_key(), set())
    _reset()


async def test_stream_turn_skips_budget_tier_when_max_tokens_too_small() -> None:
    """``budget_tokens`` must be ≥1024 AND < max_tokens; with max_tokens 1024 the
    ``enabled`` tier cannot be satisfied, so it degrades to no thinking."""
    _reset()
    seen, run = _fake_stream(lambda t: "adaptive thinking is not supported" if t else None)
    llm = AnthropicLlm(
        api_key="k", configuration=AnthropicConfiguration(model="m", max_tokens=1024)
    )
    llm._run_stream = run  # type: ignore[method-assign]

    await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert all(s.get("thinking", {}).get("type") != "enabled" for s in seen), "must never send a request whose budget_tokens >= max_tokens"
    assert "thinking" not in seen[-1]
    _reset()


# --- achat / chat (probe + classifier) never inject thinking ----------------

async def test_achat_does_not_inject_thinking() -> None:
    _reset()
    calls: list = []

    async def create(**params):
        calls.append(dict(params))
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="pong")])

    llm = _llm()
    llm.async_client = SimpleNamespace(messages=SimpleNamespace(create=create))

    await llm.achat([Message.from_text("ping", role=Role.USER)])

    assert "thinking" not in calls[0], "achat (probe / classifier) never injects thinking"
    _reset()


async def test_achat_forwards_extra_body() -> None:
    """The safety classifier turns reasoning off through ``achat(..., extra_body=…)``;
    the Anthropic adapter must put those keys on the request."""
    _reset()
    calls: list = []

    async def create(**params):
        calls.append(dict(params))
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="pong")])

    llm = _llm()
    llm.async_client = SimpleNamespace(messages=SimpleNamespace(create=create))

    await llm.achat(
        [Message.from_text("ping", role=Role.USER)],
        extra_body={"output_config": {"effort": "low"}},
    )

    assert calls[0]["output_config"] == {"effort": "low"}, "achat must forward extra_body"
    _reset()
