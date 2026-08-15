"""OpenAI (Chat Completions, API-key path) — live capability proofs.

SKIPPED unless ``OPENAI_API_KEY`` is set. Drives the production
:class:`OpenAICompatLlm.stream_turn` path (``protocol == "openai"``).

Note on 多轮思考 for this wire: OpenAI's **Chat Completions** endpoint does NOT
return reasoning text — reasoning is internal to the model and only a
``reasoning_effort`` request knob is exposed. So the reasoning test here proves a
reasoning-model multi-turn tool loop completes with ``reasoning_effort`` set; the
*replayable* reasoning round-trip (encrypted ``reasoning_items``) lives on the
Codex Responses API and is proven in ``test_codex_capabilities.py``.

Default model ``gpt-5.4-mini``; override with ``OPENAI_TEST_MODEL``. These
catalog IDs may post-date public docs — swap via the env var if the API rejects.
"""

from __future__ import annotations

import os

import pytest
from bridgic.llms.openai import OpenAIConfiguration

from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("OPENAI_API_KEY"),
    reason="set OPENAI_API_KEY to run the live OpenAI capability tests",
)

_MODEL = os.getenv("OPENAI_TEST_MODEL", "gpt-5.4-mini")


def _llm() -> OpenAICompatLlm:
    return OpenAICompatLlm(
        api_key=env_key("OPENAI_API_KEY"),
        api_base=None,  # → api.openai.com
        configuration=OpenAIConfiguration(model=_MODEL, temperature=0.0, max_tokens=None),
    )


async def test_single_tool_call_multiturn() -> None:
    """One tool_call → role:tool result → final answer (Chat Completions)."""
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
    """Multiple tool_calls in one turn (parallel, default-on), all fed back.

    Parallelisation is model discretion; skips (not flakes) on a serial run.
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


async def test_reasoning_effort_with_tools_rejected_on_chat() -> None:
    """OpenAI's Chat Completions REJECTS ``tools`` + ``reasoning_effort`` together
    (gpt-5.x reasoning models): a 400 ``invalid_request_error`` on ``reasoning_effort``
    — "Function tools with reasoning_effort are not supported ... Please use
    /v1/responses instead" (verified live 2026-07-06 against ``gpt-5.4-mini``).

    This pins the vendor constraint that keeps reasoning+tools OFF the Chat line:
    the agent therefore never sends ``reasoning_effort`` on this path
    (``MainThink.extra_body`` is None), and replayable reasoning WITH tools lives on
    the Responses API — proven on the Codex path in ``test_codex_capabilities.py``.

    Assumes the default reasoning-family model; a non-reasoning ``OPENAI_TEST_MODEL``
    override may not raise.
    """
    from openai import BadRequestError

    llm = _llm()
    asked = [user("Reason about it, then use get_weather to check Beijing.")]
    with pytest.raises(BadRequestError) as exc_info:
        await llm.stream_turn(
            asked, [WEATHER_TOOL], publish=lambda *_a, **_k: None,
            extra_body={"reasoning_effort": "low"},
        )
    assert "reasoning_effort" in str(exc_info.value)
