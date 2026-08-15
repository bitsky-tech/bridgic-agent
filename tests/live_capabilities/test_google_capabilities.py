"""Google Gemini (native google-genai SDK) — live capability proofs.

SKIPPED unless ``GOOGLE_API_KEY`` is set. Drives the production
:class:`GoogleLlm.stream_turn` path (``protocol == "google"``).

Gemini's 多轮思考 artifact on the tool-use path is the **``thought_signature``**:
each function-call part carries an opaque signature that MUST be echoed back next
turn (Gemini 3.x hard-400s "Function call is missing a thought_signature" if it
is dropped). The reasoning test proves that round-trip end-to-end. A model that
returns no signature on a given run makes the proof vacuous → the test skips
(same convention as ``tests/test_google_live.py``).

Default model ``gemini-2.5-flash``; override with ``GOOGLE_TEST_MODEL`` (use a
Gemini 3.x id such as ``gemini-3.1-flash-lite`` to exercise strict signature
enforcement).
"""

from __future__ import annotations

import os

import pytest
from google.genai import types

from src.amphi_service.protocol.llms.google_llm import GoogleConfiguration, GoogleLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, env_key, run_turn, tool_results, user

pytestmark = pytest.mark.skipif(
    not env_key("GOOGLE_API_KEY"),
    reason="set GOOGLE_API_KEY to run the live Gemini capability tests",
)

_MODEL = os.getenv("GOOGLE_TEST_MODEL", "gemini-2.5-flash")

# Force a function call so round 1 is deterministic (AUTO would let the model
# answer in text). ANY = "call at least one function from tools".
_FORCE_TOOL = {"tool_config": {"function_calling_config": {"mode": "ANY"}}}
# Surface thinking on the reasoning channel and (on thinking models) attach a
# thought_signature to the function-call part.
_THINKING = {**_FORCE_TOOL, "thinking_config": types.ThinkingConfig(include_thoughts=True)}


def _llm() -> GoogleLlm:
    return GoogleLlm(
        api_key=env_key("GOOGLE_API_KEY"),
        configuration=GoogleConfiguration(model=_MODEL, temperature=0.0),
    )


async def test_single_tool_call_multiturn() -> None:
    """One functionCall → functionResponse fed back → final answer."""
    llm = _llm()
    asked = [user("What's the weather in Beijing? Use the get_weather tool.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_FORCE_TOOL)
    assert r1.tool_calls, "model emitted no function call"
    assert r1.tool_calls[0]["name"] == "get_weather"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    # Round 2 with AUTO so the model can answer in text now that it has the result.
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_parallel_tool_calls_multiturn() -> None:
    """Multiple functionCall parts in one turn, then all functionResponses back."""
    llm = _llm()
    asked = [user(
        "Get the current weather for BOTH Beijing and Shanghai. "
        "Call get_weather once per city."
    )]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_FORCE_TOOL)
    assert r1.tool_calls, "model emitted no function call"
    if len(r1.tool_calls) < 2:
        pytest.skip(f"{_MODEL} chose serial calls this run — parallel proof vacuous")

    ai, ids = ai_turn_from_result(r1)
    outs = [f"{c['arguments'].get('city', '?')}: sunny" for c in r1.tool_calls]
    r2, pub = await run_turn(llm, [*asked, ai, *tool_results(ids, outs)], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_multiturn_thought_signature_roundtrip() -> None:
    """The signed reasoning round-trip: a captured ``thought_signature`` replayed
    on the next turn must not 400.

    ``ai_turn_from_result`` carries the base64 signatures back via
    ``extras['thought_signatures']`` (index-aligned to the calls), exactly as
    ``turn_messages_block`` does. If the model returned no signature this run the
    proof is vacuous and the test skips.
    """
    llm = _llm()
    asked = [user("Think about it, then use get_weather to check Beijing's weather.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL], extra_body=_THINKING)
    assert r1.tool_calls, "model emitted no function call"
    if not any(r1.capture.get("thought_signatures") or []):
        pytest.skip(f"{_MODEL} returned no thought_signature — round-trip proof vacuous")

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    # Reaching a result here == the signed reasoning replayed without a 400.
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert r2.content or r2.tool_calls or pub.token_text
