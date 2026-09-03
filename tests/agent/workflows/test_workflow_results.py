import os
from datetime import datetime, timezone

import pytest

from src.amphi_agent._workflow_run import WorkflowRun, WorkflowRunLibrary
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    UserInput,
    WorkflowRunStatus,
)
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
WINDOWS_ERROR_PRIVILEGE_NOT_HELD = 1314


async def test_result_contract(test_sandbox: IsolatedPaths, workflow_store: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final published Workflow results:

    {
      "completed": {
        "stable_id": true,
        "files": ["result/report.md", "background/work/notes.txt"]
      },
      "references": {
        "duplicates": "collapsed",
        "completed": "accepted",
        "failed_or_missing": "rejected"
      }
    }

    Checks:
    1. Publishing the same terminal attempt twice retains one stable result and artifact tree.
    2. Only explicit result and background/work files are visible and readable.
    3. Structured WorkflowRun mentions are deduplicated without accepting other mention groups.
    4. Completed references load successfully while failed or missing results block composition.
    5. References from historical inputs load even when absent from the recent-result cache.
    """
    def create_source(name: str, report: str):
        root = test_sandbox.root / name
        (root / "result").mkdir(parents=True)
        (root / "background" / "work").mkdir(parents=True)
        (root / "source").mkdir()
        (root / "result" / "report.md").write_text(report, encoding="utf-8")
        (root / "background" / "work" / "notes.txt").write_text("draft notes\n", encoding="utf-8")
        (root / "source" / "private.md").write_text("private source\n", encoding="utf-8")
        return root

    sessions = SessionRepository()
    await sessions.save(SessionRecord(
        id="session-source",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "session-source"),
    ))
    library = WorkflowRunLibrary(USER_ID)
    completed_id = library.terminal_result_id("session-source", "generation-completed")
    completed_source = create_source("completed-source", "final report\n")
    arguments = {
        "result_id": completed_id,
        "workflow_id": "workflow-report",
        "workflow_name": "Report Workflow",
        "source_session_id": "session-source",
        "workflow_input": UserInput(text="Create the report"),
        "status": WorkflowRunStatus.COMPLETED,
    }

    # Check 1: An identical publication retry converges on one durable result identity.
    completed = await library.publish(completed_source, **arguments)
    retried = await library.publish(completed_source, **arguments)
    assert retried.run_id == completed.run_id == completed_id
    assert retried.root == completed.root
    assert retried.root.is_dir()

    # Check 2: Publication exposes only final and intermediate-work files.
    assert completed.result_files == ("result/report.md",)
    assert completed.work_files == ("background/work/notes.txt",)
    assert completed.files == (
        "result/report.md",
        "background/work/notes.txt",
    )
    assert completed.read_file("result/report.md") == "final report\n"
    assert completed.read_file("background/work/notes.txt") == "draft notes\n"
    with pytest.raises(FileNotFoundError):
        completed.read_file("source/private.md")
    with pytest.raises(ValueError, match="inside a published directory"):
        completed.read_file("../private.md")

    mentions = UserInput(
        text="Use prior results",
        blocks=[
            {"type": "mention", "group": "WorkflowRun", "id": completed_id},
            {"type": "mention", "group": "WorkflowRun", "id": completed_id},
            {"type": "mention", "group": "Workflow", "id": "workflow-report"},
        ],
    )

    # Check 3: Only unique WorkflowRun mention identities enter the reference contract.
    assert library.referenced_run_ids(mentions) == (completed_id,)
    assert [run.run_id for run in await library.load_referenced(mentions)] == [completed_id]

    failed_id = library.terminal_result_id("session-source", "generation-failed")
    await library.publish(
        create_source("failed-source", "partial report\n"),
        result_id=failed_id,
        workflow_id="workflow-report",
        workflow_name="Report Workflow",
        source_session_id="session-source",
        workflow_input=UserInput(text="Create the report"),
        status=WorkflowRunStatus.FAILED,
    )

    # Check 4: Composition accepts complete results and rejects unavailable outcomes.
    resolved = await library.require_completed_references(mentions)
    assert [run.run_id for run in resolved] == [completed_id]
    with pytest.raises(ValueError, match="unavailable or incomplete"):
        await library.require_completed_references(UserInput(
            text="Use failed result",
            blocks=[{"type": "mention", "group": "WorkflowRun", "id": failed_id}],
        ))
    with pytest.raises(ValueError, match="unavailable or incomplete"):
        await library.require_completed_references(UserInput(
            text="Use missing result",
            blocks=[{"type": "mention", "group": "WorkflowRun", "id": "missing-run"}],
        ))

    # Check 5: Every supplied input contributes owner-gated references beyond the recent cache.
    async def no_recent_results(user_id: str, *, limit: int = 50, offset: int = 0):
        return []

    historical_library = WorkflowRunLibrary(USER_ID)
    monkeypatch.setattr(historical_library._repo, "list_for_user", no_recent_results)
    await historical_library.load(UserInput(text="Current request"), mentions)
    assert historical_library.get(completed_id) is not None


def test_result_links(test_sandbox: IsolatedPaths) -> None:
    """Final published-file boundary:

    {
      "regular_file": "visible",
      "result_symlink": "hidden and unreadable",
      "work_symlink": "hidden and unreadable"
    }

    Checks:
    1. Safe regular files remain visible in a published result.
    2. File and directory symlinks cannot enter listings or resolve through read_file.
    """
    run_id = "run-links"
    workflow_id = "workflow-links"
    root = WorkflowRun.managed_root(workflow_id, run_id)
    result = root / "result"
    work = root / "background" / "work"
    result.mkdir(parents=True)
    work.mkdir(parents=True)
    outside_file = test_sandbox.root / "secret.txt"
    outside_dir = test_sandbox.root / "private"
    outside_file.write_text("secret\n", encoding="utf-8")
    outside_dir.mkdir()
    (outside_dir / "notes.txt").write_text("private notes\n", encoding="utf-8")
    (result / "report.md").write_text("safe report\n", encoding="utf-8")
    try:
        (result / "secret-link.md").symlink_to(outside_file)
        (work / "private-link").symlink_to(outside_dir, target_is_directory=True)
    except OSError as exc:
        if (
            os.name == "nt"
            and getattr(exc, "winerror", None) == WINDOWS_ERROR_PRIVILEGE_NOT_HELD
        ):
            pytest.skip(f"Windows symlink privileges are unavailable: {exc}")
        raise
    run = WorkflowRun(
        run_id=run_id,
        workflow_id=workflow_id,
        workflow_name="Linked result",
        source_session_id="session-source",
        root=root,
        status=WorkflowRunStatus.COMPLETED,
        created_at=datetime.now(timezone.utc),
        workflow_input=UserInput(text="Create linked result"),
    )

    # Check 1: The ordinary result remains listed and readable.
    assert run.result_files == ("result/report.md",)
    assert run.read_file("result/report.md") == "safe report\n"

    # Check 2: Neither kind of symlink becomes a published file surface.
    assert "result/secret-link.md" not in run.files
    assert not any("private-link" in path for path in run.files)
    with pytest.raises(FileNotFoundError):
        run.read_file("result/secret-link.md")
    with pytest.raises(FileNotFoundError):
        run.read_file("background/work/private-link/notes.txt")
