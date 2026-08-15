"""Shared harness for the live LLM-capability tests.

These tests make **real** provider API calls to prove the three capabilities the
agent depends on, each exercised through the *same production adapter code path*
the agent itself uses — ``<Adapter>.stream_turn(...)`` — so a green test means
the real wire contract holds, not a mock of it:

  1. **多轮思考** — reasoning/thinking captured on one turn is replayed on the
     next turn (via ``StreamResult.capture`` → ``Message.extras``, exactly as
     ``MainThink.turn_messages_block`` does) without the provider 400-ing.
  2. **多轮对话下单次工具调用** — the model emits one tool call; its result is fed
     back as a TOOL message; the model produces a final answer.
  3. **多轮对话下批量工具调用** — the model emits several tool calls in a single
     assistant turn (parallel tool calls); all results are fed back together.

Every provider module is **SKIPPED unless its API-key env var is set**, so the
suite stays hermetic in CI and only runs when a real key is supplied.

Why drive ``stream_turn`` directly: it is the exact method the agent's
``thinking()`` loop calls. Its returned :class:`StreamResult` exposes
``tool_calls`` (what the model asked to call), ``content`` (assistant text) and
``capture`` (the provider-specific reasoning artifact — ``thinking_blocks`` /
``reasoning_content`` / ``thought_signatures`` / ``reasoning_items``). The
``capture`` keys are deliberately the SAME keys ``turn_messages_block`` writes
into ``Message.extras`` for replay, so a faithful round-trip is just
``extras = dict(result.capture)`` — see :func:`ai_turn_from_result`.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest
from bridgic.core.model.types import Message, Role, Tool

from src.amphi_service.protocol.llms._streaming import StreamResult

# ----------------------------------------------------------------------
# A single tool definition that works across every adapter.
#
# It MUST be a bridgic ``Tool`` (flat ``.name`` / ``.description`` /
# ``.parameters``), because that is exactly what the agent's production path
# hands to ``stream_turn``:
#   * OpenAI-compat (DeepSeek/GLM/OpenRouter) → bridgic's own
#     ``_build_parameters`` calls ``_convert_tool_to_json(tool)`` and reads
#     ``tool.name`` — a plain dict raises ``'dict' object has no attribute
#     'name'``.
#   * Anthropic / Google / Codex → our ``convert_tools`` reads
#     ``getattr(tool, "name")`` + ``getattr(tool, "parameters")``, which a
#     ``Tool`` satisfies.
# ``parameters`` is a JSON-schema object; bridgic reads its ``properties`` /
# ``required`` keys.
# ----------------------------------------------------------------------
WEATHER_TOOL = Tool(
    name="get_weather",
    description="Get the current weather for a city. Returns a short text summary.",
    parameters={
        "type": "object",
        "properties": {
            "city": {"type": "string", "description": "City name, e.g. 'Beijing'."}
        },
        "required": ["city"],
    },
)


class Publish:
    """A ``publish(channel, **kw)`` sink that records streamed deltas.

    ``stream_turn`` streams live ``token`` / ``reasoning`` deltas through this
    callable; capturing them lets a test assert *that reasoning streamed* even
    when the provider does not echo a replayable reasoning block.
    """

    def __init__(self) -> None:
        self.tokens: List[str] = []
        self.reasoning: List[str] = []

    def __call__(self, channel: str, **kw: Any) -> None:
        if channel == "token":
            self.tokens.append(kw.get("text", ""))
        elif channel == "reasoning":
            self.reasoning.append(kw.get("text", ""))

    @property
    def reasoning_text(self) -> str:
        return "".join(self.reasoning)

    @property
    def token_text(self) -> str:
        return "".join(self.tokens)


def env_key(*names: str) -> Optional[str]:
    """First non-empty value among ``names`` in the environment, else ``None``.

    Accepting several names lets a provider be keyed by its own conventional
    variable (e.g. ``ANTHROPIC_API_KEY``) or a test-specific override.
    """
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return None


def user(text: str) -> Message:
    return Message.from_text(text, role=Role.USER)


# Transient upstream failures that mean "can't verify the capability right now"
# rather than "the capability is broken" — a live capability test should SKIP on
# these, not red-fail. Common on free tiers (OpenRouter routes to a provider with
# "No backends available" → 503 capacity_error) and on overloaded APIs
# (Anthropic 529 overloaded_error, generic 502/503).
_TRANSIENT_STATUS = {429, 500, 502, 503, 529}
_TRANSIENT_MARKERS = (
    "no backends available",
    "capacity",
    "overloaded",
    "no instances",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "try again",
    "rate-limited",
    "rate limit",
    "temporarily rate",
)


def is_transient_provider_error(exc: BaseException) -> bool:
    """True when ``exc`` is a transient upstream error (capacity/rate-limit),
    not a real capability failure. A 429 here means the adapter already
    exhausted its own backoff retries and the provider is *still* limiting —
    common on free tiers — so the capability can't be verified right now, which
    is a skip, not a fail. Matches on HTTP status AND on provider message text
    (OpenRouter wraps the upstream 429 in a message)."""
    code = getattr(exc, "status_code", None)
    if code is None:
        code = getattr(exc, "code", None)
    if code in _TRANSIENT_STATUS:
        return True
    text = str(exc).lower()
    return any(marker in text for marker in _TRANSIENT_MARKERS)


async def run_turn(
    llm: Any,
    messages: Sequence[Message],
    *,
    tools: Optional[List[Any]] = None,
    extra_body: Optional[Dict[str, Any]] = None,
) -> Tuple[StreamResult, Publish]:
    """Drive one production ``stream_turn`` and return ``(StreamResult, Publish)``.

    A transient upstream error (503 "No backends available", 529 overloaded, …)
    is turned into ``pytest.skip`` — it means the provider can't serve the model
    right now, not that the capability is broken.
    """
    publish = Publish()
    try:
        result = await llm.stream_turn(
            list(messages), tools, publish=publish, extra_body=extra_body
        )
    except Exception as exc:  # noqa: BLE001 — re-raised below unless transient
        if is_transient_provider_error(exc):
            pytest.skip(f"transient provider error (not a capability failure): {exc}")
        raise
    return result, publish


def ai_turn_from_result(result: StreamResult, *, text: Optional[str] = None) -> Tuple[Message, List[str]]:
    """Rebuild the assistant tool-call turn from a :class:`StreamResult`, exactly
    as ``turn_messages_block`` does for the next round.

    Returns the assistant :class:`Message` plus the ordered call-ids used, so the
    caller can pair each ``tool_result`` back by id. The provider's reasoning
    artifact rides back verbatim on ``extras`` (``result.capture`` keys already
    match the ``extras`` keys the adapters read on replay):

    * Anthropic → ``extras["thinking_blocks"]`` (thinking block + signature)
    * Google    → ``extras["thought_signatures"]`` (index-aligned to the calls)
    * Codex     → ``extras["reasoning_items"]`` (encrypted reasoning, ordered)
    * OpenAI-compat (DeepSeek/GLM/OpenRouter) → ``extras["reasoning_content"]``
    """
    calls: List[Dict[str, Any]] = []
    ids: List[str] = []
    for i, call in enumerate(result.tool_calls):
        # Codex issues a real ``call_id`` that its ``function_call_output`` must
        # echo; the other adapters drop the id and pair by a synthetic one.
        cid = call.get("call_id") or f"call_{i}"
        ids.append(cid)
        calls.append({"id": cid, "name": call["name"], "arguments": call.get("arguments") or {}})
    msg = Message.from_tool_call(
        tool_calls=calls,
        text=(text if text is not None else (result.content or None)),
        extras=dict(result.capture or {}),
    )
    return msg, ids


def tool_results(ids: Sequence[str], outputs: Sequence[str]) -> List[Message]:
    """One TOOL message per (id, output) pair — the round's tool results."""
    return [
        Message.from_tool_result(tool_id=cid, content=out)
        for cid, out in zip(ids, outputs)
    ]
