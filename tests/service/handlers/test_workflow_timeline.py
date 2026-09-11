import pytest

from src.amphi_service.handler._session_handler import _turn_messages
from src.amphi_store import SessionTurnRecord, TurnStatus, UserInput


@pytest.mark.parametrize("legacy", [False, True])
def test_removing_a_question_preserves_section_positions(legacy: bool) -> None:
    """Removing entry prose cannot move a heading onto the following thinking block."""
    step = {
        "workflow_id": "wf", "generation": "gen", "workflow_name": "Directory",
        "phase": "execute", "step_index": 0, "step_count": 1,
        "title": "Choose directory", "status": "running",
    }
    records = [
        {
            "think_result": {"step_content": "Which directory?"},
            "action_result": {"results": [{
                "tool_name": "request_run_workflow", "tool_result": {"status": "started"},
            }]},
        },
        {
            "workflow_step": step,
            "reasoning_content": "Asking for the target",
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {"questions": [{"question": "Which directory?"}]},
                "tool_result": "/tmp/project",
            }]},
        },
        {
            "workflow_step": step,
            "action_result": {"results": [{
                "tool_name": "report_workflow_step",
                "tool_result": {**step, "status": "success", "summary": "Confirmed"},
            }]},
        },
    ]
    if legacy:
        for record in records:
            record.pop("workflow_step", None)
    turn = SessionTurnRecord(
        id="turn", user_id="local", session_id="session", session_ordinal=0,
        user_input=UserInput(text="Summarize a directory"), status=TurnStatus.COMPLETED,
        ota_records=records,
    )
    blocks = _turn_messages(
        turn.session_id, 0, turn, 0, is_last=True, subagents={}, show_pending_interaction=False,
    )[0]["blocks"]
    assert [block["type"] for block in blocks] == ["workflow_step", "thinking", "confirmation"]
    assert blocks[0]["status"] == "success"
    assert blocks[0]["summary"] == "Confirmed"
    assert blocks[1] == {"type": "thinking", "text": "Asking for the target"}
    assert blocks[2]["response"] == "/tmp/project"


@pytest.mark.parametrize(("status", "expected"), [
    (TurnStatus.AWAITING_HUMAN, "running"),
    (TurnStatus.CANCELLED, "neutral"),
    (TurnStatus.FAILED, "failure"),
    (TurnStatus.COMPLETED, "neutral"),
])
@pytest.mark.parametrize("legacy", [False, True])
def test_terminal_turn_settles_only_unfinished_steps(status: TurnStatus, expected: str, legacy: bool) -> None:
    """Terminal display state preserves completed steps and the durable execution trace."""
    step = {
        "workflow_id": "wf", "generation": "gen", "workflow_name": "Directory",
        "phase": "execute", "step_index": 1, "step_count": 2,
        "title": "Scan directory", "execution_steps": ["Choose directory", "Scan directory"],
        "status": "running",
    }
    turn = SessionTurnRecord(
        id="turn", user_id="local", session_id="session", session_ordinal=0,
        user_input=UserInput(text="Summarize a directory"), status=status,
        ota_records=[
            {"action_result": {"results": [{
                "tool_name": "report_workflow_step",
                "tool_result": {**step, "step_index": 0, "title": "Choose directory", "status": "success"},
            }]}},
            {
                **({} if legacy else {"workflow_step": step}),
                "reasoning_content": "Checking the target",
            },
        ],
        agent_state={"think": {
            "mode": "run_workflow", "stage": "execute", "workflow_id": "wf",
            "generation": "gen", "step_index": 1,
        }},
    )
    blocks = _turn_messages(
        turn.session_id, 0, turn, 0, is_last=True, subagents={}, show_pending_interaction=False,
        workflow_run=step if legacy else None,
    )[0]["blocks"]
    assert [block["status"] for block in blocks if block["type"] == "workflow_step"] == ["success", expected]
    assert blocks[-1] == {"type": "thinking", "text": "Checking the target"}
    if not legacy:
        assert turn.ota_context_dump()["ota_record"][-1]["workflow_step"]["status"] == "running"


