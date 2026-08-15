"""``render_history_markdown`` — Session Turns to derived Markdown.

The ordered top-level Turns are the source of truth; this projection is written
beside the session so the agent can read per-turn tool calls and full results.

Two flows: the ordinary render (empty doc + a multi-turn history with a
successful tool card and a failed tool step, in order) and the two
"context drops it, the record keeps it" cases (request_human's question
without the raw JSON; a failed turn still archived with its marker).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from src.amphi_service.runtime._history_md import render_history_markdown
from src.amphi_store import UserInput

from ._session_turns import make_session_turns


def _ui(text: str) -> UserInput:
    return UserInput(text=text)


def _ota(answer: str = "", steps: Optional[List[dict]] = None) -> Dict[str, Any]:
    """An OTA dump: an optional tool round, then the finishing decision."""
    rounds: List[Dict[str, Any]] = []
    if steps is not None:
        rounds.append({
            "think_result": {"step_content": "", "tool_calls": [{"tool": "x"}]},
            "action_result": {"results": steps},
        })
    rounds.append({"think_result": {"step_content": answer, "tool_calls": []}})
    return {"ota_record": rounds}


def _render(pairs: List[Tuple[UserInput, Dict[str, Any]]]) -> str:
    return render_history_markdown(make_session_turns(pairs))


def test_history_md_render():
    """The full projection in one pass:

    - empty history → header + placeholder;
    - a multi-turn history renders each ``## Turn n`` in order with the user
      line, final answer, a successful tool card (name + verbatim args + the
      FULL result, never elided), and a failed tool step (``failed: <reason>``);
    - a ``request_human_choice`` step renders its question + option labels
      (``是 / 否``) and NEVER the raw prompt JSON;
    - a turn that ``turn_error``'d is still archived with a ``Turn failed:`` marker.
    """
    import json

    # Empty → header + placeholder.
    empty = render_history_markdown([])
    assert "# Session history" in empty
    assert "No turns yet" in empty

    # Turn 1: a successful bash tool (huge result kept whole), then an answer.
    long_output = "LINE\n" * 200  # well past any single-line display cap
    ok_step = {
        "tool_name": "bash",
        "tool_arguments": {"command": "ls -la"},
        "tool_result": long_output,
        "success": True,
    }
    # Turn 2: a failed bash step, then a different answer.
    bad_step = {
        "tool_name": "bash",
        "tool_arguments": {"command": "boom"},
        "error": "exit 1",
        "success": False,
    }
    md = _render([
        (_ui("first"), _ota(answer="a1 hello back", steps=[ok_step])),
        (_ui("second"), _ota(answer="a2 done", steps=[bad_step])),
    ])

    # Plain user + answer surfaced for each turn.
    assert "**User:** first" in md
    assert "**User:** second" in md
    assert "a1 hello back" in md
    assert "a2 done" in md

    # The successful tool card: name, args verbatim, full result (not elided).
    assert "`bash`" in md
    assert "- command: ls -la" in md
    assert long_output.strip() in md

    # The failed step shows its failure reason.
    assert "failed: exit 1" in md

    # Ordering: turn headers in sequence, and the two answers in sequence.
    assert md.index("## Turn 1") < md.index("## Turn 2")
    assert md.index("first") < md.index("second")
    assert md.index("a1 hello back") < md.index("a2 done")

    # request_human_choice: question + labels surface; raw prompt JSON never leaks.
    prompt = json.dumps(
        {"questions": [{"question": "递归吗?", "options": [{"label": "是"}, {"label": "否"}]}]},
        ensure_ascii=False,
    )
    ask_step = {
        "tool_name": "request_human_choice",
        "tool_arguments": {"questions": prompt, "prompt": "**背景**：选择遍历策略。"},
        "tool_result": "",
        "success": True,
    }
    asked = _render([(_ui("go"), _ota(answer="", steps=[ask_step]))])
    assert "递归吗?" in asked
    assert "是 / 否" in asked
    assert "questions" not in asked  # the raw prompt JSON must not leak

    # A failed turn IS in history.md (the LLM context drops it; the record keeps it).
    ota = _ota(answer="partial")
    ota["turn_error"] = "RuntimeError: boom"
    failed = _render([(_ui("trigger"), ota)])
    assert "## Turn 1" in failed
    assert "**User:** trigger" in failed
    assert "Turn failed:" in failed
    assert "RuntimeError: boom" in failed
