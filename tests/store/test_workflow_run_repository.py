import asyncio
import re

import pytest
from sqlalchemy.exc import IntegrityError

from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    UserInput,
    WorkflowRun,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


USER_ID = "local"


async def _create_sessions(*session_ids: str) -> None:
    """Persist local Sessions required by Workflow Run associations."""
    repository = SessionRepository()
    for session_id in session_ids:
        await repository.save(
            SessionRecord(
                id=session_id,
                user_id=USER_ID,
                workspace_root=f"/workspace/{session_id}",
            )
        )


async def _publish_run(
    repository: WorkflowRunRepository,
    run_id: str,
    workflow_id: str,
    workflow_name: str,
    source_session_id: str,
    input_text: str,
    *,
    status: WorkflowRunStatus = WorkflowRunStatus.COMPLETED,
    validation_status: WorkflowValidationStatus = WorkflowValidationStatus.NOT_REQUIRED,
    blocks: list[dict] | None = None,
) -> WorkflowRun:
    """Publish one terminal Run through the public repository API."""
    run, _ = await repository.create_or_confirm_terminal(
        USER_ID,
        result_id=run_id,
        workflow_id=workflow_id,
        workflow_name=workflow_name,
        source_session_id=source_session_id,
        result_dir=f"/results/{run_id}",
        workflow_input=UserInput(text=input_text, blocks=blocks or []),
        status=status,
        validation_status=validation_status,
    )
    return run


async def test_publish_retry(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": [
        {
          "id": "<generated wfr id>",
          "workflow_id": "workflow-report",
          "workflow_name": "Generate report",
          "source_session_id": "source-session",
          "workflow_input": {
            "text": "Generate the weekly report",
            "blocks": [{"type": "mention", "id": "source-data"}]
          },
          "status": "completed",
          "validation_status": "not_required",
          "created_at": "<terminal timestamp>",
          "finished_at": "<same terminal timestamp>"
        }
      ],
      "session_workflow_runs": [
        {"session_id": "source-session", "run_id": "<generated wfr id>"}
      ]
    }

    Checks:
    1. Generated Run ids use the stable public prefix and random hexadecimal suffix.
    2. Concurrent identical publications create one terminal row and confirm one retry.
    3. The stored Run preserves its structured input, outcome, timestamps, and source association.
    4. Reusing the id with different result data fails without changing the original Run.
    """
    await _create_sessions("source-session")
    repository = WorkflowRunRepository()

    # Check 1: Generated Run ids use the stable public prefix and random hexadecimal suffix.
    run_id = repository.new_id()
    next_run_id = repository.new_id()
    assert re.fullmatch(r"wfr_[0-9a-f]{16}", run_id)
    assert run_id != next_run_id

    arguments = {
        "result_id": run_id,
        "workflow_id": "workflow-report",
        "workflow_name": "Generate report",
        "source_session_id": "source-session",
        "result_dir": f"/results/{run_id}",
        "workflow_input": UserInput(
            text="Generate the weekly report",
            blocks=[{"type": "mention", "id": "source-data"}],
        ),
        "status": WorkflowRunStatus.COMPLETED,
        "validation_status": WorkflowValidationStatus.NOT_REQUIRED,
    }

    # Check 2: Concurrent identical publications create one terminal row and confirm one retry.
    results = await asyncio.gather(
        repository.create_or_confirm_terminal(USER_ID, **arguments),
        WorkflowRunRepository().create_or_confirm_terminal(USER_ID, **arguments),
    )
    assert sorted(was_created for _, was_created in results) == [False, True]
    assert {run.id for run, _ in results} == {run_id}
    assert [run.id for run in await repository.list_for_user(USER_ID)] == [run_id]

    # Check 3: The stored Run preserves its structured input, outcome, timestamps, and source association.
    loaded = await repository.get(USER_ID, run_id)
    source_runs = await repository.list_for_session(USER_ID, "source-session")
    assert loaded is not None
    assert loaded.workflow_id == "workflow-report"
    assert loaded.workflow_name == "Generate report"
    assert loaded.source_session_id == "source-session"
    assert loaded.workflow_input == arguments["workflow_input"]
    assert loaded.status is WorkflowRunStatus.COMPLETED
    assert loaded.validation_status is WorkflowValidationStatus.NOT_REQUIRED
    assert loaded.created_at == loaded.finished_at
    assert [run.id for run in source_runs] == [run_id]

    # Check 4: Reusing the id with different result data fails without changing the original Run.
    with pytest.raises(IntegrityError):
        await repository.create_or_confirm_terminal(
            USER_ID,
            **{**arguments, "workflow_name": "Conflicting report"},
        )
    unchanged = await repository.get(USER_ID, run_id)
    assert unchanged is not None
    assert unchanged.workflow_name == "Generate report"
    assert [run.id for run in await repository.list_for_user(USER_ID)] == [run_id]


async def test_outcome_rules(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": [
        {
          "id": "failed-run",
          "status": "failed",
          "validation_status": "failed",
          "finished_at": "<terminal timestamp>"
        }
      ]
    }

    Checks:
    1. Every storable Workflow Run status is both terminal and published.
    2. A completed result cannot record failed validation.
    3. A failed result cannot record passed validation.
    4. A failed result with failed validation is persisted normally.
    """
    await _create_sessions("source-session")
    repository = WorkflowRunRepository()

    # Check 1: Every storable Workflow Run status is both terminal and published.
    assert all(status.is_terminal for status in WorkflowRunStatus)
    assert all(status.is_published for status in WorkflowRunStatus)

    # Check 2: A completed result cannot record failed validation.
    with pytest.raises(ValueError, match="Completed Workflow results"):
        await _publish_run(
            repository,
            "invalid-completed",
            "workflow-report",
            "Generate report",
            "source-session",
            "Generate report",
            validation_status=WorkflowValidationStatus.FAILED,
        )
    assert await repository.get(USER_ID, "invalid-completed") is None

    # Check 3: A failed result cannot record passed validation.
    with pytest.raises(ValueError, match="Failed Workflow results"):
        await _publish_run(
            repository,
            "invalid-failed",
            "workflow-report",
            "Generate report",
            "source-session",
            "Generate report",
            status=WorkflowRunStatus.FAILED,
            validation_status=WorkflowValidationStatus.PASSED,
        )
    assert await repository.get(USER_ID, "invalid-failed") is None

    # Check 4: A failed result with failed validation is persisted normally.
    failed = await _publish_run(
        repository,
        "failed-run",
        "workflow-report",
        "Generate report",
        "source-session",
        "Generate report",
        status=WorkflowRunStatus.FAILED,
        validation_status=WorkflowValidationStatus.FAILED,
    )
    assert failed.status is WorkflowRunStatus.FAILED
    assert failed.validation_status is WorkflowValidationStatus.FAILED
    assert failed.finished_at is not None


