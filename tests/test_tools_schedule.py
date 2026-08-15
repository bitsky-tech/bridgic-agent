"""``tools/_schedule`` — LLM tool-boundary coercion.

The model may emit the boolean ``enabled`` flag as a *string* despite the tool
schema; without coercion the string reaches the boolean DB column and raises
'Not a boolean value: True'. ``_coerce_optional_bool`` normalises it at the
boundary. Pure-function tests — no agent context needed.
"""
from __future__ import annotations

import inspect

import pytest

from src.amphi_agent.tools import _schedule as schedule_tools
from src.amphi_agent.tools._schedule import _coerce_optional_bool, _normalize_cron
from src.amphi_service.i18n import use_locale


@pytest.mark.parametrize(
    "tool_name",
    ["create_schedule", "update_schedule", "list_schedules", "get_schedule", "delete_schedule"],
)
def test_schedule_tools_are_async(tool_name: str) -> None:
    # A tool must be `async def` to run in the agent task where the
    # `current_agent` ContextVar is set. A sync tool runs in a thread-pool
    # executor (Worker.arun -> run_in_executor) that does NOT propagate
    # contextvars, so `_library()` sees no agent -> "No schedule catalogue".
    # get_schedule/list_schedules regressed here; guard all four.
    assert inspect.iscoroutinefunction(getattr(schedule_tools, tool_name))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),          # omitted field stays tri-state None
        (True, True),
        (False, False),
        ("True", True),        # the reported bug: model sent the string
        ("true", True),
        ("false", False),
        ("False", False),
        ("1", True),
        ("0", False),
        ("yes", True),
        ("no", False),
        (" True ", True),      # surrounding whitespace tolerated
        (1, True),             # some serializers send 0/1 ints
        (0, False),
    ],
)
def test_coerce_optional_bool(value: object, expected: bool | None) -> None:
    assert _coerce_optional_bool(value) is expected


@pytest.mark.parametrize("value", ["None", "none", "NONE", " None ", "null", "NULL"])
def test_coerce_optional_bool_accepts_stringified_null(value: str) -> None:
    # Observed in session_20260726_185427: the model wants "don't filter by
    # enabled state" and writes the *string* "None" (Python's str(None)).
    # Rejecting it made the model retry with byte-identical arguments and burn
    # a round; "no filter" is exactly what tri-state None means, so map it.
    assert _coerce_optional_bool(value) is None


@pytest.mark.parametrize("value", ["maybe", "", "2", "yep"])
def test_coerce_optional_bool_rejects_garbage(value: str) -> None:
    # Fail loud on an unrecognised value rather than silently defaulting.
    # "" stays rejected on purpose — see the module docstring.
    with pytest.raises(ValueError):
        _coerce_optional_bool(value)


@pytest.mark.parametrize(
    ("locale", "fix"),
    [("en", "Omit the field"), ("zh", "省略该字段")],
)
def test_coerce_optional_bool_error_is_actionable(locale: str, fix: str) -> None:
    # A bare "invalid boolean value" left the model with no way to self-correct
    # (it retried the same args). The message must name the fix — in whichever
    # language it renders, since the model reads it back as the tool's error.
    with use_locale(locale), pytest.raises(ValueError, match=fix):
        _coerce_optional_bool("maybe")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),                          # omitted (update) stays unchanged
        ("0 0 9 * * *", "0 0 9 * * *"),        # canonical passes through
        ("  0 0 9 * * *  ", "0 0 9 * * *"),    # surrounding whitespace
        ("`0 9 * * *`", "0 9 * * *"),          # markdown backticks — the reported class
        ("'0 0 9 * * *'", "0 0 9 * * *"),      # single quotes
        ('"0 9 * * *"', "0 9 * * *"),          # double quotes
        ("` 0 9 * * * `", "0 9 * * *"),        # whitespace inside the wrap too
        ("`0 9 * * *", "`0 9 * * *"),          # unmatched — left as-is (fail loud downstream)
    ],
)
def test_normalize_cron(value: object, expected: object) -> None:
    assert _normalize_cron(value) == expected


def test_normalize_cron_output_is_croniter_valid() -> None:
    # The de-quoted expression must actually parse (regression against the
    # CroniterNotAlphaError the raw backticked form raised).
    from datetime import datetime

    from croniter import croniter

    normalized = _normalize_cron("`0 0 9 * * *`")
    assert croniter.is_valid(normalized)
    assert croniter(normalized, datetime(2026, 7, 22, 10, 0, 0), second_at_beginning=True)
