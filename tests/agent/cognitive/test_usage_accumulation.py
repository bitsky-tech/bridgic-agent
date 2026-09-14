from types import SimpleNamespace
from typing import Any

from src.amphi_agent import (
    AmphiContext,
    AmphiOTAContext,
    ContextUsageBreakdown,
    LlmProvider,
    MainThink,
)
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive._harness import make_session


def _result(**usage: Any) -> SimpleNamespace:
    return SimpleNamespace(usage=SimpleNamespace(**usage), content="ok", tool_calls=[])


def test_cache_usage_accumulates_across_rounds(test_sandbox: IsolatedPaths) -> None:
    """Cache reads, cache writes, and reporting coverage survive a multi-round Turn.

    {
      "rounds": [
        {"shape": "anthropic", "cache_read": 60, "cache_write": 40},
        {"shape": "openai", "cache_read": 0, "cache_write": 0},
        {"shape": "bare", "cache_read": null, "cache_write": 0}
      ],
      "totals": {"cached_input_tokens_total": 60, "cache_write_tokens_total": 40},
      "coverage": {"cached_reported_rounds": 2, "cached_total_rounds": 3}
    }

    Checks:
    1. Cache reads and writes accumulate instead of being overwritten by the last round.
    2. A round that reports zero cache and a round that omits the field entirely stay
       distinguishable, so a hit rate can tell "no cache" from "no report".
    3. ``cached_input_tokens`` keeps reporting the latest round alone.
    """
    ota_context = AmphiOTAContext(user_input="Accumulate usage")
    context = AmphiContext(
        session=make_session(test_sandbox.sessions / "usage-accumulation"),
        llm_provider=LlmProvider(model_id="test-model", model_limits={"input": 100_000}),
    )
    worker = MainThink(SimpleNamespace())

    rounds = [
        # Anthropic: input_tokens excludes both cache legs, so input folds to 200.
        _result(
            input_tokens=100,
            output_tokens=10,
            cache_creation_input_tokens=40,
            cache_read_input_tokens=60,
        ),
        # OpenAI-compatible: a cold call that still reports its zero.
        _result(
            prompt_tokens=80,
            completion_tokens=5,
            prompt_tokens_details={"cached_tokens": 0},
        ),
        # A provider that omits the cache fields when nothing was cached.
        _result(prompt_tokens=50, completion_tokens=5),
    ]
    for result in rounds:
        worker._record_model_usage(ota_context, context, result, 10, ContextUsageBreakdown())

    usage = ota_context.context_usage

    # Check 1: Turn totals accumulate both cache legs.
    assert (usage.input_tokens, usage.output_tokens) == (330, 20)
    assert usage.cached_input_tokens_total == 60
    assert usage.cache_write_tokens_total == 40

    # Check 2: Reported-zero and never-reported stay apart.
    assert (usage.cached_reported_rounds, usage.cached_total_rounds) == (2, 3)

    # Check 3: The per-round field still describes the latest round only.
    assert usage.cached_input_tokens is None