async def test_lists(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": [
        {"id": "alpha-old", "workflow_id": "workflow-alpha", "source": "source-a"},
        {"id": "beta", "workflow_id": "workflow-beta", "source": "source-a"},
        {"id": "alpha-new", "workflow_id": "workflow-alpha", "source": "source-b"}
      ]
    }

    Checks:
    1. The user list returns both successful and failed results from newest to oldest.
    2. Limit and offset select the requested page without changing that order.
    3. Workflow listing returns only historical results for that Workflow.
    4. Source listing returns only results produced by that Session and supports a Workflow filter.
    """
    await _create_sessions("source-a", "source-b")
    repository = WorkflowRunRepository()
    alpha_old = await _publish_run(
        repository,
        "alpha-old",
        "workflow-alpha",
        "Alpha report",
        "source-a",
        "First alpha input",
    )
    beta = await _publish_run(
        repository,
        "beta",
        "workflow-beta",
        "Beta report",
        "source-a",
        "Beta input",
        status=WorkflowRunStatus.FAILED,
        validation_status=WorkflowValidationStatus.FAILED,
    )
    alpha_new = await _publish_run(
        repository,
        "alpha-new",
        "workflow-alpha",
        "Alpha report",
        "source-b",
        "Second alpha input",
        validation_status=WorkflowValidationStatus.PASSED,
    )

    # Check 1: The user list returns both successful and failed results from newest to oldest.
    listed = await repository.list_for_user(USER_ID)
    assert [run.id for run in listed] == [alpha_new.id, beta.id, alpha_old.id]
    assert [run.status for run in listed] == [
        WorkflowRunStatus.COMPLETED,
        WorkflowRunStatus.FAILED,
        WorkflowRunStatus.COMPLETED,
    ]

    # Check 2: Limit and offset select the requested page without changing that order.
    page = await repository.list_for_user(USER_ID, limit=1, offset=1)
    assert [run.id for run in page] == [beta.id]

    # Check 3: Workflow listing returns only historical results for that Workflow.
    alpha_runs = await repository.list_for_workflow(USER_ID, "workflow-alpha")
    assert [run.id for run in alpha_runs] == [alpha_new.id, alpha_old.id]

    # Check 4: Source listing returns only results produced by that Session and supports a Workflow filter.
    source_runs = await repository.list_for_source_session(USER_ID, "source-a")
    filtered_source_runs = await repository.list_for_source_session(
        USER_ID,
        "source-a",
        workflow_id="workflow-alpha",
    )
    assert [run.id for run in source_runs] == [beta.id, alpha_old.id]
    assert [run.id for run in filtered_source_runs] == [alpha_old.id]


async def test_associations(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": ["run-a", "run-b"],
      "session_workflow_runs": {
        "source-a": ["run-a"],
        "source-b": ["run-b"],
        "consumer": [],
        "copied-consumer": ["run-a", "run-b"]
      }
    }

    Checks:
    1. Publishing automatically associates each Run with its producing Session.
    2. A consumer Session can associate the same Run repeatedly without duplicates.
    3. Copying associations reports only newly created projections and preserves Workflow filtering.
    4. Missing Sessions and Runs cannot create or copy associations.
    5. Dissociation removes only one Session's projections and leaves global Runs available.
    """
    await _create_sessions("source-a", "source-b", "consumer", "copied-consumer")
    repository = WorkflowRunRepository()
    run_a = await _publish_run(
        repository,
        "run-a",
        "workflow-a",
        "Workflow A",
        "source-a",
        "Run A",
    )
    run_b = await _publish_run(
        repository,
        "run-b",
        "workflow-b",
        "Workflow B",
        "source-b",
        "Run B",
    )

    # Check 1: Publishing automatically associates each Run with its producing Session.
    assert [run.id for run in await repository.list_for_session(USER_ID, "source-a")] == [run_a.id]
    assert [run.id for run in await repository.list_for_session(USER_ID, "source-b")] == [run_b.id]

    # Check 2: A consumer Session can associate the same Run repeatedly without duplicates.
    assert await repository.associate_session(USER_ID, "consumer", run_a.id) is True
    assert await repository.associate_session(USER_ID, "consumer", run_a.id) is True
    assert await repository.associate_session(USER_ID, "consumer", run_b.id) is True
    consumer_runs = await repository.list_for_session(USER_ID, "consumer")
    assert [run.id for run in consumer_runs] == [run_b.id, run_a.id]

    # Check 3: Copying associations reports only newly created projections and preserves Workflow filtering.
    copied = await repository.copy_session_associations(
        USER_ID,
        "consumer",
        "copied-consumer",
    )
    copied_again = await repository.copy_session_associations(
        USER_ID,
        "consumer",
        "copied-consumer",
    )
    copied_workflow = await repository.list_for_session(
        USER_ID,
        "copied-consumer",
        workflow_id="workflow-a",
    )
    assert copied == 2
    assert copied_again == 0
    assert [run.id for run in copied_workflow] == [run_a.id]

    # Check 4: Missing Sessions and Runs cannot create or copy associations.
    assert await repository.associate_session(USER_ID, "missing", run_a.id) is False
    assert await repository.associate_session(USER_ID, "consumer", "missing") is False
    assert await repository.copy_session_associations(
        USER_ID,
        "missing",
        "copied-consumer",
    ) == 0

    # Check 5: Dissociation removes only one Session's projections and leaves global Runs available.
    await repository.dissociate_session(USER_ID, "consumer")
    assert await repository.list_for_session(USER_ID, "consumer") == []
    assert [run.id for run in await repository.list_for_session(USER_ID, "source-a")] == [run_a.id]
    assert {run.id for run in await repository.list_for_session(USER_ID, "copied-consumer")} == {
        run_a.id,
        run_b.id,
    }
    assert await repository.get(USER_ID, run_a.id) is not None
    assert await repository.get(USER_ID, run_b.id) is not None


