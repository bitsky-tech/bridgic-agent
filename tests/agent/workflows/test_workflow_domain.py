from pathlib import Path

import pytest

from src.amphi_agent import WorkflowLibrary, WorkflowPackage
from src.amphi_agent._workflow_run import RunWorkflow
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    WorkflowRepository,
)
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"


def _write_package(root: Path, marker: str) -> None:
    root.mkdir(parents=True)
    (root / "task.md").write_text(f"# Task\n\n{marker} task.\n", encoding="utf-8")
    (root / "explore.md").write_text(f"# Explore\n\n{marker} inputs.\n", encoding="utf-8")
    (root / "verify.md").write_text(f"# Verify\n\n{marker} output.\n", encoding="utf-8")
    workflow = root / "workflow"
    workflow.mkdir()
    (workflow / "WORKFLOW.md").write_text(
        "---\nname: daily-report\ndescription: Prepare a daily report\n---\n"
        f"# Collect inputs\n\n{marker} collection.\n\n"
        f"# Publish report\n\n{marker} publication.\n",
        encoding="utf-8",
    )


def test_package(test_sandbox: IsolatedPaths) -> None:
    """Final Workflow package contracts:

    {
      "valid": {"execution_steps": 2},
      "missing_script": "rejected before use",
      "local_environment": "rejected before use"
    }

    Checks:
    1. A complete package needs only WORKFLOW.md and exposes ordered execution sections.
    2. Package validation rejects a referenced script that is absent from the source tree.
    3. Package validation rejects a bundled dependency environment from the source tree.
    """
    root = test_sandbox.root / "package-contract"
    _write_package(root, "Initial")
    package = WorkflowPackage(root)

    # Check 1: A valid source has stable ordered execution sections.
    assert package.validation_reason() is None
    assert [step.title for step in package.execution_steps] == [
        "Collect inputs",
        "Publish report",
    ]
    assert [step.instruction for step in package.execution_steps] == [
        "Initial collection.",
        "Initial publication.",
    ]
    # Check 2: Package validation rejects a referenced script that is absent from the source tree.
    package.entry_path.write_text(
        package.entry_path.read_text(encoding="utf-8")
        + "\nRun `scripts/generate.py` for the final output.\n",
        encoding="utf-8",
    )
    reason = package.validation_reason()
    assert reason is not None
    assert "scripts/generate.py" in reason
    assert "does not exist" in reason

    # Check 3: A Workflow cannot capture a machine-local dependency environment.
    package.entry_path.write_text(
        package.entry_path.read_text(encoding="utf-8").replace(
            "\nRun `scripts/generate.py` for the final output.\n",
            "\n",
        ),
        encoding="utf-8",
    )
    (package.source_root / ".venv").mkdir()
    reason = package.validation_reason()
    assert reason is not None
    assert "local dependency environment" in reason


async def test_materialization(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch, workflow_store: None) -> None:
    """Final saved Workflow state:

    {
      "first_confirmation": {"definitions": 1, "content": "Version one"},
      "replayed_confirmation": "same workflow id",
      "edit": {"same workflow id": true, "content": "Version two"},
      "invalid_edit": "Version two preserved",
      "persistence_failure": "Version two restored"
    }

    Checks:
    1. A confirmed Build becomes one independent, saved Workflow package.
    2. Replaying the same source Turn returns that package without creating a duplicate.
    3. Editing replaces source content while retaining the Workflow identity.
    4. Invalid replacement source leaves the last valid saved package untouched.
    5. A Store failure rolls a valid filesystem replacement back to the saved package.
    """
    def documents(package: WorkflowPackage) -> dict[str, str]:
        paths = [
            package.root / "task.md",
            package.root / "explore.md",
            package.root / "verify.md",
            package.entry_path,
        ]
        return {
            path.relative_to(package.root).as_posix(): path.read_text(encoding="utf-8")
            for path in paths
        }

    first_source = test_sandbox.root / "build-one"
    second_source = test_sandbox.root / "build-two"
    third_source = test_sandbox.root / "build-three"
    invalid_source = test_sandbox.root / "build-invalid"
    _write_package(first_source, "Version one")
    _write_package(second_source, "Version two")
    _write_package(third_source, "Version three")
    _write_package(invalid_source, "Broken")
    (invalid_source / "workflow" / "WORKFLOW.md").write_text("", encoding="utf-8")

    sessions = SessionRepository()
    await sessions.save(SessionRecord(
        id="session-build",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "session-build"),
    ))
    await sessions.save(SessionRecord(
        id="session-edit",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "session-edit"),
    ))
    library = await WorkflowLibrary(USER_ID).load()

    # Check 1: Confirmation copies Build output into one managed durable package.
    created = await library.materialize_workflow(
        first_source,
        workflow_id=None,
        source_session_id="session-build",
        source_turn_id="turn-confirm",
        name="Daily Report",
        description="Initial definition",
    )
    assert created.workflow_id is not None
    assert created.root != first_source
    assert created.is_available
    assert "Version one publication." in created.entry_path.read_text(encoding="utf-8")
    assert {path.name for path in created.source_root.iterdir()} == {"WORKFLOW.md"}
    assert tuple(library.data()) == (created.workflow_id,)

    # Check 2: Replaying one confirmation resolves the existing durable identity.
    replayed = await library.materialize_workflow(
        first_source,
        workflow_id=None,
        source_session_id="session-build",
        source_turn_id="turn-confirm",
        name="Daily Report",
        description="Initial definition",
    )
    assert replayed.workflow_id == created.workflow_id
    assert replayed.root == created.root
    assert len(library.data()) == 1

    # Check 3: An edit atomically changes source while retaining identity and location.
    edited = await library.materialize_workflow(
        second_source,
        workflow_id=created.workflow_id,
        source_session_id="session-edit",
        source_turn_id="turn-edit",
        name="Daily Report",
        description="Updated definition",
    )
    assert edited.workflow_id == created.workflow_id
    assert edited.root == created.root
    assert edited.description == "Updated definition"
    assert "Version two publication." in edited.entry_path.read_text(encoding="utf-8")
    version_two_documents = documents(edited)

    # Check 4: Rejected source cannot replace the last valid package in Store, memory, or files.
    with pytest.raises(ValueError, match="WORKFLOW.md is empty"):
        await library.materialize_workflow(
            invalid_source,
            workflow_id=created.workflow_id,
            source_session_id="session-edit",
            source_turn_id="turn-broken",
            name="Daily Report",
            description="Broken definition",
        )
    current = library.get(created.workflow_id)
    assert current is not None
    assert current.description == "Updated definition"
    assert documents(current) == version_two_documents
    reloaded = await WorkflowLibrary(USER_ID).load()
    durable = reloaded.get(created.workflow_id)
    assert durable is not None
    assert durable.description == "Updated definition"
    assert documents(durable) == version_two_documents

    async def fail_update(*args, **kwargs):
        raise RuntimeError("Store update failed")

    monkeypatch.setattr(WorkflowRepository, "update_content", fail_update)

    # Check 5: Persistence failure restores the complete prior source and metadata.
    with pytest.raises(RuntimeError, match="Store update failed"):
        await library.materialize_workflow(
            third_source,
            workflow_id=created.workflow_id,
            source_session_id="session-edit",
            source_turn_id="turn-store-failure",
            name="Daily Report",
            description="Version three definition",
        )
    current = library.get(created.workflow_id)
    assert current is not None
    assert current.description == "Updated definition"
    assert documents(current) == version_two_documents
    durable = (await WorkflowLibrary(USER_ID).load()).get(created.workflow_id)
    assert durable is not None
    assert durable.description == "Updated definition"
    assert documents(durable) == version_two_documents


