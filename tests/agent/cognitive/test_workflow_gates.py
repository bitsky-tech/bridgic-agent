from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import AmphiContext, AmphiOTAContext, MainThink, WorkflowRunLibrary
from src.amphi_agent.cognitive import WorkflowThink
from src.amphi_agent._workflows import WorkflowLibrary
from src.amphi_store import UserInput
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive._harness import (
    GENERATION,
    USER_ID,
    WORKFLOW_ID,
    make_session,
    make_workspace,
    tool_call,
    write_workflow_source,
)


async def test_main_run_gate(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Main Workflow admission:

    {
      "idle": {"known_start": "allowed", "unknown_or_resume": "blocked"},
      "active": {"second_start": "blocked", "matching_resume": "allowed"},
      "same_turn_repeat": "blocked_after_report"
    }

    Checks:
    1. Main admits only known Workflow definitions and starts only from an idle Session.
    2. An unfinished Run blocks replacement starts and permits only its own resume request.
    3. A Turn that already reported Workflow work cannot launch the Workflow again.
    """
    workflows = WorkflowLibrary(USER_ID)

    def source(workflow_id: str) -> object:
        if workflow_id != WORKFLOW_ID:
            raise ValueError(f"Workflow `{workflow_id}` is unavailable")
        return object()

    monkeypatch.setattr(workflows, "source", source)
    worker = MainThink()
    idle_workspace = make_workspace(test_sandbox, "main-run-idle")
    idle_context = AmphiContext(
        session=make_session(idle_workspace.session_root),
        workflows=workflows,
        workspace=idle_workspace,
    )

    # Check 1: Main admits only known Workflow definitions and starts only from an idle Session.
    assert await worker.legality_check(
        tool_call("edit_workflow", workflow_id=WORKFLOW_ID),
        None,
        idle_context,
    ) is None
    assert "unavailable" in (
        await worker.legality_check(
            tool_call("request_run_workflow", workflow_id="missing", action="start"),
            None,
            idle_context,
        ) or ""
    )
    assert await worker.legality_check(
        tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="start"),
        None,
        idle_context,
    ) is None
    assert "requires an unfinished Run" in (
        await worker.legality_check(
            tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="resume"),
            None,
            idle_context,
        ) or ""
    )

    active_workspace = make_workspace(test_sandbox, "main-run-active")
    await active_workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": WORKFLOW_ID,
            "generation": GENERATION,
            "workflow_name": "Cognitive report",
            "workflow_input": UserInput(text="Create the report"),
            "stage": "execute",
            "step_index": 0,
        },
    )
    active_context = AmphiContext(
        session=make_session(active_workspace.session_root),
        workflows=workflows,
        workspace=active_workspace,
    )

    # Check 2: An unfinished Run blocks replacement starts and permits only its own resume request.
    assert "already owns an unfinished Run" in (
        await worker.legality_check(
            tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="start"),
            None,
            active_context,
        ) or ""
    )
    assert "must target the unfinished Workflow" in (
        await worker.legality_check(
            tool_call("request_run_workflow", workflow_id="other", action="resume"),
            None,
            active_context,
        ) or ""
    )
    assert await worker.legality_check(
        tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="resume"),
        None,
        active_context,
    ) is None

    reported = AmphiOTAContext(
        user_input="Run the report",
        ota_record=[OTARecord(action_result=ActionResult(results=[ActionStepResult(
            tool_id="call-report",
            tool_name="report_workflow_step",
            tool_arguments={"status": "success", "summary": "Report created"},
            tool_result="Report created",
        )]))],
    )

    # Check 3: A Turn that already reported Workflow work cannot launch the Workflow again.
    assert "already ran the Workflow" in (
        await worker.legality_check(
            tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="resume"),
            reported,
            active_context,
        ) or ""
    )


async def test_run_gate(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final active Workflow controls:

    {
      "execute_section": {"report": "allowed", "stage_jump": "blocked"},
      "run_request": {"second_start": "blocked", "matching_resume": "allowed"},
      "completion_boundary": {"report": "blocked"},
      "cursor_mismatch": "all_workflow_controls_blocked"
    }

    Checks:
    1. Execute accepts a section report and only allows an explicit exit to normal mode.
    2. The active stage rejects another start while allowing a resume of the same Workflow.
    3. A completion boundary cannot be reported as another source section.
    4. A cognitive cursor that disagrees with `.run/.state.json` rejects Workflow control.
    """
    source_root = test_sandbox.root / "run-source"
    source_root.mkdir()
    for name, body in {
        "task.md": "# Report task\n",
        "explore.md": "# Report plan\n",
        "verify.md": "# Verification\n\n## Overall verdict\nPASS\n",
    }.items():
        (source_root / name).write_text(body, encoding="utf-8")
    write_workflow_source(source_root)

    workspace = make_workspace(test_sandbox, "workflow-run")
    workflow_runs = WorkflowRunLibrary(USER_ID)

    def populate(root: Path) -> None:
        workflow_runs.populate_run_workflow(root, source_root)

    run_space = await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": WORKFLOW_ID,
            "generation": GENERATION,
            "workflow_name": "Cognitive report",
            "workflow_input": UserInput(text="Create the report"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=populate,
    )
    run = workflow_runs.open_run_workflow(run_space.root)
    workflows = WorkflowLibrary(USER_ID)
    workflows.open_package(
        run.source_dir,
        workflow_id=WORKFLOW_ID,
        name="Cognitive report",
        validate=True,
    )

    def source(workflow_id: str) -> object:
        if workflow_id != WORKFLOW_ID:
            raise ValueError(f"Workflow `{workflow_id}` is unavailable")
        return object()

    monkeypatch.setattr(workflows, "source", source)
    context = AmphiContext(
        session=make_session(workspace.session_root),
        workflows=workflows,
        workflow_runs=workflow_runs,
        workspace=workspace,
    )

    def ota(stage: str, step_index: int, generation: str = GENERATION) -> AmphiOTAContext:
        return AmphiOTAContext(
            user_input="Create the report",
            state={
                "think": {
                    "mode": "run_workflow",
                    "stage": stage,
                    "workflow_id": WORKFLOW_ID,
                    "generation": generation,
                    "step_index": step_index,
                }
            },
        )

    execute = WorkflowThink()
    execute_ota = ota("execute", 0)
    report = tool_call("report_workflow_step")

    # Check 1: Execute accepts a section report and only allows an explicit exit to normal mode.
    assert await execute.legality_check(report, execute_ota, context) is None
    assert "advance automatically" in (
        await execute.legality_check(
            tool_call("switch", mode="run_workflow", stage="execute"),
            execute_ota,
            context,
        ) or ""
    )
    assert await execute.legality_check(
        tool_call("switch", mode="normal"),
        execute_ota,
        context,
    ) is None

    # Check 2: The active stage rejects another start while allowing a resume of the same Workflow.
    assert "already owns an unfinished Run" in (
        await execute.legality_check(
            tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="start"),
            execute_ota,
            context,
        ) or ""
    )
    assert await execute.legality_check(
        tool_call("request_run_workflow", workflow_id=WORKFLOW_ID, action="resume"),
        execute_ota,
        context,
    ) is None

    run_space.checkpoint_cursor(
        expected_workflow_id=WORKFLOW_ID,
        expected_generation=GENERATION,
        expected_stage="execute",
        expected_step_index=0,
        stage="execute",
        step_index=1,
    )

    # Check 3: A completion boundary cannot be reported as another source section.
    assert "current section does not exist" in (
        await execute.legality_check(report, ota("execute", 1), context) or ""
    )

    # Check 4: A cognitive cursor that disagrees with `.run/.state.json` rejects Workflow control.
    assert "does not match" in (
        await execute.legality_check(report, ota("execute", 1, "stale-generation"), context) or ""
    )
