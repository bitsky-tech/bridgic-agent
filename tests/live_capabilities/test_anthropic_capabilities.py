"""Anthropic (Claude Messages API) — live capability proofs.

SKIPPED unless ``ANTHROPIC_API_KEY`` is set. Drives the production
:class:`AnthropicLlm.stream_turn` path. Together with
``src/amphi_service/protocol/llms/anthropic_llm.py``, these tests are the
executable capability reference.

Capabilities proven here:
  1. 多轮思考             — extended-thinking blocks captured on a tool-call turn and
                           replayed on the next turn (Anthropic 400s if the
                           assistant turn's ``thinking`` block is dropped).
  2. 多轮对话下单次工具调用 — one ``tool_use`` block → ``tool_result`` → final answer.
  3. 多轮对话下批量工具调用 — several ``tool_use`` blocks in one turn (parallel,
                           default-on for Claude 4).

Default model ``claude-haiku-4-5`` (cheapest that supports thinking + tools);
override with ``ANTHROPIC_TEST_MODEL``.
"""

from __future__ import annotations

import os

import pytest

from src.amphi_service.protocol.llms.anthropic_llm import AnthropicConfiguration, AnthropicLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("ANTHROPIC_API_KEY"),
    reason="set ANTHROPIC_API_KEY to run the live Anthropic capability tests",
)

_MODEL = os.getenv("ANTHROPIC_TEST_MODEL", "claude-haiku-4-5")

# Extended thinking: enable + the temperature=1 the thinking mode requires (the
# adapter otherwise sends temperature=0, which the API rejects under thinking).
# budget_tokens must be < max_tokens (adapter default 8192).
_THINKING = {"thinking": {"type": "enabled", "budget_tokens": 2048}, "temperature": 1.0}


def _llm() -> AnthropicLlm:
    return AnthropicLlm(
        api_key=env_key("ANTHROPIC_API_KEY"),
        configuration=AnthropicConfiguration(model=_MODEL, temperature=0.0),
    )


async def test_single_tool_call_multiturn() -> None:
    """One tool call → result fed back → a final answer, all through stream_turn."""
    llm = _llm()
    asked = [user("What's the weather in Beijing? Use the get_weather tool.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no tool call"
    assert r1.tool_calls[0]["name"] == "get_weather"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])

    # Reaching here == round 2 did not 400; the model answered in text.
    assert (r2.content or pub.token_text).strip()


async def test_parallel_tool_calls_multiturn() -> None:
    """Several tool_use blocks in one assistant turn, then all results fed back.

    Parallelisation is Claude's discretion; if a given run chooses serial calls
    the parallel proof is vacuous, so the test skips rather than flaking.
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
    assert {c["name"] for c in r1.tool_calls} == {"get_weather"}

    ai, ids = ai_turn_from_result(r1)
    outs = [f"{c['arguments'].get('city', '?')}: sunny" for c in r1.tool_calls]
    r2, pub = await run_turn(llm, [*asked, ai, *tool_results(ids, outs)], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_multiturn_thinking_roundtrip() -> None:
    """Extended-thinking blocks captured on a tool-call turn must replay cleanly.

    The load-bearing proof: with thinking enabled, Anthropic 400s if the
    follow-up's tool-calling assistant turn omits its ``thinking`` block. The
    adapter captures the block (with signature) into ``StreamResult.capture``;
    ``ai_turn_from_result`` replays it via ``extras['thinking_blocks']`` exactly
    as ``turn_messages_block`` does. Round 2 succeeding proves the round-trip.
    """
    llm = _llm()
    asked = [user("Think about it, then use get_weather to check Beijing's weather.")]

    r1, pub1 = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_THINKING)
    assert pub1.reasoning_text.strip(), "no thinking streamed on the reasoning channel"
    assert r1.capture.get("thinking_blocks"), "thinking blocks were not captured for replay"
    assert r1.tool_calls, "expected a thinking+tool-call turn to replay"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, _ = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL], extra_body=_THINKING)

    # No 400 on replay == the thinking-block round-trip holds.
    assert r2.content or r2.tool_calls
