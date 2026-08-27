"""Product-owned routing and authentication policy for catalog providers.

Model names, capabilities, and token limits come from the bundled raw
models.dev snapshot. This module intentionally contains only behavior that a
third-party model directory cannot describe: our wire adapter, OAuth UX,
visibility, endpoint overrides, and the small default model selection shown in
the configuration form.
"""

from typing import Dict, Tuple


PROVIDER_POLICIES: Tuple[dict, ...] = (
    {
        "id": "openai",
        "source_provider_id": "openai",
        "display_name": "OpenAI",
        "protocol": "openai",
        "default_base_url": "https://api.openai.com/v1",
        "auth_modes": ["oauth", "api_key"],
        "default_auth_mode": "oauth",
        "default_model_ids": ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"],
    },
    {
        "id": "anthropic",
        "source_provider_id": "anthropic",
        "display_name": "Anthropic",
        "protocol": "anthropic",
        "default_base_url": "https://api.anthropic.com",
        "auth_modes": ["oauth", "api_key"],
        "default_auth_mode": "oauth",
        "default_model_ids": [
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
        ],
        "hidden": True,
    },
    {
        "id": "deepseek",
        "source_provider_id": "deepseek",
        "display_name": "DeepSeek",
        "protocol": "openai",
        "default_base_url": "https://api.deepseek.com",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "default_model_ids": ["deepseek-v4-pro", "deepseek-v4-flash"],
    },
    {
        "id": "kimi",
        "source_provider_id": "kimi-for-coding",
        "display_name": "Kimi Code",
        "protocol": "openai",
        "default_base_url": "https://api.kimi.com/coding/v1",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "default_model_ids": [
            "kimi-for-coding",
            "k3",
            "kimi-for-coding-highspeed",
        ],
    },
    {
        "id": "google",
        "source_provider_id": "google",
        "display_name": "Google",
        "protocol": "google",
        "default_base_url": "https://generativelanguage.googleapis.com/",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "default_model_ids": [
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
        ],
    },
    {
        "id": "glm",
        "source_provider_id": "zhipuai",
        "display_name": "GLM (Zhipu)",
        "protocol": "openai",
        "default_base_url": "https://open.bigmodel.cn/api/paas/v4/",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "default_model_ids": ["glm-4.6", "glm-4.5-air", "glm-4.6v"],
    },
    {
        "id": "openrouter",
        "source_provider_id": "openrouter",
        "display_name": "OpenRouter",
        "protocol": "openai",
        "default_base_url": "https://openrouter.ai/api/v1",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "default_model_ids": [
            "openai/gpt-oss-120b:free",
            "qwen/qwen3-coder:free",
            "meta-llama/llama-3.3-70b-instruct:free",
        ],
    },
)

PROVIDER_POLICIES_BY_ID: Dict[str, dict] = {
    policy["id"]: policy for policy in PROVIDER_POLICIES
}


__all__ = [
    "PROVIDER_POLICIES",
    "PROVIDER_POLICIES_BY_ID",
]
