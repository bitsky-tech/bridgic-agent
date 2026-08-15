"""Structured ``choice_answer`` resume path: ids travel the wire, copy never does.

Covers the protocol frame, the selection helper, and the two destructive card
resumes (build conflict / run choice) plus ``request_human_choice`` folding.
The free-text cases pin the anti-hijack contract: a chat reply — even one that
echoes the card question or names an option to reject it — must fold back as
``not_answered`` instead of executing an action.
"""

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._state import AwaitingBuildConflict, BuildStageState
from src.amphi_agent._workspace import Workspace
from src.amphi_agent._workflows import WorkflowLibrary
from src.amphi_agent.tools._request_human import RequestBuild
from src.amphi_service.protocol import (
    WsChoiceAnswerMessage,
    WsMessageError,
    parse_client_message,
)
from src.amphi_service.i18n import use_locale
from src.amphi_store import SessionRecord, UserInput

from ._session_turns import make_session_turns


class _Stream:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish(self, event: str, **payload) -> None:
        self.events.append((event, payload))


def _ota(user_input: Any = "x") -> AmphiOTAContext:
    return AmphiOTAContext(user_input=user_input, stream=_Stream())


def _record(tmp_path: Path) -> SessionRecord:
    return SessionRecord(id="session", user_id="user", workspace_root=str(tmp_path))


def _workspace(tmp_path: Path) -> Workspace:
    workspace = Workspace("session", session_root=tmp_path)
    workspace.work_dir.mkdir(parents=True, exist_ok=True)
    return workspace


def _context(*, session: Optional[Session] = None, workspace: Optional[Workspace] = None) -> AmphiContext:
    workflows = WorkflowLibrary("user")
    if workspace is not None and workspace.build is not None:
        workflows.open_package(workspace.build.root)
    return AmphiContext(session=session or Session(), workflows=workflows, workspace=workspace)


def _answer(request_id: str, option_id: Optional[str] = None, text: Optional[str] = None) -> WsChoiceAnswerMessage:
    return WsChoiceAnswerMessage(
        session_id="session",
        request_id=request_id,
        answers=[{"index": 0, **({"option_id": option_id} if option_id else {}), **({"text": text} if text else {})}],
    )


################################################################################
# Protocol frame
################################################################################


def test_choice_answer_frame_parses() -> None:
    msg = parse_client_message({
        "type": "choice_answer",
        "session_id": "session",
        "request_id": "req-1",
        "answers": [{"index": 0, "option_id": "keep"}],
    })

    assert isinstance(msg, WsChoiceAnswerMessage)
    assert msg.answers[0].option_id == "keep"


def test_choice_answer_frame_rejects_unknown_fields() -> None:
    with pytest.raises(WsMessageError):
        parse_client_message({
            "type": "choice_answer",
            "session_id": "session",
            "request_id": "req-1",
            "answers": [{"index": 0, "label": "保留并继续"}],
        })


################################################################################
# Selection helper
################################################################################

_QUESTIONS = [{
    "question": "如何处理？",
    "options": [
        {"id": "keep", "label": "保留并继续"},
        {"id": "replace_new", "label": "删除并新建"},
    ],
}]


def test_choice_selection_returns_the_structured_option_id() -> None:
    selected = AmphiAgent._choice_selection(
        _answer("req-1", option_id="replace_new"),
        request_id="req-1",
        questions=_QUESTIONS,
        allowed={"keep", "merge", "replace_edit", "replace_new"},
    )

    assert selected == "replace_new"


def test_choice_selection_rejects_a_stale_request_id() -> None:
    with pytest.raises(RuntimeError):
        AmphiAgent._choice_selection(
            _answer("req-other", option_id="keep"),
            request_id="req-1",
            questions=_QUESTIONS,
            allowed={"keep"},
        )


def test_choice_selection_rejects_an_option_the_card_never_offered() -> None:
    with pytest.raises(RuntimeError):
        AmphiAgent._choice_selection(
            _answer("req-1", option_id="merge"),
            request_id="req-1",
            questions=_QUESTIONS,
            allowed={"keep", "merge", "replace_edit", "replace_new"},
        )


def test_choice_selection_treats_typed_other_text_as_free_form() -> None:
    selected = AmphiAgent._choice_selection(
        _answer("req-1", text="先备份再说"),
        request_id="req-1",
        questions=_QUESTIONS,
        allowed={"keep", "replace_new"},
    )

    assert selected is None


def test_choice_selection_passes_chat_input_through_as_free_form() -> None:
    selected = AmphiAgent._choice_selection(
        "删除并新建",
        request_id="req-1",
        questions=_QUESTIONS,
        allowed={"keep", "replace_new"},
    )

    assert selected is None


################################################################################
# Build-conflict resume
################################################################################


