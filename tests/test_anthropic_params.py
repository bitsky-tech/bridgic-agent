"""Anthropic sampling-param self-heal (mirrors ``test_openai_params.py``).

Newer Anthropic models (Opus 4.7+, Sonnet 5, Fable 5, ...) reject
``temperature`` / ``top_p`` / ``top_k`` with a 400
``"`temperature` is deprecated for this model."``. The adapter detects that
error, strips the named param, caches the rejection, and retries.
"""
from types import SimpleNamespace

from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms.anthropic_llm import (
    AnthropicConfiguration,
    AnthropicLlm,
    _REJECTED_PARAMS,
    _deprecated_param_of,
)


class _DeprecatedExc(Exception):
    """Anthropic 400 for a removed sampling param, in the SDK's error shape."""

    def __init__(self, param: str) -> None:
        msg = f"`{param}` is deprecated for this model. (request id: abc)"
        super().__init__(f"Error code: 400 - {{'error': {{'message': '{msg}'}}}}")
        self.message = msg
        self.body = {"error": {"type": "<nil>", "message": msg}}


def _llm(model: str = "claude-opus-4-8", temperature: float = 0.7) -> AnthropicLlm:
    return AnthropicLlm(
        api_key="k",
        configuration=AnthropicConfiguration(model=model, temperature=temperature),
    )


def _text_message(text: str = "ok"):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


# --- pure helper -----------------------------------------------------------

def test_deprecated_param_of_recognizes_message() -> None:
    assert _deprecated_param_of(_DeprecatedExc("temperature")) == "temperature"
    assert _deprecated_param_of(_DeprecatedExc("top_p")) == "top_p"
    # matches on str(exc) alone (proxy-mangled error with no .message/.body)
    assert _deprecated_param_of(
        ValueError("`top_k` is deprecated for this model.")
    ) == "top_k"


def test_deprecated_param_of_ignores_unrelated() -> None:
    assert _deprecated_param_of(ValueError("overloaded")) is None
    assert _deprecated_param_of(ValueError("temperature must be <= 1")) is None


# --- achat self-heal (the probe path) --------------------------------------

async def test_achat_self_heals_and_caches() -> None:
    _REJECTED_PARAMS.clear()
    calls: list = []

    async def create(**params):
        calls.append(dict(params))
        if "temperature" in params:
            raise _DeprecatedExc("temperature")
        return _text_message("pong")

    llm = _llm()
    llm.async_client = SimpleNamespace(messages=SimpleNamespace(create=create))

    out = await llm.achat([Message.from_text("ping", role=Role.USER)])

    assert out == "pong"
    assert len(calls) == 2, "首次带 temperature 失败,剥除后重试成功"
    assert "temperature" not in calls[1], "重试时 temperature 应已被剥除"
    assert "temperature" in _REJECTED_PARAMS.get(llm._reject_key(), set())
    _REJECTED_PARAMS.clear()


# --- learned pre-strip via _build_parameters (covers every path) -----------

def test_build_parameters_pre_strips_cached_param() -> None:
    _REJECTED_PARAMS.clear()
    llm = _llm()
    _REJECTED_PARAMS[llm._reject_key()] = {"temperature"}

    params = llm._build_parameters([Message.from_text("hi", role=Role.USER)])

    assert "temperature" not in params, "缓存命中时 _build_parameters 应预剥"
    assert params["model"] == "claude-opus-4-8"
    _REJECTED_PARAMS.clear()


def test_build_parameters_keeps_temp_when_not_rejected() -> None:
    _REJECTED_PARAMS.clear()
    llm = _llm(temperature=0.0)
    params = llm._build_parameters([Message.from_text("hi", role=Role.USER)])
    assert params["temperature"] == 0.0, "未被拒绝的模型仍应发送 temperature"
    _REJECTED_PARAMS.clear()


# --- stream_turn self-heal loop --------------------------------------------

async def test_stream_turn_self_heals_and_caches() -> None:
    _REJECTED_PARAMS.clear()
    from src.amphi_service.protocol.llms._streaming import StreamResult

    seen: list = []

    async def fake_run_stream(params, publish):
        seen.append(dict(params))
        if "temperature" in params:
            raise _DeprecatedExc("temperature")
        return StreamResult(tool_calls=[], content="done", usage=None, capture={})

    llm = _llm()
    llm._run_stream = fake_run_stream  # type: ignore[method-assign]

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "done"
    assert len(seen) == 2, "首次开流失败,剥除 temperature 后重试成功"
    assert "temperature" not in seen[1]
    assert "temperature" in _REJECTED_PARAMS.get(llm._reject_key(), set())
    _REJECTED_PARAMS.clear()
