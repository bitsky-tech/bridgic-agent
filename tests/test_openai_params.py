import pytest

from src.amphi_service.protocol.llms._openai_params import (
    is_kimi_code_endpoint, is_openai_endpoint, is_openai_reasoning_model,
    sanitize_openai_params, unsupported_param_of,
)


def test_endpoint_detection() -> None:
    assert is_openai_endpoint(None) and is_openai_endpoint("")
    assert is_openai_endpoint("https://api.openai.com/v1")
    assert not is_openai_endpoint("https://api.deepseek.com")
    assert not is_openai_endpoint("https://open.bigmodel.cn/api/paas/v4/")


def test_kimi_code_endpoint_detection_is_distinct_from_moonshot_platform() -> None:
    assert is_kimi_code_endpoint("https://api.kimi.com/coding/v1")
    assert is_kimi_code_endpoint("https://api.kimi.com/coding/v1/chat/completions")
    assert not is_kimi_code_endpoint("https://api.kimi.com/v1")
    assert not is_kimi_code_endpoint("https://api.moonshot.cn/v1")


def test_reasoning_detection_incl_chat_exception() -> None:
    for m in ["o1", "o3-mini", "o4-mini", "gpt-5.5", "gpt-5.4-mini"]:
        assert is_openai_reasoning_model(m), m
    for m in ["gpt-4o", "gpt-5-chat-latest", "gpt-5.1-chat", "deepseek-v4-pro"]:
        assert not is_openai_reasoning_model(m), m


def test_sanitize_true_openai_reasoning_strips_temp_and_renames_cap() -> None:
    out = sanitize_openai_params(
        {"model": "gpt-5.5", "temperature": 0.0, "top_p": 1, "max_tokens": 1, "messages": []},
        base_url=None)
    assert "temperature" not in out and "top_p" not in out
    assert "max_tokens" not in out and out["max_completion_tokens"] == 1


def test_sanitize_true_openai_standard_keeps_temp_renames_cap() -> None:
    out = sanitize_openai_params(
        {"model": "gpt-4o", "temperature": 0.0, "max_tokens": 8}, base_url="https://api.openai.com/v1")
    assert out["temperature"] == 0.0 and out["max_completion_tokens"] == 8


def test_sanitize_non_openai_untouched() -> None:
    src = {"model": "deepseek-v4-pro", "temperature": 0.0, "max_tokens": 8}
    assert sanitize_openai_params(dict(src), base_url="https://api.deepseek.com") == src


def test_sanitize_reasoning_model_rules_apply_on_any_host() -> None:
    """Official rule: reasoning models reject temperature/top_p/... and only take
    max_completion_tokens — a property of the model, not of the host. A relay
    (LiteLLM, new-api) serving gpt-5-mini gets the same sanitized request."""
    out = sanitize_openai_params(
        {"model": "gpt-5-mini", "temperature": 0.0, "top_p": 1, "max_tokens": 64, "messages": []},
        base_url="http://litellm.local:4000/v1")
    assert "temperature" not in out and "top_p" not in out
    assert "max_tokens" not in out and out["max_completion_tokens"] == 64


def test_sanitize_o_series_on_relay_host() -> None:
    out = sanitize_openai_params(
        {"model": "o4-mini", "temperature": 0.0, "presence_penalty": 0.5, "max_tokens": 8},
        base_url="http://136.116.56.93:3000/v1")
    assert "temperature" not in out and "presence_penalty" not in out
    assert out["max_completion_tokens"] == 8 and "max_tokens" not in out


def test_sanitize_chat_alias_on_relay_host_untouched() -> None:
    src = {"model": "gpt-5-chat-latest", "temperature": 0.0, "max_tokens": 8}
    assert sanitize_openai_params(dict(src), base_url="http://litellm.local:4000/v1") == src


def test_sanitize_non_reasoning_openai_model_on_relay_host_untouched() -> None:
    src = {"model": "gpt-4o", "temperature": 0.0, "max_tokens": 8}
    assert sanitize_openai_params(dict(src), base_url="http://litellm.local:4000/v1") == src