async def _parked_conflict(tmp_path: Path) -> tuple[SessionRecord, Workspace, list, str]:
    """Park a zh build-conflict card exactly the way ``after_action`` persists it."""
    record = _record(tmp_path)
    workspace = _workspace(tmp_path)
    build = await workspace.prepare_build_space("create", stage="generate")
    (build.root / "task.md").write_text("old task", encoding="utf-8")
    conflict_ota = _ota()
    conflict_ota.transition_think(BuildStageState(stage="generate"))
    conflict_ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="构建另一项任务",
            # The model-authored reason quotes an option label on purpose: the
            # echoed question must never be able to hijack the selection.
            mode="ask",
            reason="用户可能想融合新需求，也可能想删除并新建。",
            request_id="build-conflict-1",
        ),
    )
    conflict_ota.action_result = SimpleNamespace(results=[step])
    with use_locale("zh"):
        async for _ in AmphiAgent().after_action(
            conflict_ota,
            _context(session=Session(record), workspace=workspace),
        ):
            pass
    assert isinstance(conflict_ota.interaction_status, AwaitingBuildConflict)

    pending_dump = conflict_ota.model_dump(mode="json", exclude={"stream", "tools", "ota_record"})
    pending_dump["ota_record"] = [{
        "action_result": {"results": [{
            "tool_name": "request_build",
            "tool_arguments": {"goal": "构建另一项任务", "mode": "ask"},
            "tool_result": step.tool_result,
            "success": True,
        }]},
    }]
    turns = make_session_turns([(UserInput(text="/build 构建另一项任务", blocks=[]), pending_dump)])
    question = conflict_ota.interaction_status.questions[0]["question"]
    return record, workspace, turns, question


async def test_structured_answer_executes_the_selected_action(tmp_path: Path) -> None:
    record, workspace, turns, _ = await _parked_conflict(tmp_path)
    resumed = _ota(_answer("build-conflict-1", option_id="replace_new"))

    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=turns), workspace=workspace),
    )

    result = resumed.ota_record[0].action_result["results"][0]["tool_result"]
    assert result["action"] == "replace"
    assert result["status"] == "resolved"
    assert not (workspace.build.root / "task.md").exists()


async def test_free_text_echoing_the_question_folds_back_untouched(tmp_path: Path) -> None:
    """The reply embeds the full card question (whose reason quotes option labels)
    plus a free-typed note — the pre-fix substring pass resolved this to ``merge``."""
    record, workspace, turns, question = await _parked_conflict(tmp_path)
    resumed = _ota(f"{question}: 先别动，我再想想")

    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=turns), workspace=workspace),
    )

    result = resumed.ota_record[0].action_result["results"][0]["tool_result"]
    assert result["action"] == "not_answered"
    assert (workspace.build.root / "task.md").exists()


async def test_a_negated_option_name_never_executes_that_option(tmp_path: Path) -> None:
    record, workspace, turns, _ = await _parked_conflict(tmp_path)
    resumed = _ota("不要删除并新建，保留吧")

    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=turns), workspace=workspace),
    )

    result = resumed.ota_record[0].action_result["results"][0]["tool_result"]
    assert result["action"] == "not_answered"
    assert (workspace.build.root / "task.md").exists()


async def test_structured_answer_with_a_stale_request_id_raises(tmp_path: Path) -> None:
    record, workspace, turns, _ = await _parked_conflict(tmp_path)
    resumed = _ota(_answer("build-conflict-stale", option_id="keep"))

    with pytest.raises(RuntimeError):
        await AmphiAgent().init_state(
            resumed,
            _context(session=Session(record, turns=turns), workspace=workspace),
        )


################################################################################
# request_human_choice resume
################################################################################


async def test_human_choice_structured_answer_composes_the_tool_result(tmp_path: Path) -> None:
    record = _record(tmp_path)
    questions = [{
        "question": "选哪个环境？",
        "options": [
            {"id": "opt_a", "label": "预发环境"},
            {"id": "opt_b", "label": "生产环境"},
        ],
    }]
    pending_dump = {
        "state": {
            "think": {"mode": "normal", "stage": "main"},
            "interaction": {
                "questions": questions,
                "prompt": "deploy",
                "request_id": "human-choice-1",
            },
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {"questions": "[]", "prompt": "deploy"},
                "tool_result": None,
                "success": True,
            }]},
        }],
    }
    turns = make_session_turns([(UserInput(text="deploy", blocks=[]), pending_dump)])
    resumed = _ota(_answer("human-choice-1", option_id="opt_b"))

    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=turns)),
    )

    ask = resumed.ota_record[0].action_result["results"][0]
    assert ask["tool_result"] == "选哪个环境？: 生产环境"
    assert resumed.interaction_status is None