async def test_search(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": [
        {"id": "wfr-quarterly", "source": "source-a", "input_tag": "Finance-Tag"},
        {"id": "wfr-inventory", "source": "source-b"},
        {"id": "wfr-quarterly-backup", "source": "source-b"}
      ],
      "session_workflow_runs": {
        "consumer": ["wfr-quarterly"]
      }
    }

    Checks:
    1. Search matches Run ids, names, and serialized structured input without case sensitivity.
    2. Workflow and source filters narrow matches before results are returned.
    3. Session filtering follows associations while source filtering follows the producing Session.
    4. A blank query delegates to the matching list view.
    5. Search applies pagination after matching all eligible Runs.
    """
    await _create_sessions("source-a", "source-b", "consumer")
    repository = WorkflowRunRepository()
    quarterly = await _publish_run(
        repository,
        "wfr-quarterly",
        "workflow-report",
        "Quarterly Revenue",
        "source-a",
        "Build the APAC summary",
        blocks=[{"type": "tag", "label": "Finance-Tag"}],
    )
    inventory = await _publish_run(
        repository,
        "wfr-inventory",
        "workflow-inventory",
        "Inventory Audit",
        "source-b",
        "Count warehouse stock",
    )
    backup = await _publish_run(
        repository,
        "wfr-quarterly-backup",
        "workflow-report",
        "Quarterly Backup",
        "source-b",
        "Build the EMEA summary",
    )
    await repository.associate_session(USER_ID, "consumer", quarterly.id)

    # Check 1: Search matches Run ids, names, and serialized structured input without case sensitivity.
    by_id = await repository.search(USER_ID, "WFR-INVENTORY")
    by_name = await repository.search(USER_ID, "quarterly")
    by_block = await repository.search(USER_ID, "finance-tag")
    assert [run.id for run in by_id] == [inventory.id]
    assert [run.id for run in by_name] == [backup.id, quarterly.id]
    assert [run.id for run in by_block] == [quarterly.id]

    # Check 2: Workflow and source filters narrow matches before results are returned.
    filtered = await repository.search(
        USER_ID,
        "quarterly",
        workflow_id="workflow-report",
        source_session_id="source-b",
    )
    assert [run.id for run in filtered] == [backup.id]

    # Check 3: Session filtering follows associations while source filtering follows the producing Session.
    associated = await repository.search(USER_ID, "finance-tag", session_id="consumer")
    produced = await repository.search(
        USER_ID,
        "finance-tag",
        source_session_id="consumer",
    )
    missing_session = await repository.search(USER_ID, "quarterly", session_id="missing")
    assert [run.id for run in associated] == [quarterly.id]
    assert produced == []
    assert missing_session == []

    # Check 4: A blank query delegates to the matching list view.
    blank = await repository.search(USER_ID, "   ", session_id="consumer")
    assert [run.id for run in blank] == [quarterly.id]

    # Check 5: Search applies pagination after matching all eligible Runs.
    page = await repository.search(USER_ID, "quarterly", limit=1, offset=1)
    assert [run.id for run in page] == [quarterly.id]


async def test_delete(initialized_store: None) -> None:
    """Final database state:

    {
      "workflow_runs": [
        {"id": "keep-run", "source_session_id": "source-session"}
      ],
      "session_workflow_runs": {
        "source-session": ["keep-run"],
        "consumer": []
      }
    }

    Checks:
    1. Deleting a Run removes the global row and all of its Session projections.
    2. Deletion leaves unrelated Workflow Runs and their source projections intact.
    3. Deleting the same or an unknown Run again reports that nothing changed.
    """
    await _create_sessions("source-session", "consumer")
    repository = WorkflowRunRepository()
    deleted_run = await _publish_run(
        repository,
        "delete-run",
        "workflow-delete",
        "Disposable result",
        "source-session",
        "Disposable input",
    )
    kept_run = await _publish_run(
        repository,
        "keep-run",
        "workflow-keep",
        "Kept result",
        "source-session",
        "Kept input",
    )
    await repository.associate_session(USER_ID, "consumer", deleted_run.id)

    # Check 1: Deleting a Run removes the global row and all of its Session projections.
    assert await repository.delete(USER_ID, deleted_run.id) is True
    assert await repository.get(USER_ID, deleted_run.id) is None
    assert await repository.list_for_session(USER_ID, "consumer") == []
    assert deleted_run.id not in {
        run.id for run in await repository.list_for_session(USER_ID, "source-session")
    }

    # Check 2: Deletion leaves unrelated Workflow Runs and their source projections intact.
    assert [run.id for run in await repository.list_for_user(USER_ID)] == [kept_run.id]
    assert [run.id for run in await repository.list_for_session(USER_ID, "source-session")] == [
        kept_run.id
    ]

    # Check 3: Deleting the same or an unknown Run again reports that nothing changed.
    assert await repository.delete(USER_ID, deleted_run.id) is False
    assert await repository.delete(USER_ID, "missing-run") is False
