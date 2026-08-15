from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

from src.amphi_store import (
    Repository,
    SessionRecord,
    SessionRepository,
    SessionWorkflowRun,
    UserInput,
    WorkflowRun,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


@pytest.mark.parametrize(
    ("status", "validation_status"),
    [
        (WorkflowRunStatus.COMPLETED, WorkflowValidationStatus.PASSED),
        (WorkflowRunStatus.FAILED, WorkflowValidationStatus.FAILED),
    ],
)
async def test_create_or_confirm_terminal_is_idempotent(
    connected_repo: None,
    status: WorkflowRunStatus,
    validation_status: WorkflowValidationStatus,
) -> None:
    repository = WorkflowRunRepository()
    result_id = repository.new_id()
    arguments = {
        "result_id": result_id,
        "workflow_id": "wf-report",
        "workflow_name": "Generate report",
        "source_session_id": "session-1",
        "result_dir": f"/managed/results/wf-report/{result_id}",
        "workflow_input": UserInput(text="Generate this week's report"),
        "status": status,
        "validation_status": validation_status,
    }

    created, was_created = await repository.create_or_confirm_terminal(
        "user-1",
        **arguments,
    )
    confirmed, was_confirmed_created = await repository.create_or_confirm_terminal(
        "user-1",
        **arguments,
    )

    assert was_created
    assert not was_confirmed_created
    assert confirmed.id == created.id == result_id
    assert confirmed.created_at == created.created_at
    assert confirmed.finished_at == created.finished_at
    assert confirmed.status is status
    assert confirmed.validation_status is validation_status
    assert [row.id for row in await repository.list_for_user("user-1")] == [result_id]


async def test_create_or_confirm_terminal_rejects_conflicting_result(
    connected_repo: None,
) -> None:
    repository = WorkflowRunRepository()
    result_id = repository.new_id()
    arguments = {
        "result_id": result_id,
        "workflow_id": "wf-report",
        "workflow_name": "Generate report",
        "source_session_id": "session-1",
        "result_dir": f"/managed/results/wf-report/{result_id}",
        "workflow_input": UserInput(text="Generate this week's report"),
        "status": WorkflowRunStatus.COMPLETED,
        "validation_status": WorkflowValidationStatus.NOT_REQUIRED,
    }
    original, _ = await repository.create_or_confirm_terminal("user-1", **arguments)

    with pytest.raises(IntegrityError):
        await repository.create_or_confirm_terminal(
            "user-1",
            **{**arguments, "workflow_name": "Different result"},
        )

    persisted = await repository.get("user-1", result_id)
    assert persisted is not None
    assert persisted.workflow_name == original.workflow_name


async def test_create_or_confirm_terminal_is_safe_under_concurrent_retry(
    connected_repo: None,
) -> None:
    result_id = WorkflowRunRepository.new_id()
    arguments = {
        "result_id": result_id,
        "workflow_id": "wf-report",
        "workflow_name": "Generate report",
        "source_session_id": "session-1",
        "result_dir": f"/managed/results/wf-report/{result_id}",
        "workflow_input": UserInput(text="Generate this week's report"),
        "status": WorkflowRunStatus.COMPLETED,
        "validation_status": WorkflowValidationStatus.NOT_REQUIRED,
    }

    results = await asyncio.gather(
        WorkflowRunRepository().create_or_confirm_terminal("user-1", **arguments),
        WorkflowRunRepository().create_or_confirm_terminal("user-1", **arguments),
    )

    assert sorted(created for _, created in results) == [False, True]
    assert {row.id for row, _ in results} == {result_id}


async def test_create_or_confirm_terminal_preserves_unrelated_integrity_error(
    connected_repo: None,
) -> None:
    repository = WorkflowRunRepository()
    result_id = repository.new_id()
    arguments = {
        "result_id": result_id,
        "workflow_id": "wf-report",
        "workflow_name": "Generate report",
        "source_session_id": "session-1",
        "result_dir": f"/managed/results/wf-report/{result_id}",
        "workflow_input": UserInput(text="Generate this week's report"),
        "status": WorkflowRunStatus.COMPLETED,
        "validation_status": WorkflowValidationStatus.NOT_REQUIRED,
    }
    await repository.create_or_confirm_terminal("user-2", **arguments)

    with pytest.raises(IntegrityError):
        await repository.create_or_confirm_terminal("user-1", **arguments)


async def test_create_or_confirm_terminal_rejects_incomplete_terminal_row(
    connected_repo: None,
) -> None:
    repository = WorkflowRunRepository()
    result_id = repository.new_id()
    result_dir = f"/managed/results/wf-report/{result_id}"
    workflow_input = UserInput(text="Generate this week's report")
    async with repository._session() as session:
        session.add(WorkflowRun(
            id=result_id,
            user_id="user-1",
            workflow_id="wf-report",
            workflow_name="Generate report",
            source_session_id="session-1",
            workflow_input=workflow_input,
            status=WorkflowRunStatus.COMPLETED,
            validation_status=WorkflowValidationStatus.NOT_REQUIRED,
            run_dir=result_dir,
            finished_at=None,
        ))
        await session.commit()

    with pytest.raises(IntegrityError):
        await repository.create_or_confirm_terminal(
            "user-1",
            result_id=result_id,
            workflow_id="wf-report",
            workflow_name="Generate report",
            source_session_id="session-1",
            result_dir=result_dir,
            workflow_input=workflow_input,
            status=WorkflowRunStatus.COMPLETED,
            validation_status=WorkflowValidationStatus.NOT_REQUIRED,
        )


@pytest.mark.parametrize(
    ("status", "validation_status"),
    [
        (WorkflowRunStatus.COMPLETED, WorkflowValidationStatus.FAILED),
        (WorkflowRunStatus.FAILED, WorkflowValidationStatus.PASSED),
    ],
)
async def test_create_or_confirm_terminal_rejects_inconsistent_outcome(
    connected_repo: None,
    status: WorkflowRunStatus,
    validation_status: WorkflowValidationStatus,
) -> None:
    with pytest.raises(ValueError):
        await WorkflowRunRepository().create_or_confirm_terminal(
            "user-1",
            result_id=WorkflowRunRepository.new_id(),
            workflow_id="wf-report",
            workflow_name="Generate report",
            source_session_id="session-1",
            result_dir="/managed/results/wf-report/result",
            workflow_input=UserInput(text="Generate report"),
            status=status,
            validation_status=validation_status,
        )


async def test_session_associations_survive_session_copy_and_clean_up_explicitly(
    connected_repo: None,
    tmp_path,
) -> None:
    sessions = SessionRepository()
    source = SessionRecord(
        id="session-source",
        user_id="user-1",
        workspace_root=str(tmp_path / "source"),
    )
    consumer = SessionRecord(
        id="session-consumer",
        user_id="user-1",
        workspace_root=str(tmp_path / "consumer"),
    )
    copy = SessionRecord(
        id="session-copy",
        user_id="user-1",
        workspace_root=str(tmp_path / "copy"),
    )
    for record in (source, consumer, copy):
        await sessions.save(record)
    repository = WorkflowRunRepository()
    run, _ = await repository.create_or_confirm_terminal(
        "user-1",
        result_id=repository.new_id(),
        workflow_id="wf-report",
        workflow_name="Generate report",
        source_session_id=source.id,
        result_dir=str(tmp_path / "result"),
        workflow_input=UserInput(text="Generate report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    assert await repository.associate_session("user-1", consumer.id, run.id)
    assert await repository.copy_session_associations(
        "user-1", consumer.id, copy.id,
    ) == 1
    assert [row.id for row in await repository.list_for_session(
        "user-1", copy.id,
    )] == [run.id]

    assert await sessions.delete(consumer.id, "user-1")
    assert [row.id for row in await repository.list_for_session(
        "user-1", source.id,
    )] == [run.id]
    assert await repository.delete("user-1", run.id)
    assert await repository.list_for_session("user-1", source.id) == []
    assert await repository.list_for_session("user-1", copy.id) == []


async def test_schema_init_backfills_source_session_run_associations(
    connected_repo: None,
    tmp_path,
) -> None:
    source = SessionRecord(
        id="session-source",
        user_id="user-1",
        workspace_root=str(tmp_path / "source"),
    )
    await SessionRepository().save(source)
    repository = WorkflowRunRepository()
    run, _ = await repository.create_or_confirm_terminal(
        "user-1",
        result_id=repository.new_id(),
        workflow_id="wf-report",
        workflow_name="Generate report",
        source_session_id=source.id,
        result_dir=str(tmp_path / "result"),
        workflow_input=UserInput(text="Generate report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )
    async with repository._session() as session:
        await session.execute(delete(SessionWorkflowRun))
        await session.commit()
    assert await repository.list_for_session("user-1", source.id) == []

    await Repository.init_schema()

    assert [row.id for row in await repository.list_for_session(
        "user-1", source.id,
    )] == [run.id]
