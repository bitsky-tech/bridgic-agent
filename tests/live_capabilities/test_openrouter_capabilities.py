"""OpenRouter (OpenAI-compatible router) — live capability proofs.

SKIPPED unless ``OPENROUTER_API_KEY`` is set. Drives the production
:class:`OpenAICompatLlm.stream_turn` path against
``https://openrouter.ai/api/v1``.

OpenRouter is an aggregator: all three capabilities pass through to the
UNDERLYING routed model. Its unified reasoning API returns reasoning in the
``reasoning`` field (which the adapter reads alongside ``reasoning_content``),
enabled with a ``reasoning`` request object. The free tier is heavily
rate-limited upstream; the adapter's 429 backoff absorbs it, so these tests can
be slow.

Default model ``openai/gpt-oss-120b:free`` (a reasoning + tool-calling model);
override with ``OPENROUTER_TEST_MODEL``.
"""

from __future__ import annotations

import os

import pytest
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("OPENROUTER_API_KEY"),
    reason="set OPENROUTER_API_KEY to run the live OpenRouter capability tests",
)

_BASE_URL = "https://openrouter.ai/api/v1"
_MODEL = os.getenv("OPENROUTER_TEST_MODEL", "openai/gpt-oss-120b:free")
_REASONING = {"reasoning": {"effort": "low"}}


def _llm() -> OpenAICompatLlm:
    return OpenAICompatLlm(
        api_key=env_key("OPENROUTER_API_KEY"),
        api_base=_BASE_URL,
        configuration=OpenAIConfiguration(model=_MODEL, temperature=0.0, max_tokens=None),
    )


async def test_single_tool_call_multiturn() -> None:
    llm = _llm()
    asked = [user("What's the weather in Beijing? Use the get_weather tool.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no tool call"
    assert r1.tool_calls[0]["name"] == "get_weather"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_parallel_tool_calls_multiturn() -> None:
    """Multiple ``tool_calls`` in one turn (``parallel_tool_calls`` defaults true
    for most models); passthrough to the underlying model. Serial run skips.
    """
    llm = _llm()
    asked = [user(
        "Get the current weather for BOTH Beijing and Shanghai. "
        "Call get_weather once per city, in parallel."
    )]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no tool call"
    if len(r1.tool_calls) < 2:
        pytest.skip(f"{_MODEL} chose serial calls this run — parallel proof vacuous")

    ai, ids = ai_turn_from_result(r1)
    outs = [f"{c['arguments'].get('city', '?')}: sunny" for c in r1.tool_calls]
    r2, pub = await run_turn(llm, [*asked, ai, *tool_results(ids, outs)], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_multiturn_reasoning_captured() -> None:
    """The unified reasoning API returns reasoning tokens (captured), and a
    tool-call multi-turn loop completes with reasoning enabled.
    """
    llm = _llm()
    asked = [user("Reason about it, then use get_weather to check Beijing's weather.")]

    r1, pub1 = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_REASONING)
    assert r1.tool_calls, "model emitted no tool call"
    assert pub1.reasoning_text.strip() or r1.capture.get("reasoning_content"), (
        "no reasoning tokens streamed/captured with reasoning enabled"
    )

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL], extra_body=_REASONING)
    assert (r2.content or pub.token_text).strip()
