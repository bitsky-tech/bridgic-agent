"""GLM / 智谱 (BigModel, OpenAI-compatible wire) — live capability proofs.

SKIPPED unless ``GLM_API_KEY`` (or ``ZHIPU_API_KEY``) is set. Drives the
production :class:`OpenAICompatLlm.stream_turn` path against
``https://open.bigmodel.cn/api/paas/v4/``.

GLM's 多轮思考 rides the OpenAI-compat ``reasoning_content`` delta field, enabled
with ``thinking: {"type": "enabled"}``. The adapter captures it into
``StreamResult.capture['reasoning_content']``.

Default model ``glm-4.6`` (the safest for reliable parallel tool calls; the
research notes ``glm-4.5-air`` may emit a single call per turn). Override with
``GLM_TEST_MODEL``.
"""

from __future__ import annotations

import os

import pytest
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("GLM_API_KEY", "ZHIPU_API_KEY"),
    reason="set GLM_API_KEY (or ZHIPU_API_KEY) to run the live GLM capability tests",
)

_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"
_MODEL = os.getenv("GLM_TEST_MODEL", "glm-4.6")
_THINKING = {"thinking": {"type": "enabled"}}


def _llm() -> OpenAICompatLlm:
    return OpenAICompatLlm(
        api_key=env_key("GLM_API_KEY", "ZHIPU_API_KEY"),
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


async def test_multiturn_thinking_captured() -> None:
    """Thinking mode returns ``reasoning_content``, captured for the round, and a
    tool-call multi-turn loop completes with thinking enabled.
    """
    llm = _llm()
    asked = [user("Think about it, then use get_weather to check Beijing's weather.")]

    r1, pub1 = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_THINKING)
    assert r1.tool_calls, "model emitted no tool call"
    # GLM streams chain-of-thought on the reasoning channel and captures it.
    assert pub1.reasoning_text.strip() or r1.capture.get("reasoning_content"), (
        "no reasoning_content streamed/captured with thinking enabled"
    )

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL], extra_body=_THINKING)
    assert (r2.content or pub.token_text).strip()