def test_active_run(test_sandbox: IsolatedPaths) -> None:
    """Final active Workflow Run:

    {
      "artifacts": ["source", "result", "background/work"],
      "execution_step": {"status": "success", "writes": 1},
      "identical_replay": "idempotent",
      "validation_failure": {"terminal": true, "later_reports": "rejected"}
    }

    Checks:
    1. Preparing a Run creates an isolated source and writable artifact tree.
    2. A successful section report persists normalized summary and evidence once.
    3. An identical report is idempotent while conflicting content is rejected.
    4. A failure report becomes terminal and prevents later section reports.
    """
    source = test_sandbox.root / "run-source"
    root = test_sandbox.root / "active-run"
    _write_package(source, "Run")
    root.mkdir()

    # Check 1: Run preparation snapshots source and creates its owned output directories.
    run = RunWorkflow(root).prepare("create", source_root=source)
    assert run.is_available
    assert (run.source_dir / "workflow" / "WORKFLOW.md").is_file()
    assert run.result_dir.is_dir()
    assert run.background_work_dir.is_dir()
    source_entry = source / "workflow" / "WORKFLOW.md"
    source_entry.write_text("Changed after preparation\n", encoding="utf-8")
    assert "Run publication." in (run.source_dir / "workflow" / "WORKFLOW.md").read_text(
        encoding="utf-8",
    )

    # Check 2: One successful section writes a normalized durable execution report.
    summary = run.record_step(
        stage="execute",
        step_number=1,
        step_title="Collect inputs",
        status="success",
        summary="  Inputs collected  ",
        evidence=[" result/data.json ", "", " source checked "],
    )
    report = run.background_dir / "execution.md"
    first_report = report.read_text(encoding="utf-8")
    assert summary == "Inputs collected"
    assert "- Status: `success`" in first_report
    assert "- Summary: Inputs collected" in first_report
    assert "  - result/data.json" in first_report
    assert "  - source checked" in first_report

    # Check 3: A retry cannot duplicate or silently rewrite an already recorded section.
    assert run.record_step(
        stage="execute",
        step_number=1,
        step_title="Collect inputs",
        status="success",
        summary="Inputs collected",
        evidence=["result/data.json", "source checked"],
    ) == "Inputs collected"
    assert report.read_text(encoding="utf-8") == first_report
    with pytest.raises(RuntimeError, match="different content"):
        run.record_step(
            stage="execute",
            step_number=1,
            step_title="Collect inputs",
            status="success",
            summary="Different result",
        )
    assert report.read_text(encoding="utf-8") == first_report

    # Check 4: A failed execution section writes the terminal reason and blocks further progress.
    failure = run.record_step(
        stage="execute",
        step_number=2,
        step_title="Publish report",
        status="failure",
        summary="Required output is missing",
        evidence=["result/report.md absent"],
    )
    failure_path = run.result_dir / "failure.md"
    assert failure == "Required output is missing"
    assert "Required output is missing" in failure_path.read_text(encoding="utf-8")
    assert run.record_step(
        stage="execute",
        step_number=2,
        step_title="Publish report",
        status="failure",
        summary="Required output is missing",
        evidence=["result/report.md absent"],
    ) == "Required output is missing"
    with pytest.raises(RuntimeError, match="terminal failure report"):
        run.record_step(
            stage="execute",
            step_number=3,
            step_title="Archive report",
            status="success",
            summary="This must not be stored",
        )
