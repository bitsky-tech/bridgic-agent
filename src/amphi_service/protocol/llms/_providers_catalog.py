"""Built-in provider presets exposed to clients and LLM routing code."""

from typing import Dict, List

PROVIDER_CATALOG: List[dict] = [
    {
        "id": "openai",
        "display_name": "OpenAI",
        "protocol": "openai",
        "default_base_url": "https://api.openai.com/v1",
        # OAuth here = ChatGPT subscription (Codex). Choosing it switches the
        # channel to protocol 'openai-codex' + the Codex endpoint at activation
        # time; API Key stays on the standard OpenAI protocol/endpoint.
        # Default to oauth — the subscription mode is the recommended path (matches
        # the "Recommended" badge); API Key is the manual fallback.
        "auth_modes": ["oauth", "api_key"],
        "default_auth_mode": "oauth",
        "models": [
            {"id": "gpt-5.5", "vision": True},
            {"id": "gpt-5.4-mini", "vision": True},
            {"id": "gpt-5.4-nano", "vision": True},
        ],
    },
    {
        "id": "anthropic",
        "display_name": "Anthropic",
        "protocol": "anthropic",
        "default_base_url": "https://api.anthropic.com",
        "auth_modes": ["oauth", "api_key"],
        "default_auth_mode": "oauth",
        "models": [
            {"id": "claude-opus-4-8", "vision": True},
            {"id": "claude-sonnet-4-6", "vision": True},
            {"id": "claude-haiku-4-5", "vision": True},
        ],
    },
    {
        "id": "deepseek",
        "display_name": "DeepSeek",
        "protocol": "openai",
        "default_base_url": "https://api.deepseek.com",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "models": [
            {"id": "deepseek-v4-pro", "vision": False},
            {"id": "deepseek-v4-flash", "vision": False},
        ],
    },
    {
        "id": "kimi",
        "display_name": "Kimi Code",
        "protocol": "openai",
        "default_base_url": "https://api.kimi.com/coding/v1",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "models": [
            {"id": "kimi-for-coding", "vision": True},
            {"id": "k3", "vision": True},
            {"id": "kimi-for-coding-highspeed", "vision": True},
        ],
    },
    {
        "id": "google",
        "display_name": "Google",
        # Native Gemini path (google-genai SDK), NOT the OpenAI-compat shim —
        # required so function-calling thought_signatures round-trip (the compat
        # endpoint drops them → 400). default_base_url mirrors the SDK's own
        # default request endpoint (display only; empty also works).
        "protocol": "google",
        "default_base_url": "https://generativelanguage.googleapis.com/",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "models": [
            {"id": "gemini-2.5-pro", "vision": True},
            {"id": "gemini-2.5-flash", "vision": True},
            {"id": "gemini-2.5-flash-lite", "vision": True},
        ],
    },
    {
        "id": "glm",
        "display_name": "GLM (Zhipu)",
        "protocol": "openai",
        "default_base_url": "https://open.bigmodel.cn/api/paas/v4/",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        "models": [
            {"id": "glm-4.6", "vision": False},
            {"id": "glm-4.5-air", "vision": False},
            {"id": "glm-4.6v", "vision": True},
        ],
    },
    {
        "id": "openrouter",
        "display_name": "OpenRouter",
        "protocol": "openai",
        "default_base_url": "https://openrouter.ai/api/v1",
        "auth_modes": ["api_key"],
        "default_auth_mode": "api_key",
        # Prefer the free models (``:free``, all of which support function calling) to
        # cut spend; the free tier has upstream rate limits, and the adapter already
        # backs off and retries on 429. Switch to a paid model when more capability is
        # needed.
        "models": [
            {"id": "openai/gpt-oss-120b:free", "vision": False},
            {"id": "qwen/qwen3-coder:free", "vision": False},
            {"id": "meta-llama/llama-3.3-70b-instruct:free", "vision": False},
        ],
    },
]

# Quick lookup by id — retained for any consumer that wants O(1) catalog
# membership check (handlers no longer use it for validation, but it
# stays exported so external clients querying the wire shape can reuse it).
PROVIDER_CATALOG_BY_ID: Dict[str, dict] = {
    entry["id"]: entry for entry in PROVIDER_CATALOG
}

# Vendors hidden from ``GET /providers``. The entry stays in the catalog above
# so in-process prefill lookups (PROVIDER_CATALOG_BY_ID), protocol dispatch,
# and already-saved user channels keep resolving — only the wire loses it.
#
# Scope: every API client reads GET /providers, so the vendor disappears from
# all of them. What stays reachable is the Anthropic *protocol*: the GUI's
# custom-protocol → the "Anthropic compatible" card, and any
# saved channel using it.
HIDDEN_PROVIDER_IDS: frozenset = frozenset({"anthropic"})


def visible_catalog() -> List[dict]:
    """The catalog as served on the wire, minus ``HIDDEN_PROVIDER_IDS``."""
    return [e for e in PROVIDER_CATALOG if e["id"] not in HIDDEN_PROVIDER_IDS]


__all__ = [
    "PROVIDER_CATALOG",
    "PROVIDER_CATALOG_BY_ID",
    "HIDDEN_PROVIDER_IDS",
    "visible_catalog",
]
