"""Argument checking for the workbench tools.

A model calls these tools by writing their arguments into a JSON payload, and
it makes the same two mistakes: a nested list arrives serialized as a string,
and a number arrives quoted. Both are unambiguous, so they are repaired here.

Anything genuinely ambiguous is refused instead, with the shape that would have
worked — a flat list could be one row or one column, and guessing silently is
worse than one clear error. The checks live on this side of the bridge on
purpose: the page can reject a bad shape too, but only after a round trip, and
its message reaches the model a turn later without saying what to send instead.
"""

import ast
import json
from typing import Any, Iterable, List, Optional

_ROWS_EXAMPLE = '[["Product", "Price"], ["Mouse", 89]]'


def _parse_literal(text: str) -> Any:
    """Read a list the model serialized, in JSON or in Python's own repr."""
    for parse in (json.loads, ast.literal_eval):
        try:
            return parse(text)
        except (SyntaxError, TypeError, ValueError):
            continue
    return None


def require_rows(values: Any) -> List[List[Any]]:
    """Return ``values`` as rows of cells, repairing a serialized list."""
    if isinstance(values, str):
        parsed = _parse_literal(values.strip())
        if parsed is None:
            raise ValueError(f"values must be an array of rows, for example {_ROWS_EXAMPLE}")
        values = parsed
    if not isinstance(values, list) or not values:
        raise ValueError(f"values must be a non-empty array of rows, for example {_ROWS_EXAMPLE}")
    if not all(isinstance(row, list) for row in values):
        raise ValueError(
            "values must be an array of ROWS, so each item is itself an array — "
            f"for example {_ROWS_EXAMPLE}"
        )
    return values


def require_str_list(name: str, values: Any) -> List[str]:
    """Return ``values`` as a list of strings, repairing a serialized list."""
    if isinstance(values, str):
        parsed = _parse_literal(values.strip())
        if isinstance(parsed, list):
            values = parsed
    if not isinstance(values, list) or not values:
        raise ValueError(f'{name} must be a non-empty array, for example ["yes", "no"]')
    return [str(item) for item in values]


def require_int(name: str, value: Any, *, minimum: Optional[int] = None) -> int:
    """Return ``value`` as a whole number, accepting a quoted one."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a whole number")
    if isinstance(value, str):
        try:
            value = int(value.strip())
        except ValueError:
            raise ValueError(f"{name} must be a whole number, for example 2") from None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int):
        raise ValueError(f"{name} must be a whole number, for example 2")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name} must be {minimum} or more")
    return value


def require_number(name: str, value: Any) -> float:
    """Return ``value`` as a number, accepting a quoted one."""
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            raise ValueError(f"{name} must be a number, for example 100") from None
    if not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, for example 100")
    return value


def require_bool(name: str, value: Any) -> bool:
    """Return ``value`` as a boolean, accepting the quoted forms."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    raise ValueError(f"{name} must be true or false")


def require_text(name: str, value: Any) -> str:
    """Return ``value`` as non-blank text."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    return value


def require_choice(name: str, value: Any, allowed: Iterable[str]) -> str:
    """Return ``value`` when it is one of ``allowed``, or say what is."""
    options = list(allowed)
    if value not in options:
        raise ValueError(f"{name} must be one of: {', '.join(options)}")
    return str(value)


__all__ = [
    "require_bool",
    "require_choice",
    "require_int",
    "require_number",
    "require_rows",
    "require_str_list",
    "require_text",
]
