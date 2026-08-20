"""Provider contract for disabling or minimizing classifier reasoning."""

from __future__ import annotations

import types

from src.amphi_agent.security._reasoning import reasoning_off


def _llm(protocol: str, model: str, api_base: str = ""):
    return types.SimpleNamespace(
        protocol=protocol,
        configuration=types.SimpleNamespace(model=model),
        api_base=api_base,
    )


def test_reasoning_off_provider_matrix() -> None:
    cases = [
        (
            "openai",
            "glm-4.6",
            "https://open.bigmodel.cn/api/paas/v4",
            {"extra_body": {"thinking": {"type": "disabled"}}},
            "disabled",
        ),
        ("openai", "glm-z1-air", "https://open.bigmodel.cn/api/paas/v4", {}, "cannot"),
        ("openai", "deepseek-reasoner", "https://api.deepseek.com", {}, "cannot"),
        ("openai", "deepseek-chat", "https://api.deepseek.com", {}, "not_needed"),
        (
            "openai",
            "deepseek-v4-pro",
            "https://api.deepseek.com",
            {"extra_body": {"thinking": {"type": "disabled"}}},
            "disabled",
        ),
        (
            "openai",
            "qwen-plus",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            {"extra_body": {"enable_thinking": False}},
            "disabled",
        ),
        (
            "openai",
            "k3",
            "https://api.kimi.com/coding/v1",
            {"extra_body": {"thinking": {"type": "disabled"}}},
            "disabled",
        ),
        (
            "openai",
            "qwen/qwen3-coder",
            "https://openrouter.ai/api/v1",
            {"extra_body": {"reasoning": {"effort": "none"}}},
            "disabled",
        ),
        (
            "openai",
            "openai/gpt-oss-120b",
            "https://openrouter.ai/api/v1",
            {"extra_body": {"reasoning": {"effort": "none"}}},
            "disabled",
        ),
        ("openai", "gpt-5", "https://api.openai.com/v1", {"reasoning_effort": "minimal"}, "minimized"),
        ("openai", "gpt-5.1", "https://api.openai.com/v1", {"reasoning_effort": "none"}, "disabled"),
        ("openai", "o3-mini", "https://api.openai.com/v1", {"reasoning_effort": "low"}, "minimized"),
        # Through a new-api relay (unknown base) → fall back to the model name. From gpt-5.1 on
        # "minimal" is gone and only "none" is accepted (5.4/5.5 return 400 "does not support
        # 'minimal'" live); gpt-5 / gpt-5-mini are the reverse and accept only "minimal".
        ("openai", "gpt-5.4", "http://my-new-api:3000/v1", {"reasoning_effort": "none"}, "disabled"),
        ("openai", "gpt-5.4-mini", "http://my-new-api:3000/v1", {"reasoning_effort": "none"}, "disabled"),
        ("openai", "gpt-5.5", "http://my-new-api:3000/v1", {"reasoning_effort": "none"}, "disabled"),
        ("openai", "gpt-5.6-sol", "http://my-new-api:3000/v1", {"reasoning_effort": "none"}, "disabled"),
        ("openai", "gpt-5-mini", "http://my-new-api:3000/v1", {"reasoning_effort": "minimal"}, "minimized"),
        ("openai", "o4-mini", "http://my-new-api:3000/v1", {"reasoning_effort": "low"}, "minimized"),
        # *-chat-latest aliases: non-reasoning or a fixed effort — never inject anything
        ("openai", "gpt-5-chat-latest", "http://my-new-api:3000/v1", {}, "not_needed"),
        ("openai", "gpt-5.2-chat-latest", "https://api.openai.com/v1", {}, "not_needed"),
        ("anthropic", "claude-sonnet-4-5", "", {}, "not_needed"),
        ("anthropic", "claude-opus-4-8", "", {}, "not_needed"),
        # The 5 series thinks adaptively by default: Sonnet 5 can genuinely switch it off; Opus 5
        # leaks <thinking> into the answer when disabled (Anthropic recommends low effort instead);
        # Fable / Mythos cannot disable at all and only take a lower effort.
        (
            "anthropic",
            "claude-sonnet-5",
            "https://my-new-api.example/",
            {"extra_body": {"thinking": {"type": "disabled"}}},
            "disabled",
        ),
        (
            "anthropic",
            "claude-opus-5",
            "",
            {"extra_body": {"output_config": {"effort": "low"}}},
            "minimized",
        ),
        (
            "anthropic",
            "claude-fable-5",
            "",
            {"extra_body": {"output_config": {"effort": "low"}}},
            "minimized",
        ),
        (
            "anthropic",
            "claude-mythos-5",
            "",
            {"extra_body": {"output_config": {"effort": "low"}}},
            "minimized",
        ),
        # An unrecognised relay alias → conservatively inject nothing (the classifier's strip-and-retry covers it)
        ("anthropic", "my-relay-alias", "https://my-new-api.example/", {}, "unknown"),
        ("openai", "some-random-model", "https://my-proxy.internal/v1", {}, "unknown"),
    ]

    for protocol, model, api_base, kwargs, status in cases:
        result = reasoning_off(_llm(protocol, model, api_base))
        assert result.kwargs == kwargs, model
        assert result.status == status, model