def test_sanitize_kimi_code_forces_supported_temperature() -> None:
    src = {"model": "k3", "temperature": 0.0, "max_tokens": 8}
    out = sanitize_openai_params(src, base_url="https://api.kimi.com/coding/v1")
    assert out == {"model": "k3", "temperature": 1, "max_tokens": 8}
    assert src["temperature"] == 0.0


def test_sanitize_kimi_code_preserves_omitted_temperature() -> None:
    src = {"model": "kimi-for-coding", "max_tokens": 8}
    assert sanitize_openai_params(src, base_url="https://api.kimi.com/coding/v1") == src


def test_unsupported_param_of() -> None:
    class E(Exception):
        code = "unsupported_parameter"; param = "temperature"; body = None
    assert unsupported_param_of(E()) == "temperature"
    class E2(Exception):
        code = None; param = None
        body = {"error": {"code": "unsupported_parameter", "param": "max_tokens"}}
    assert unsupported_param_of(E2()) == "max_tokens"
    assert unsupported_param_of(ValueError("x")) is None


# --- 适配器级别测试:验证 OpenAICompatLlm._build_parameters 调用清洗器 ---

def test_openai_compat_llm_build_parameters_sanitizes_reasoning() -> None:
    from bridgic.core.model.types import Message, Role
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    # true OpenAI endpoint(api_base=None) + 推理模型
    llm = OpenAICompatLlm(api_key="k", configuration=OpenAIConfiguration(model="gpt-5.5", temperature=0.0))
    params = llm._build_parameters(messages=[Message.from_text("hi", role=Role.USER)])
    assert "temperature" not in params          # 推理模型应被剥除
    assert "max_tokens" not in params           # 本就未设置;确认不被注入
    assert params["model"] == "gpt-5.5"


def test_openai_compat_llm_build_parameters_non_openai_keeps_temp() -> None:
    from bridgic.core.model.types import Message, Role
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    # 非 OpenAI 端点:参数应原样透传
    llm = OpenAICompatLlm(api_key="k", api_base="https://api.deepseek.com",
                          configuration=OpenAIConfiguration(model="deepseek-v4-pro", temperature=0.0))
    params = llm._build_parameters(messages=[Message.from_text("hi", role=Role.USER)])
    assert params.get("temperature") == 0.0     # 非 OpenAI 端点:temperature 保留


# ---------------------------------------------------------------------------
# Task 4 — _create_stream 自愈重试 + 进程级缓存
# ---------------------------------------------------------------------------
# 注意:用 gpt-4o(非推理模型)测试 temperature 自愈,因为静态清洗器对推理模型会
# 在 _build_parameters 里提前剥除 temperature,导致它根本不会到达 _create_stream,
# 无法触发 API 拒绝。gpt-4o 不是推理模型,temperature 会通过静态清洗到达 create,
# 这样假 client 才能拒绝它,自愈逻辑才能被真正测到。

class _FakeExc(Exception):
    """最小化异常:只需带 .code / .param 属性即可被 unsupported_param_of 识别。"""
    def __init__(self, code: str, param: str) -> None:
        super().__init__(f"{code}: {param}")
        self.code = code
        self.param = param
        self.body = None


# 复用 test_thinking_passback.py 里的流块结构(避免重复定义)
class _Delta:
    def __init__(self, *, content=None) -> None:
        self.content = content
        self.reasoning_content = None
        self.tool_calls = []


class _Choice:
    def __init__(self, delta) -> None:
        self.delta = delta


class _Chunk:
    def __init__(self, *, delta=None) -> None:
        self.choices = [_Choice(delta)] if delta is not None else []
        self.usage = None


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


def _ok_stream():
    return _AsyncIter([_Chunk(delta=_Delta(content="ok"))])


class _FakeBadThenOk:
    """首次带 temperature 时抛 unsupported_parameter,第二次(无 temperature)返回流。"""
    def __init__(self) -> None:
        self.calls: list = []

    async def create(self, **params):
        self.calls.append(dict(params))
        if "temperature" in params:
            raise _FakeExc("unsupported_parameter", "temperature")
        return _ok_stream()


