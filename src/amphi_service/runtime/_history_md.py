import json
from typing import Any, Dict, List, Sequence, Tuple

from ...amphi_agent.tools._request_human import RequestHumanChoice
from ...amphi_store import SessionTurnRecord

_INLINE_MAX = 160  # arg values longer than this (or multi-line) drop to a fenced block

_DOC_HEADER = (
    "# Session history\n\n"
    "A full, round-by-round record of every turn in this session — each tool "
    "call and its complete output included. The conversation in your context "
    "keeps only each turn's question and final answer; read here for the detail "
    "in between."
)


def render_history_markdown(turns: Sequence[SessionTurnRecord]) -> str:
    """The session's complete turn-by-turn history as Markdown — a derived view.

    The ordered SessionTurns and their durable OTA fields are the source. This
    projection is rewritten after every attempt so the Agent can inspect each
    round, tool call, and full result.
    """
    if not turns:
        return f"{_DOC_HEADER}\n\n_No turns yet._\n"
    blocks: List[str] = [_DOC_HEADER]
    for index, turn in enumerate(turns, start=1):
        blocks.append(_render_turn(index, turn.user_input.text, turn.ota_context_dump()))
    return "\n\n".join(blocks).rstrip() + "\n"


def _render_turn(index: int, user_text: str, ota: Dict[str, Any]) -> str:
    """One ``(user, OTA dump)`` pair → a ``## Turn n`` section.

    Replays every round (not just the final answer): a round's thought, then each
    tool call it made with that call's full result. A failed turn (``turn_error``)
    ends with the failure — kept here even though it never feeds the model.
    """
    lines: List[str] = [f"## Turn {index}", "", f"**User:** {user_text}".rstrip()]
    for round_ in ota.get("ota_record") or []:
        if not isinstance(round_, dict):
            continue
        think = round_.get("think_result")
        content = (think.get("step_content") or "").strip() if isinstance(think, dict) else ""
        if content:
            lines += ["", content]
        action = round_.get("action_result")
        steps = (action.get("results") or []) if isinstance(action, dict) else []
        for step in steps:
            if isinstance(step, dict):
                lines += _render_step(step)
    error = ota.get("turn_error")
    if error:
        lines += ["", f"**Turn failed:** {error}"]
    return "\n".join(lines)


def _render_step(step: Dict[str, Any]) -> List[str]:
    """One executed tool step → a labelled call, its arguments, and its full result.

    Multi-line / long argument values drop to their own fenced block so they
    never break the call line; ``request_human_choice`` shows the question it
    posed rather than the raw prompt JSON.
    """
    name = step.get("tool_name") or "(tool)"
    lines: List[str] = ["", f"**→ `{name}`**"]
    for key, value in _arg_pairs(name, step.get("tool_arguments")):
        lines += _arg_lines(key, value)
    lines += ["", "```", _render_result(step), "```"]
    return lines


def _arg_pairs(name: str, args: Any) -> List[Tuple[str, str]]:
    """Tool arguments as ``(label, value)`` rows — values verbatim, no eliding.

    ``request_human_choice`` collapses to the question(s) it asked; any other
    tool lists its arguments as-is.
    """
    if name == "request_human_choice":
        return [("asked", _asked_text(args))]
    if isinstance(args, dict):
        return [(str(key), _scalar(value)) for key, value in args.items()]
    if isinstance(args, list):
        rows: List[Tuple[str, str]] = []
        for item in args:
            if isinstance(item, dict) and "name" in item:
                rows.append((str(item.get("name")), _scalar(item.get("value"))))
            else:
                rows.append(("arg", _scalar(item)))
        return rows
    return [] if args is None else [("arg", _scalar(args))]


def _asked_text(args: Any) -> str:
    """A ``request_human_choice`` step's question(s) + option labels, joined."""
    if isinstance(args, dict):
        value = args.get("questions") or args.get("prompt")
    else:
        value = args
    parts: List[str] = []
    for question in RequestHumanChoice.coerce_questions(value):
        if not isinstance(question, dict):
            continue
        text = (question.get("question") or "").strip()
        if not text:
            continue
        labels = " / ".join(
            opt["label"]
            for opt in (question.get("options") or [])
            if isinstance(opt, dict) and opt.get("label")
        )
        parts.append(f"{text}  [{labels}]" if labels else text)
    return "; ".join(parts) or "(question)"


def _arg_lines(key: str, value: str) -> List[str]:
    """One argument as a ``- key: value`` line, or ``- key:`` + a fenced block
    when the value is long or multi-line (keeps the call line intact)."""
    if "\n" in value or len(value) > _INLINE_MAX:
        return [f"- {key}:", "```", value, "```"]
    return [f"- {key}: {value}"]


def _scalar(value: Any) -> str:
    """A single value as a string — plain for ``str``, JSON for anything else."""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _render_result(step: Dict[str, Any]) -> str:
    """One step's result body — the failure reason or the verbatim output."""
    error = step.get("error")
    if error or step.get("success") is False:
        return f"failed: {error or 'tool failed'}"
    result = step.get("tool_result")
    if result is None:
        return "(no output)"
    if result == "":
        return "(awaiting the user's answer)"
    return str(result)


__all__ = ["render_history_markdown"]
