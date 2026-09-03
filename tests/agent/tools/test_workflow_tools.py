import json
from pathlib import Path

import pytest

from src.amphi_agent.tools._workflow import (
    WorkflowToolRejection,
    edit_workflow,
    list_workflow_runs,
    read_workflow_run,
    remove_workflow,
    report_workflow_step,
)
from src.amphi_store import UserInput, WorkflowRunStatus
from tests.agent.tools._harness import ToolHarness


async def test_workflow_definition(tool_harness: ToolHarness) -> None:
    """Final Workflow catalogue:

    {
      "imported": "Daily Report",
      "edit_request": "same workflow id",
      "after_remove": [],
      "saved_source": "removed",
      "published_run": "retained"
    }

    Checks:
    1. A valid portable source becomes one saved Workflow in the Agent catalogue.
    2. Edit validates the saved source and returns its stable identity to the runtime.
    3. Remove deletes the Workflow definition while retaining an already published Run result.
    4. Missing and blank Workflow identities are rejected with no catalogue mutation.
    """
    def write_workflow_source(root: Path) -> None:
        root.mkdir(parents=True)
        (root / "task.md").write_text("# Task\n\nPrepare a daily report.\n", encoding="utf-8")
        (root / "explore.md").write_text("# Explore\n\nUse local report data.\n", encoding="utf-8")
        (root / "verify.md").write_text("# Verify\n\nReview the published report.\n", encoding="utf-8")
        workflow = root / "workflow"
        workflow.mkdir()
        (workflow / "WORKFLOW.md").write_text(
            "---\nname: daily-report\ndescription: Prepare a daily report\n---\n"
            "# 1. Prepare report\n\nCreate the requested report.\n",
            encoding="utf-8",
        )
    source = tool_harness.paths.root / "workflow-source"
    write_workflow_source(source)
    package = await tool_harness.context.workflows.import_workflow(
        source,
        name="Daily Report",
        description="Prepare a daily report",
        domain="reporting",
    )
    workflow_id = package.workflow_id
    assert workflow_id is not None

    # Check 1: A valid portable source becomes one saved Workflow in the Agent catalogue.
    assert tool_harness.context.workflows.get(workflow_id) == package
    assert package.is_available

    # Check 2: Edit validates the saved source and returns its stable identity to the runtime.
    request = await edit_workflow(f" {workflow_id} ")
    assert request.workflow_id == workflow_id

    published = tool_harness.paths.root / "definition-result"
    (published / "result").mkdir(parents=True)
    (published / "background" / "work").mkdir(parents=True)
    (published / "result" / "report.md").write_text("Retained result\n", encoding="utf-8")
    run = await tool_harness.context.workflow_runs.publish(
        published,
        result_id="definition-run",
        workflow_id=workflow_id,
        workflow_name="Daily Report",
        source_session_id="session-tools",
        workflow_input=UserInput(text="Prepare today"),
        status=WorkflowRunStatus.COMPLETED,
    )

    # Check 3: Removing a Workflow definition retains its already published Run result.
    confirmation = await remove_workflow(workflow_id)
    assert "Daily Report" in confirmation
    assert tool_harness.context.workflows.get(workflow_id) is None
    assert not package.root.exists()
    assert await read_workflow_run(run.run_id, "result/report.md") == "Retained result\n"
    assert run.root.exists()

    # Check 4: Missing and blank Workflow identities are rejected with no catalogue mutation.
    with pytest.raises(WorkflowToolRejection, match="must be non-empty"):
        await edit_workflow(" ")
    with pytest.raises(WorkflowToolRejection, match="unavailable"):
        await remove_workflow(workflow_id)
    assert tool_harness.context.workflows.is_empty()


async def test_step_report() -> None:
    """Final Workflow section report:

    {
      "status": "success",
      "summary": "Report generated",
      "evidence": ["result/report.md", "pytest passed"]
    }

    Checks:
    1. The report trims its summary and removes blank evidence entries.
    2. Failure remains an explicit terminal status rather than being rewritten.
    3. A blank summary is rejected because it cannot explain the section outcome.
    """
    # Check 1: The report trims its summary and removes blank evidence entries.
    success = await report_workflow_step(
        "success",
        "  Report generated  ",
        [" result/report.md ", "", " pytest passed "],
    )
    assert (success.status, success.summary) == ("success", "Report generated")
    assert success.evidence == ["result/report.md", "pytest passed"]

    # Check 2: Failure remains an explicit terminal status rather than being rewritten.
    failure = await report_workflow_step("failure", "Source data is unavailable")
    assert (failure.status, failure.summary, failure.evidence) == (
        "failure",
        "Source data is unavailable",
        [],
    )

    # Check 3: A blank summary is rejected because it cannot explain the section outcome.
    with pytest.raises(WorkflowToolRejection, match="summary.*non-empty"):
        await report_workflow_step("success", " ")


async def test_workflow_results(tool_harness: ToolHarness) -> None:
    """Final published Workflow result:

    {
      "status": "completed",
      "files": ["result/report.md", "background/work/notes.txt"],
      "report": "Published report"
    }

    Checks:
    1. A terminal Run published by the real library appears in the tool's JSON result list.
    2. Reading without a path returns stable Run metadata and original structured input.
    3. Reading an advertised path returns its exact UTF-8 content.
    4. Unknown Runs and paths outside the published result are rejected.
    """
    published = tool_harness.paths.root / "published-source"
    (published / "result").mkdir(parents=True)
    (published / "background" / "work").mkdir(parents=True)
    (published / "result" / "report.md").write_text("Published report\n", encoding="utf-8")
    (published / "background" / "work" / "notes.txt").write_text("Working notes\n", encoding="utf-8")
    run = await tool_harness.context.workflow_runs.publish(
        published,
        result_id="run-tools",
        workflow_id="workflow-tools",
        workflow_name="Daily Report",
        source_session_id="session-tools",
        workflow_input=UserInput(text="Prepare today"),
        status=WorkflowRunStatus.COMPLETED,
    )

    # Check 1: A terminal Run published by the real library appears in the tool's JSON result list.
    listed = json.loads(await list_workflow_runs(workflow_id="workflow-tools"))
    assert len(listed) == 1
    assert listed[0]["run_id"] == run.run_id
    assert listed[0]["files"] == ["result/report.md", "background/work/notes.txt"]

    # Check 2: Reading without a path returns stable Run metadata and original structured input.
    detail = json.loads(await read_workflow_run(run.run_id))
    assert detail["status"] == "completed"
    assert detail["workflow_input"]["text"] == "Prepare today"

    # Check 3: Reading an advertised path returns its exact UTF-8 content.
    assert await read_workflow_run(run.run_id, "result/report.md") == "Published report\n"

    # Check 4: Unknown Runs and paths outside the published result are rejected.
    with pytest.raises(WorkflowToolRejection, match="unavailable"):
        await read_workflow_run("missing-run")
    with pytest.raises(ValueError, match="stay inside"):
        await read_workflow_run(run.run_id, "../secret.txt")