def _fake_client(create_coro):
    """把一个 async create 函数包成 async_client 形状。"""
    class _CC:
        create = staticmethod(create_coro)
    class _C:
        completions = _CC()
    class _AC:
        chat = _C()
    return _AC()


async def test_self_heal_retries_and_updates_cache() -> None:
    """首次 400 unsupported_parameter(temperature) → 自动剥除重试 → 成功;
    且进程缓存里记录了被拒绝的参数。"""
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()

    fake = _FakeBadThenOk()
    llm = OpenAICompatLlm(
        api_key="k",
        configuration=OpenAIConfiguration(model="gpt-4o", temperature=0.7),
    )
    llm.async_client = _fake_client(fake.create)

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "ok"
    assert len(fake.calls) == 2, "应恰好调用两次(首次失败,重试成功)"
    assert "temperature" not in fake.calls[1], "重试时 temperature 应已被剥除"
    key = llm._reject_key()
    assert "temperature" in _REJECTED_PARAMS.get(key, set()), "缓存应记录被拒绝的参数"

    _REJECTED_PARAMS.clear()


async def test_pre_strip_from_cache() -> None:
    """进程缓存已有 temperature → 第二次 stream_turn 的首次 create 就不带 temperature。"""
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()

    llm = OpenAICompatLlm(
        api_key="k",
        configuration=OpenAIConfiguration(model="gpt-4o", temperature=0.7),
    )
    key = llm._reject_key()
    _REJECTED_PARAMS[key] = {"temperature"}  # 预注入缓存

    calls: list = []

    async def create(**params):
        calls.append(dict(params))
        return _ok_stream()

    llm.async_client = _fake_client(create)
    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "ok"
    assert len(calls) == 1, "有缓存时应只调用一次"
    assert "temperature" not in calls[0], "缓存预剥:首次 create 就不应带 temperature"

    _REJECTED_PARAMS.clear()


async def test_non_matching_error_propagates() -> None:
    """非 unsupported_parameter 错误应立即向上抛出,不进行重试。"""
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()

    call_count = 0

    async def create(**params):
        nonlocal call_count
        call_count += 1
        raise ValueError("network error")

    llm = OpenAICompatLlm(api_key="k", configuration=OpenAIConfiguration(model="gpt-4o"))
    llm.async_client = _fake_client(create)

    with pytest.raises(ValueError, match="network error"):
        await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert call_count == 1, "非匹配错误不应重试"

    _REJECTED_PARAMS.clear()


async def test_kimi_access_error_fails_fast_with_subscription_guidance(monkeypatch) -> None:
    """K3 entitlement failures are permanent and must never enter backoff."""
    from bridgic.llms.openai import OpenAIConfiguration
    import src.amphi_service.protocol.llms.openai_llm as openai_llm_module
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    class KimiAccessError(Exception):
        status_code = 401

    async def create(**params):
        raise KimiAccessError(
            "Your current subscription does not have access to k3. "
            "Upgrade to an Moderato plan or above."
        )

    async def sleep_must_not_run(_delay: float) -> None:
        raise AssertionError("permanent Kimi access failures must not retry")

    monkeypatch.setattr(openai_llm_module.asyncio, "sleep", sleep_must_not_run)
    llm = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.kimi.com/coding/v1",
        configuration=OpenAIConfiguration(model="k3"),
    )
    llm.async_client = _fake_client(create)

    with pytest.raises(RuntimeError, match="API Key.*Moderato.*权益同步"):
        await llm.stream_turn([], None, publish=lambda *a, **k: None)


def test_kimi_access_guidance_uses_the_active_service_locale() -> None:
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.i18n import use_locale
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    llm = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.kimi.com/coding/v1",
        configuration=OpenAIConfiguration(model="k3"),
    )

    with use_locale("en"):
        assert llm._kimi_access_error(Exception("does not have access to k3")) == (
            "Kimi reports that the API key's account does not have access to k3. "
            "If the account is already on Moderato, create a new API key in the Kimi Code "
            "console for the same account; if it still does not work, contact Kimi to check "
            "whether the subscription benefits have synced."
        )

        assert llm._kimi_access_error(
            Exception("does not have access to kimi-for-coding-highspeed")
        ) == (
            "The current Kimi Code subscription cannot use kimi-for-coding-highspeed. "
            "Use kimi-for-coding instead, or upgrade to Allegretto or above."
        )


