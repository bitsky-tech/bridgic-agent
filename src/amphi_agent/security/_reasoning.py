"""Decide, per provider, how to switch reasoning / chain of thought off on a single
``achat`` call (to speed the reviewer up).

The classifier reuses the main / approval model; if that model is a reasoning model
and goes through non-streaming ``achat``, one safety judgement runs a very long chain
of thought before emitting JSON, exhausting the timeout and degrading into "safety
check unavailable, falling back to manual confirmation". This module reads only the
**public attributes** of the llm handle (``protocol`` / ``configuration.model`` /
``api_base``) and maps them, per vendor, to the call parameters that turn reasoning
off (a top-level kwarg or ``extra_body``) for the classifier to spread into ``achat``.
It imports no provider class, keeping the layering intact.

Reasoning models that cannot be switched off return empty kwargs plus
``status="cannot"``, which the classifier records in a log line (invisible to the
user); the real fix is giving the reviewer a fast non-reasoning approval model.

The mapping is based on a 2026-07 survey of the official docs (per-branch sources in
the comments). Two traps:
  * **"Fake off"**: OpenRouter ``reasoning.exclude`` / Groq ``reasoning_format:hidden``
    only *hide* the chain of thought without saving generation time — always use the
    parameters that genuinely skip the thinking phase.
  * **The cannot-be-disabled class** (reasoning-only): deepseek-reasoner / o1-mini /
    GLM-Z1 / Gemini-2.5-pro — the only option is switching models. Anthropic
    Fable 5 / Mythos 5 (and Opus 5, where "disabled" leaks ``<thinking>`` into the
    answer) can at least be lowered with ``output_config.effort: low``.
  * **base_url wins over the model name**: the same model (e.g. ``qwen3-coder``) is
    disabled differently on DashScope than on OpenRouter, so the actual endpoint domain
    is authoritative.
Unknown vendors conservatively get nothing injected (so a wrong parameter does not
turn a timeout degradation into a 400 degradation).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

# status semantics:
#   disabled   — parameters injected, chain of thought off
#   minimized  — can only be lowered to its floor (still some reasoning, e.g. OpenAI o-series low
#                / gpt-5 minimal)
#   not_needed — the model is not a reasoning model to begin with, nothing to inject
#   cannot     — it is a reasoning model but cannot be turned off (switch models; the classifier
#                logs this)
#   unknown    — unrecognised vendor, conservatively inject nothing
_DISABLED = "disabled"
_MINIMIZED = "minimized"
_NOT_NEEDED = "not_needed"
_CANNOT = "cannot"
_UNKNOWN = "unknown"


@dataclass(frozen=True)
class ReasoningOff:
    """A decision to disable reasoning: ``kwargs`` is spread into ``achat``; ``status``
    tells the classifier whether to log."""

    kwargs: Dict[str, Any] = field(default_factory=dict)
    status: str = _UNKNOWN


def _thinking_disabled() -> ReasoningOff:
    """The ``thinking:{type:disabled}`` shape shared by Zhipu / Kimi / Doubao /
    DeepSeek-V4 (OpenAI SDK → extra_body)."""
    return ReasoningOff({"extra_body": {"thinking": {"type": "disabled"}}}, _DISABLED)


def _attr(llm: Any, name: str) -> str:
    v = getattr(llm, name, "") or ""
    return v if isinstance(v, str) else ""


def _model_of(llm: Any) -> str:
    cfg = getattr(llm, "configuration", None)
    m = getattr(cfg, "model", None) if cfg is not None else None
    return (m if isinstance(m, str) else _attr(llm, "model")).lower()


# ``claude-<family>-5`` with nothing numeric right after the 5 (so ``claude-sonnet-4-5`` is 4.x).
_CLAUDE_5 = re.compile(r"claude-([a-z]+)-5(?!\d)")


def _claude_5_family(model: str) -> Optional[str]:
    """``"sonnet"`` / ``"opus"`` / ``"fable"`` … for a Claude 5-series id, else None.
    Fable / Mythos are matched by name alone (``claude-mythos-preview`` has no ``-5``)."""
    if "fable" in model or "mythos" in model:
        return "fable"
    match = _CLAUDE_5.search(model)
    return match.group(1) if match else None


def reasoning_off(llm: Any) -> ReasoningOff:
    """Decide the disable-reasoning parameters for a single call from the llm's vendor
    (reads public attributes only, imports no provider class)."""
    protocol = _attr(llm, "protocol").lower()
    model = _model_of(llm)
    base = (_attr(llm, "api_base") or _attr(llm, "base_url")).lower()

    # Anthropic: up to the 4.x generations extended thinking is opt-in, so a plain Messages call
    # carries no chain of thought — nothing to inject. The 5 series (Sonnet 5 / Opus 5 / Fable 5 /
    # Mythos 5) thinks adaptively BY DEFAULT: Sonnet 5 accepts ``thinking:{type:disabled}`` and
    # genuinely skips the phase; Opus 5 accepts it too but then leaks ``<thinking>`` tags into the
    # visible answer (breaks the JSON verdict) — Anthropic's guidance is low effort instead; Fable
    # 5 / Mythos 5 cannot disable at all (400) and only take ``output_config.effort``. A relay
    # alias that hides the family gets nothing (the classifier's strip-and-retry covers a guess).
    # Source: platform.claude.com/docs/en/build-with-claude/extended-thinking ;
    #         platform.claude.com/docs/en/about-claude/models/migrating (Opus 5 disabled-thinking)
    if protocol == "anthropic":
        family = _claude_5_family(model)
        if family is None:
            return ReasoningOff({}, _NOT_NEEDED if "claude" in model else _UNKNOWN)
        if family == "sonnet":
            return ReasoningOff({"extra_body": {"thinking": {"type": "disabled"}}}, _DISABLED)
        return ReasoningOff({"extra_body": {"output_config": {"effort": "low"}}}, _MINIMIZED)

    # Google Gemini: thinking goes through the SDK config (not a chat-completions parameter) and
    # is handled by the google adapter layer; 2.5-pro cannot turn it off.
    # Source: ai.google.dev/gemini-api/docs/thinking
    if protocol == "google":
        if "2.5-pro" in model or model.endswith("-pro"):
            return ReasoningOff({}, _CANNOT)
        return ReasoningOff({}, _NOT_NEEDED)

    # ── Below is the OpenAI Chat-Completions line: the base_url domain wins (authoritative), with
    # the model name as a fallback ──

    if "bigmodel.cn" in base or "z.ai" in base:
        return _glm(model)
    if "deepseek.com" in base:
        return _deepseek(model)
    if "dashscope" in base:
        return _qwen()
    if "api.kimi.com" in base:
        return _kimi_code()
    if "moonshot" in base:
        return _kimi(model)
    if "volces.com" in base:
        return _doubao(model)
    if "openrouter.ai" in base:
        # OpenRouter uniformly accepts reasoning.effort:none (effective on models that can turn it
        # off). Models that force reasoning (gpt-oss / o-series / R1 / QwQ …, an open-ended set)
        # return 400 "Reasoning is mandatory", which is covered by the parameter-stripping
        # self-heal retry in the classifier's achat (see _classifier._achat_reasoning_off) — hence
        # no model list is hardcoded here.
        # Source: openrouter.ai/docs/guides/best-practices/reasoning-tokens
        return ReasoningOff({"extra_body": {"reasoning": {"effort": "none"}}}, _DISABLED)
    if "api.openai.com" in base or protocol == "openai-codex":
        return _openai(model)

    # base is ambiguous (self-hosted proxy / niche endpoint) → fall back to the model prefix
    if model.startswith("glm"):
        return _glm(model)
    if model.startswith("deepseek"):
        return _deepseek(model)
    if model.startswith("qwen"):
        return _qwen()
    if model.startswith("kimi"):
        return _kimi(model)
    if model.startswith("doubao"):
        return _doubao(model)
    if model.startswith(("gpt-5", "o1", "o3", "o4")):
        return _openai(model)

    return ReasoningOff({}, _UNKNOWN)


def _glm(model: str) -> ReasoningOff:
    # GLM-4.5/4.6 hybrid can turn it off; GLM-Z1 is reasoning-only and cannot. Source: docs.z.ai/guides/llm/glm-4.6
    if "z1" in model:
        return ReasoningOff({}, _CANNOT)
    return _thinking_disabled()


def _deepseek(model: str) -> ReasoningOff:
    # reasoner has no switch (use deepseek-chat instead); the V4 line uses thinking:disabled; chat
    # is not a reasoning model to begin with.
    # Source: api-docs.deepseek.com/guides/thinking_mode
    if "reasoner" in model:
        return ReasoningOff({}, _CANNOT)
    if "v4" in model:
        return _thinking_disabled()
    return ReasoningOff({}, _NOT_NEEDED)


def _qwen() -> ReasoningOff:
    # DashScope-compatible endpoint: enable_thinking=False (required for non-streaming).
    # Source: alibabacloud.com/help/en/model-studio/deep-thinking
    return ReasoningOff({"extra_body": {"enable_thinking": False}}, _DISABLED)


def _kimi(model: str) -> ReasoningOff:
    # k2.5/k2.6 can turn it off; the dedicated thinking models cannot. Source: platform.kimi.ai
    if "thinking" in model:
        return ReasoningOff({}, _CANNOT)
    return _thinking_disabled()


def _kimi_code() -> ReasoningOff:
    # Kimi Code accepts turning thinking off, but K3/K2.7 route to K2.6; this only speeds up the reviewer.
    return _thinking_disabled()


def _doubao(model: str) -> ReasoningOff:
    # Seed-1.6 can turn it off; the dedicated thinking variant cannot. Source: volcengine.com/docs/82379/1449737
    if "thinking" in model:
        return ReasoningOff({}, _CANNOT)
    return _thinking_disabled()


# ``gpt-5.<n>`` — every point release from 5.1 on; plain ``gpt-5`` / ``gpt-5-mini`` don't match.
_GPT5_POINT_RELEASE = re.compile(r"^gpt-5\.\d")


def _openai(model: str) -> ReasoningOff:
    # Top-level reasoning_effort. gpt-5.1 and every later point release (5.2 / 5.4 / 5.5 / 5.6 …)
    # → none (fully off; "minimal" was removed with 5.1 and 400s "does not support 'minimal'");
    # gpt-5 / gpt-5-mini / gpt-5-nano → minimal (their floor, "none" is rejected); o-series → low
    # (its floor, cannot be disabled); o1-mini ignores the parameter. The ``*-chat*`` aliases are
    # non-reasoning (or pinned to one effort) — nothing to inject.
    # Source: learn.microsoft.com/.../openai/how-to/reasoning ; models.dev providers/openai
    # (reasoning_options per model) ; verified live 2026-08-19 through a new-api relay.
    if "chat" in model:
        return ReasoningOff({}, _NOT_NEEDED)
    if model.startswith("o1-mini"):
        return ReasoningOff({}, _CANNOT)
    if model.startswith(("o1", "o3", "o4")):
        return ReasoningOff({"reasoning_effort": "low"}, _MINIMIZED)
    if _GPT5_POINT_RELEASE.match(model):
        return ReasoningOff({"reasoning_effort": "none"}, _DISABLED)
    if model.startswith("gpt-5"):
        return ReasoningOff({"reasoning_effort": "minimal"}, _MINIMIZED)
    return ReasoningOff({}, _UNKNOWN)
