"""OpenAI Codex (ChatGPT-subscription Responses API) — live capability proofs.

SKIPPED unless Codex OAuth credentials exist (``~/.codex/auth.json``, i.e.
``resolve_codex_credentials()`` returns creds). This is the OAuth path
(``protocol == "openai-codex"``), NOT the api-key path — see
``test_openai_capabilities.py`` for that.

This is where OpenAI's **多轮思考** is fully replayable: the Responses API returns
encrypted ``reasoning`` items (``include: ["reasoning.encrypted_content"]``,
``store: false``), and on a stateless multi-turn tool loop you must carry those
``reasoning_items`` back — before their message/function_call — or the API 400s
("message ... without its required 'reasoning' item"). The adapter captures them;
``ai_turn_from_result`` replays them via ``extras['reasoning_items']``, and
``CodexResponsesLlm._convert_messages`` re-emits them in the required order.

Default model ``gpt-5.5``; override with ``CODEX_TEST_MODEL``.
"""

from __future__ import annotations

import os

import pytest

from src.amphi_service.protocol.llms._codex_credentials import resolve_codex_credentials
from src.amphi_service.protocol.llms.codex_llm import CodexConfiguration, CodexResponsesLlm

from ._harness import WEATHER_TOOL, ai_turn_from_result, run_turn, tool_results, user


def _creds():
    try:
        return resolve_codex_credentials()
    except Exception:  # noqa: BLE001 — no creds / unreadable ~/.codex → skip cleanly
        return None


pytestmark = pytest.mark.skipif(
    _creds() is None,
    reason="complete Codex OAuth (~/.codex/auth.json) to run the live Codex capability tests",
)

_MODEL = os.getenv("CODEX_TEST_MODEL", "gpt-5.5")


def _llm() -> CodexResponsesLlm:
    creds = resolve_codex_credentials()
    return CodexResponsesLlm(
        access_token=creds.access_token,
        account_id=creds.account_id,
        configuration=CodexConfiguration(model=_MODEL),
    )


async def test_single_tool_call_multiturn() -> None:
    """One function_call item → function_call_output → final answer.

    The assistant turn replays its captured ``reasoning_items`` (encrypted),
    which the Responses API requires before the function_call on round 2.
    """
    llm = _llm()
    asked = [user("What's the weather in Beijing? Use the get_weather tool.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no function call"
    assert r1.tool_calls[0]["name"] == "get_weather"

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    # Reaching here == round 2 accepted the replayed reasoning_items (no 400).
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_parallel_tool_calls_multiturn() -> None:
    """Several function_call items in one Responses turn, all outputs fed back."""
    llm = _llm()
    asked = [user(
        "Get the current weather for BOTH Beijing and Shanghai. "
        "Call get_weather once per city, in parallel."
    )]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no function call"
    if len(r1.tool_calls) < 2:
        pytest.skip(f"{_MODEL} chose serial calls this run — parallel proof vacuous")

    ai, ids = ai_turn_from_result(r1)
    outs = [f"{c['arguments'].get('city', '?')}: sunny" for c in r1.tool_calls]
    r2, pub = await run_turn(llm, [*asked, ai, *tool_results(ids, outs)], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()


async def test_multiturn_reasoning_items_roundtrip() -> None:
    """The load-bearing proof: encrypted ``reasoning_items`` captured on the
    tool-call turn are replayed (ordered before the function_call) on the next
    turn without the Responses API 400-ing.
    """
    llm = _llm()
    asked = [user("Reason about it, then use get_weather to check Beijing's weather.")]

    r1, _ = await run_turn(llm, asked, tools=[WEATHER_TOOL])
    assert r1.tool_calls, "model emitted no function call"
    if not r1.capture.get("reasoning_items"):
        pytest.skip(f"{_MODEL} returned no reasoning_items this run — round-trip proof vacuous")

    ai, ids = ai_turn_from_result(r1)
    results = tool_results(ids, ["Beijing: 25°C, sunny"] * len(ids))
    r2, pub = await run_turn(llm, [*asked, ai, *results], tools=[WEATHER_TOOL])
    assert (r2.content or pub.token_text).strip()