async def test_kimi_rate_limit_uses_short_visible_backoff(monkeypatch) -> None:
    """Kimi retries are app-owned and capped at a short interval."""
    from bridgic.llms.openai import OpenAIConfiguration
    import src.amphi_service.protocol.llms.openai_llm as openai_llm_module
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    class KimiOverloadedError(Exception):
        status_code = 429

    calls = 0
    delays = []

    async def create(**params):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise KimiOverloadedError("The engine is currently overloaded")
        return _ok_stream()

    async def record_sleep(delay: float) -> None:
        delays.append(delay)

    monkeypatch.setattr(openai_llm_module.asyncio, "sleep", record_sleep)
    llm = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.kimi.com/coding/v1",
        configuration=OpenAIConfiguration(model="kimi-for-coding"),
    )
    llm.async_client = _fake_client(create)

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "ok"
    assert delays == [1.0, 2.0]


def test_kimi_disables_hidden_openai_sdk_retries() -> None:
    """Only the visible bounded retry loop should retry Kimi requests."""
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    kimi = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.kimi.com/coding/v1",
        configuration=OpenAIConfiguration(model="kimi-for-coding"),
    )
    deepseek = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.deepseek.com",
        configuration=OpenAIConfiguration(model="deepseek-chat"),
    )

    kimi_client = kimi._stream_client()
    assert kimi_client.max_retries == 0
    assert kimi_client.timeout.read == 30.0
    assert deepseek._stream_client() is deepseek.async_client


