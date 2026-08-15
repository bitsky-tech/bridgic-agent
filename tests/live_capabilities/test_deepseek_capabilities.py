"""DeepSeek (OpenAI-compatible wire) — live capability proofs.

SKIPPED unless ``DEEPSEEK_API_KEY`` is set. Drives the production
:class:`OpenAICompatLlm.stream_turn` path against ``https://api.deepseek.com``.

DeepSeek's 多轮思考 has a subtle, load-bearing contract the agent relies on: the
reasoning model returns Chain-of-Thought in a separate ``reasoning_content``
field, and on the assistant turn that emits ``tool_calls`` you MUST pass
``reasoning_content`` **back** together with the calls (thinking-mode tool turns
400 if it is dropped) — while on ordinary turns you must NOT resend it. The
adapter captures ``reasoning_content``; ``ai_turn_from_result`` replays it via
``extras['reasoning_content']`` on the tool-call turn, exactly as
``turn_messages_block`` does.

Models: tool tests default to ``deepseek-v4-flash`` (chat tier, reliable tools);
the reasoning test defaults to ``deepseek-v4-pro`` (reasoner tier). Override with
``DEEPSEEK_TEST_MODEL`` / ``DEEPSEEK_REASONER_MODEL``. These catalog IDs may
differ from the public ``deepseek-chat`` / ``deepseek-reasoner`` — swap via env
if the API rejects them.
"""

from __future__ import annotations

import os

import pytest
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("DEEPSEEK_API_KEY"),
    reason="set DEEPSEEK_API_KEY to run the live DeepSeek capability tests",
)

_BASE_URL = "https://api.deepseek.com"
_MODEL = os.getenv("DEEPSEEK_TEST_MODEL", "deepseek-v4-flash")
_REASONER = os.getenv("DEEPSEEK_REASONER_MODEL", "deepseek-v4-pro")


def _llm(model: str) -> OpenAICompatLlm:
    return OpenAICompatLlm(
        api_key=env_key("DEEPSEEK_API_KEY"),
        api_base=_BASE_URL,
        configuration=OpenAIConfiguration(model=model, temperature=0.0, max_tokens=None),
    )


async def test_single_tool_call_multiturn() -> None:
    llm = _llm(_MODEL)
    asked = [user("What's the weather in Beijing? Use the get_weather tool.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no tool call"
    assert r1.tool_calls[0]["name"] == "get_weather"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_parallel_tool_calls_multiturn() -> None:
    """Multiple entries in one ``tool_calls`` array. DeepSeek has no documented
    ``parallel_tool_calls`` switch — batching is model-driven — so a serial run
    skips rather than flakes.
    """
    llm = _llm(_MODEL)
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


async def test_multiturn_reasoning_content_roundtrip() -> None:
    """The reasoner returns ``reasoning_content``; on a tool-call turn it must be
    replayed back or DeepSeek 400s. Proves capture + the tool-turn round-trip.
    """
    llm = _llm(_REASONER)
    asked = [user("Reason about it, then use get_weather to check Beijing's weather.")]

    r1, pub1 = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    # The reasoner streams CoT on the reasoning channel and captures it.
    assert pub1.reasoning_text.strip() or r1.capture.get("reasoning_content"), (
        "reasoner returned no reasoning_content"
    )
    if not r1.tool_calls:
        pytest.skip(f"{_REASONER} did not call a tool this run — tool-turn round-trip vacuous")

    ai, ids = ai_turn_from_result(r1)  # carries reasoning_content back with the tool_calls
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    # Reaching a result == the thinking-mode tool-call turn replayed cleanly (no 400).
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()