@pytest.mark.parametrize("state", ["awaiting", "answered", "resumed", "reported"])
@pytest.mark.parametrize("legacy", [False, True])
def test_workflow_heading_survives_interaction_reload(state: str, legacy: bool) -> None:
    """Reload and resume keep the question and its answer under the original step."""
    step = {
        "workflow_id": "workflow-directory",
        "generation": "run-directory",
        "workflow_name": "Directory summary",
        "phase": "execute",
        "step_index": 0,
        "step_count": 2,
        "title": "Confirm directory",
        "execution_steps": ["Confirm directory", "Scan directory"],
        "status": "running",
    }
    records = [
        {
            "think_result": {"step_content": "Starting the workflow"},
            "action_result": {"results": [{
                "tool_name": "request_run_workflow",
                "tool_arguments": {"action": "start"},
                "tool_result": {"status": "started"},
            }]},
        },
        {
            "workflow_step": step,
            "reasoning_content": "Planning the directory question",
            "think_result": {"step_content": "Please choose the target directory"},
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {"questions": [{"question": "Which directory?"}]},
                "tool_result": None if state == "awaiting" else "/tmp/project",
            }]},
        },
    ]
    if state in {"resumed", "reported"}:
        records.append({
            "workflow_step": step,
            "reasoning_content": "Checking the selected directory",
        })
    if state == "reported":
        records.extend([
            {
                "workflow_step": step,
                "action_result": {"results": [{
                    "tool_name": "report_workflow_step",
                    "tool_result": {**step, "status": "success", "summary": "Directory confirmed"},
                }]},
            },
            {
                "workflow_step": {**step, "step_index": 1, "title": "Scan directory"},
                "reasoning_content": "Scanning the directory",
            },
        ])
    if legacy:
        for record in records:
            record.pop("workflow_step", None)
    step_index = 1 if state == "reported" else 0
    turn = SessionTurnRecord(
        id="turn-directory",
        user_id="local",
        session_id="session-directory",
        session_ordinal=0,
        user_input=UserInput(text="Summarize a directory"),
        ota_records=records,
        agent_state={
            "think": {
                "mode": "run_workflow", "stage": "execute",
                "workflow_id": step["workflow_id"], "generation": step["generation"],
                "step_index": step_index,
            },
            "interaction": {"questions": [{"question": "Which directory?"}]},
        },
        status=TurnStatus.AWAITING_HUMAN,
    )
    blocks = _turn_messages(
        turn.session_id, 0, turn, 0,
        is_last=True, subagents={}, show_pending_interaction=state == "awaiting",
        workflow_run={**step, "step_index": step_index} if legacy else None,
    )[0]["blocks"]

    assert blocks[0] == {"type": "text", "text": "Starting the workflow"}
    assert blocks[1]["type"] == "workflow_step"
    assert blocks[1]["title"] == "Confirm directory"
    assert blocks[2] == {"type": "thinking", "text": "Planning the directory question"}
    headings = [block for block in blocks if block["type"] == "workflow_step"]
    assert len(headings) == (2 if state == "reported" else 1)
    assert headings[0]["status"] == ("success" if state == "reported" else "running")
    if state != "awaiting":
        confirmation = next(block for block in blocks if block["type"] == "confirmation")
        assert confirmation["response"] == "/tmp/project"
    if state == "reported":
        assert headings[0]["summary"] == "Directory confirmed"
        assert blocks[-2] == headings[1]
        assert blocks[-1] == {"type": "thinking", "text": "Scanning the directory"}


def test_workflow_snapshot_does_not_leak_into_another_run() -> None:
    """A Run checkpoint must not invent a heading for an unrelated historical Turn."""
    turn = SessionTurnRecord(
        id="turn-old-run", user_id="local", session_id="session-directory", session_ordinal=0,
        user_input=UserInput(text="Summarize a directory"),
        ota_records=[{"think_result": {"step_content": "Previous run content"}}],
        agent_state={"think": {
            "mode": "run_workflow", "stage": "execute",
            "workflow_id": "workflow-directory", "generation": "old-run", "step_index": 0,
        }},
        status=TurnStatus.CANCELLED,
    )
    blocks = _turn_messages(
        turn.session_id, 0, turn, 0,
        is_last=True, subagents={}, show_pending_interaction=False,
        workflow_run={
            "workflow_id": "workflow-directory", "generation": "new-run",
            "phase": "execute", "step_index": 0, "execution_steps": ["Choose directory"],
        },
    )[0]["blocks"]
    assert blocks == [{"type": "text", "text": "Previous run content"}]