async def test_kimi_stream_open_timeout_is_bounded(monkeypatch) -> None:
    """A silent Kimi handshake becomes a visible bounded transport retry."""
    import asyncio
    from bridgic.llms.openai import OpenAIConfiguration
    import src.amphi_service.protocol.llms._streaming as streaming_module
    import src.amphi_service.protocol.llms.openai_llm as openai_llm_module
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    calls = 0
    events = []

    async def create(**params):
        nonlocal calls
        calls += 1
        await asyncio.Event().wait()

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(openai_llm_module, "_KIMI_STREAM_OPEN_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(streaming_module.asyncio, "sleep", no_sleep)
    llm = OpenAICompatLlm(
        api_key="k",
        api_base="https://api.kimi.com/coding/v1",
        configuration=OpenAIConfiguration(model="k3"),
    )
    llm.async_client = _fake_client(create)

    with pytest.raises(TimeoutError):
        await llm.stream_turn(
            [], None,
            publish=lambda channel, **payload: events.append((channel, payload)),
        )

    assert calls == 3
    assert [payload["attempt"] for channel, payload in events if channel == "model_retry"] == [1, 2]


# ---------------------------------------------------------------------------
# Relay-shaped unsupported-param errors (LiteLLM) + achat self-heal
# ---------------------------------------------------------------------------
# LiteLLM enforces OpenAI's parameter rules itself and raises
# ``litellm.UnsupportedParamsError`` with code "400" and param null — the
# parameter name only lives in the message text. new-api tolerates the same
# params, which is why this never surfaced there.

class _LiteLLMExc(Exception):
    """The shape the openai SDK exposes for a LiteLLM UnsupportedParamsError."""

    status_code = 400

    def __init__(self, message: str) -> None:
        super().__init__(f"Error code: 400 - {{'error': {{'message': {message!r}}}}}")
        self.code = "400"
        self.param = None
        self.body = {"error": {"message": message, "type": "None", "param": None, "code": "400"}}


_LITELLM_GPT5 = (
    "litellm.UnsupportedParamsError: gpt-5 models (including gpt-5-codex) don't support "
    "temperature=0.0. Only temperature=1 is supported. To drop unsupported params set "
    "`litellm.drop_params = True`. Received Model Group=gpt-5-mini\nAvailable Model Group Fallbacks=None"
)
_LITELLM_O_SERIES = (
    "litellm.UnsupportedParamsError: O-series models don't support temperature=0.0. Only "
    "temperature=1 is supported. To drop unsupported openai params from the call, set "
    "`litellm.drop_params = True`"
)


def test_unsupported_param_of_reads_relay_message_text() -> None:
    assert unsupported_param_of(_LiteLLMExc(_LITELLM_GPT5)) == "temperature"
    assert unsupported_param_of(_LiteLLMExc(_LITELLM_O_SERIES)) == "temperature"
    # OpenAI's own wording when the structured code/param fields are missing
    assert unsupported_param_of(
        _LiteLLMExc("Unsupported parameter: 'top_p' is not supported with this model.")
    ) == "top_p"
    # a 400 that names no request parameter is not healable
    assert unsupported_param_of(_LiteLLMExc("Invalid model group")) is None
    # only request parameters are candidates — random words before '=' don't count
    assert unsupported_param_of(_LiteLLMExc("models don't support images=true")) is None


async def test_self_heal_on_relay_unsupported_params_error() -> None:
    """A LiteLLM-shaped 400 naming temperature → stripped, retried, cached."""
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()
    calls: list = []

    async def create(**params):
        calls.append(dict(params))
        if "temperature" in params:
            raise _LiteLLMExc(_LITELLM_GPT5)
        return _ok_stream()

    # a name the static sanitizer cannot classify (a future reasoning model)
    llm = OpenAICompatLlm(
        api_key="k", api_base="http://litellm.local:4000/v1",
        configuration=OpenAIConfiguration(model="gpt-6-reasoner", temperature=0.0),
    )
    llm.async_client = _fake_client(create)

    result = await llm.stream_turn([], None, publish=lambda *a, **k: None)

    assert result.content == "ok"
    assert len(calls) == 2 and "temperature" not in calls[1]
    assert "temperature" in _REJECTED_PARAMS.get(llm._reject_key(), set())
    _REJECTED_PARAMS.clear()


def test_build_parameters_pre_strips_learned_rejections() -> None:
    """What the stream path learned applies to achat/chat too (probe, classifier)."""
    from bridgic.core.model.types import Message, Role
    from bridgic.llms.openai import OpenAIConfiguration
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()
    llm = OpenAICompatLlm(
        api_key="k", api_base="http://litellm.local:4000/v1",
        configuration=OpenAIConfiguration(model="gpt-4o", temperature=0.0),
    )
    _REJECTED_PARAMS[llm._reject_key()] = {"temperature"}

    params = llm._build_parameters(messages=[Message.from_text("hi", role=Role.USER)])

    assert "temperature" not in params
    _REJECTED_PARAMS.clear()


async def test_achat_self_heals_unsupported_param(monkeypatch) -> None:
    """achat (probe / classifier) strips a rejected param and retries once, so a
    brand-new process can talk to gpt-5-mini through LiteLLM without a stream
    having learned the rejection first."""
    from bridgic.core.model import ModelUnrecoverableError
    from bridgic.core.model.types import Message, Role
    from bridgic.llms.openai import OpenAIConfiguration, OpenAILlm
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm, _REJECTED_PARAMS

    _REJECTED_PARAMS.clear()
    attempts: list = []

    async def fake_super_achat(self, messages, **kwargs):
        attempts.append(dict(self._build_parameters(messages=messages, **kwargs)))
        if "temperature" in attempts[-1]:
            raise ModelUnrecoverableError(
                "achat failed", operation="achat", original_exception=_LiteLLMExc(_LITELLM_GPT5),
            )
        return "pong"

    monkeypatch.setattr(OpenAILlm, "achat", fake_super_achat)
    llm = OpenAICompatLlm(
        api_key="k", api_base="http://litellm.local:4000/v1",
        configuration=OpenAIConfiguration(model="gpt-6-reasoner", temperature=0.0),
    )

    out = await llm.achat([Message.from_text("ping", role=Role.USER)])

    assert out == "pong"
    assert len(attempts) == 2 and "temperature" not in attempts[1]
    assert "temperature" in _REJECTED_PARAMS.get(llm._reject_key(), set())
    _REJECTED_PARAMS.clear()
