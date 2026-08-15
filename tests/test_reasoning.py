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
        ("anthropic", "claude-sonnet-4-5", "", {}, "not_needed"),
        ("openai", "some-random-model", "https://my-proxy.internal/v1", {}, "unknown"),
    ]

    for protocol, model, api_base, kwargs, status in cases:
        result = reasoning_off(_llm(protocol, model, api_base))
        assert result.kwargs == kwargs, model
        assert result.status == status, model
