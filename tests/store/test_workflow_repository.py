import asyncio

import pytest

from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    Workflow,
    WorkflowNameConflictError,
    WorkflowRepository,
)


USER_ID = "local"


async def _create_session(session_id: str) -> None:
    """Persist one local Session through its public repository API."""
    await SessionRepository().save(
        SessionRecord(
            id=session_id,
            user_id=USER_ID,
            workspace_root=f"/workspace/{session_id}",
        )
    )


async def _create_workflow(repository: WorkflowRepository, workflow_id: str, name: str) -> Workflow:
    """Persist one reusable local Workflow through the public create API."""
    return await repository.create(
        USER_ID,
        workflow_id=workflow_id,
        name=name,
        description=f"{name} description",
        domain="testing",
        workflow_dir=f"/workflows/{workflow_id}",
    )


async def test_create_and_lookup(initialized_store: None) -> None:
    """Final visible state:

    {
      "workflows": [
        {
          "id": "wf-new",
          "name": "New workflow",
          "source_session_id": "source-session",
          "source_turn_id": "turn-new"
        },
        {
          "id": "wf-old",
          "name": "Old workflow",
          "source_session_id": null,
          "source_turn_id": null
        }
      ],
      "source-session": ["wf-new"]
    }

    Checks:
    1. Creating a Workflow persists all user-visible metadata.
    2. Id, name, and source-Turn lookups resolve the same Workflow.
    3. The local Workflow library is returned newest first.
    4. A source Session receives the Workflow association created with it.
    5. Unknown lookup keys return no Workflow or association.
    """
    await _create_session("source-session")
    repository = WorkflowRepository()
    await _create_workflow(repository, "wf-old", "Old workflow")

    # Check 1: Creating a Workflow persists all user-visible metadata.
    created = await repository.create(
        USER_ID,
        workflow_id="wf-new",
        name="New workflow",
        description="Build the current report",
        domain="reporting",
        workflow_dir="/workflows/wf-new",
        source_session_id="source-session",
        source_turn_id="turn-new",
    )
    assert created.id == "wf-new"
    assert created.user_id == USER_ID
    assert created.name == "New workflow"
    assert created.description == "Build the current report"
    assert created.domain == "reporting"
    assert created.workflow_dir == "/workflows/wf-new"
    assert created.source_session_id == "source-session"
    assert created.source_turn_id == "turn-new"

    # Check 2: All supported business keys resolve the same persisted Workflow.
    by_id = await repository.get(USER_ID, "wf-new")
    by_name = await repository.get_by_name(USER_ID, "New workflow")
    by_turn = await repository.get_by_source_turn(USER_ID, "turn-new")
    assert by_id is not None
    assert by_name is not None
    assert by_turn is not None
    assert by_id.id == by_name.id == by_turn.id == "wf-new"

    # Check 3: The local library exposes the most recently created Workflow first.
    library = await repository.list_for_user(USER_ID)
    assert [workflow.id for workflow in library] == ["wf-new", "wf-old"]

    # Check 4: Creation with a source Session also creates its visible association.
    associated = await repository.list_for_session(USER_ID, "source-session")
    assert [workflow.id for workflow in associated] == ["wf-new"]

    # Check 5: Unknown business keys expose no Workflow or Session association.
    assert await repository.get(USER_ID, "wf-missing") is None
    assert await repository.get_by_name(USER_ID, "Missing workflow") is None
    assert await repository.get_by_source_turn(USER_ID, "turn-missing") is None
    assert await repository.list_for_session(USER_ID, "missing-session") == []


async def test_confirmation_idempotency(initialized_store: None) -> None:
    """Final visible state:

    {
      "workflows": {
        "wf-confirmed": {
          "id": "wf-confirmed",
          "name": "Confirmed workflow",
          "source_turn_id": "turn-confirmed"
        },
        "wf-existing": {"id": "wf-existing", "name": "Existing workflow"}
      },
      "absent_ids": ["wf-retry", "wf-conflict"]
    }

    Checks:
    1. The first confirmation creates one Workflow and reports created=true.
    2. Retrying the same source Turn returns the original row without duplication.
    3. Creating another Workflow with an existing name raises a name conflict.
    4. Renaming onto an existing name raises the same conflict and keeps both names.
    """
    await _create_session("source-session")
    repository = WorkflowRepository()

    # Check 1: The first confirmation creates its durable Workflow exactly once.
    confirmed, created = await repository.create_from_turn(
        USER_ID,
        workflow_id="wf-confirmed",
        workflow_dir="/workflows/wf-confirmed",
        source_session_id="source-session",
        source_turn_id="turn-confirmed",
        name="Confirmed workflow",
        description="Confirmed description",
        domain="automation",
    )
    assert created is True
    assert confirmed.id == "wf-confirmed"

    # Check 2: A retry keyed by the same source Turn returns the original row.
    retried, retry_created = await repository.create_from_turn(
        USER_ID,
        workflow_id="wf-retry",
        workflow_dir="/workflows/wf-retry",
        source_session_id="source-session",
        source_turn_id="turn-confirmed",
        name="Confirmed workflow",
        description="Retry description",
        domain="retry",
    )
    assert retry_created is False
    assert retried.id == "wf-confirmed"
    assert retried.description == "Confirmed description"
    assert await repository.get(USER_ID, "wf-retry") is None

    await _create_workflow(repository, "wf-existing", "Existing workflow")

    # Check 3: A duplicate local name cannot create a second Workflow.
    with pytest.raises(WorkflowNameConflictError, match="Existing workflow"):
        await repository.create(
            USER_ID,
            workflow_id="wf-conflict",
            name="Existing workflow",
            description=None,
            domain=None,
            workflow_dir="/workflows/wf-conflict",
        )
    assert await repository.get(USER_ID, "wf-conflict") is None

    # Check 4: A conflicting rename changes neither existing Workflow name.
    with pytest.raises(WorkflowNameConflictError, match="Existing workflow"):
        await repository.rename(USER_ID, "wf-confirmed", "Existing workflow")
    persisted_confirmed = await repository.get(USER_ID, "wf-confirmed")
    persisted_existing = await repository.get(USER_ID, "wf-existing")
    assert persisted_confirmed is not None
    assert persisted_existing is not None
    assert persisted_confirmed.name == "Confirmed workflow"
    assert persisted_existing.name == "Existing workflow"


async def test_session_associations(initialized_store: None) -> None:
    """Final visible state:

    {
      "source-session": [],
      "destination-session": ["wf-second", "wf-first"],
      "workflows": ["wf-first", "wf-second"]
    }

    Checks:
    1. Association is idempotent and rejects missing business records.
    2. A Session lists its associated Workflows newest association first.
    3. Copying transfers every association to another existing Session.
    4. Missing copy endpoints produce no associations.
    5. Dissociation clears one Session projection without deleting Workflows.
    """
    await _create_session("source-session")
    await _create_session("destination-session")
    repository = WorkflowRepository()
    await _create_workflow(repository, "wf-first", "First workflow")
    await _create_workflow(repository, "wf-second", "Second workflow")

    # Check 1: Association succeeds idempotently and requires both business records.
    assert await repository.associate(USER_ID, "source-session", "wf-first") is True
    assert await repository.associate(USER_ID, "source-session", "wf-first") is True
    assert await repository.associate(USER_ID, "source-session", "wf-second") is True
    assert await repository.associate(USER_ID, "missing-session", "wf-first") is False
    assert await repository.associate(USER_ID, "source-session", "wf-missing") is False

    # Check 2: The latest association is returned first without an idempotent duplicate.
    source_workflows = await repository.list_for_session(USER_ID, "source-session")
    assert [workflow.id for workflow in source_workflows] == ["wf-second", "wf-first"]

    # Check 3: Copying returns the number of associations visible on the destination.
    copied = await repository.copy_session_associations(
        USER_ID,
        "source-session",
        "destination-session",
    )
    destination_workflows = await repository.list_for_session(
        USER_ID,
        "destination-session",
    )
    assert copied == 2
    assert [workflow.id for workflow in destination_workflows] == ["wf-second", "wf-first"]

    # Check 4: A missing source or destination leaves every association unchanged.
    assert await repository.copy_session_associations(
        USER_ID,
        "missing-session",
        "destination-session",
    ) == 0
    assert await repository.copy_session_associations(
        USER_ID,
        "source-session",
        "missing-session",
    ) == 0
    unchanged_destination = await repository.list_for_session(USER_ID, "destination-session")
    assert [workflow.id for workflow in unchanged_destination] == ["wf-second", "wf-first"]

    # Check 5: Dissociation removes only the source Session's visible projection.
    await repository.dissociate_session(USER_ID, "source-session")
    await repository.dissociate_session(USER_ID, "source-session")
    assert await repository.list_for_session(USER_ID, "source-session") == []
    assert [
        workflow.id
        for workflow in await repository.list_for_session(USER_ID, "destination-session")
    ] == ["wf-second", "wf-first"]
    assert await repository.get(USER_ID, "wf-first") is not None
    assert await repository.get(USER_ID, "wf-second") is not None


async def test_update_rename_delete(initialized_store: None) -> None:
    """Final visible state:

    {
      "workflows": [],
      "source-session": [],
      "editing-session": []
    }

    Checks:
    1. Content update replaces package metadata and associates the editing Session.
    2. Missing update inputs leave the persisted Workflow unchanged.
    3. Rename changes only the Workflow's user-visible name.
    4. Delete removes the Workflow and every Session association.
    5. Repeating missing rename and delete operations reports no changed row.
    """
    await _create_session("source-session")
    await _create_session("editing-session")
    repository = WorkflowRepository()
    workflow = await repository.create(
        USER_ID,
        workflow_id="wf-editable",
        name="Original workflow",
        description="Original description",
        domain="automation",
        workflow_dir="/workflows/original",
        source_session_id="source-session",
        source_turn_id="turn-original",
    )

    # Check 1: Content update changes package metadata and links the editing Session.
    updated = await repository.update_content(
        USER_ID,
        workflow.id,
        workflow_dir="/workflows/updated",
        description="Updated description",
        session_id="editing-session",
    )
    assert updated is not None
    assert updated.id == "wf-editable"
    assert updated.name == "Original workflow"
    assert updated.domain == "automation"
    assert updated.source_turn_id == "turn-original"
    assert updated.workflow_dir == "/workflows/updated"
    assert updated.description == "Updated description"
    assert [
        item.id for item in await repository.list_for_session(USER_ID, "editing-session")
    ] == ["wf-editable"]

    # Check 2: Missing Workflow or Session inputs cannot partially change content.
    assert await repository.update_content(
        USER_ID,
        "wf-missing",
        workflow_dir="/workflows/missing",
        description="Missing",
        session_id="editing-session",
    ) is None
    assert await repository.update_content(
        USER_ID,
        "wf-editable",
        workflow_dir="/workflows/rejected",
        description="Rejected",
        session_id="missing-session",
    ) is None
    unchanged = await repository.get(USER_ID, "wf-editable")
    assert unchanged is not None
    assert unchanged.workflow_dir == "/workflows/updated"
    assert unchanged.description == "Updated description"

    # Check 3: Rename changes the name while preserving package metadata and identity.
    renamed = await repository.rename(USER_ID, "wf-editable", "Renamed workflow")
    assert renamed is not None
    assert renamed.id == "wf-editable"
    assert renamed.name == "Renamed workflow"
    assert renamed.workflow_dir == "/workflows/updated"
    assert renamed.description == "Updated description"

    # Check 4: Delete removes the Workflow from every associated Session projection.
    assert await repository.delete(USER_ID, "wf-editable") is True
    assert await repository.get(USER_ID, "wf-editable") is None
    assert await repository.list_for_session(USER_ID, "source-session") == []
    assert await repository.list_for_session(USER_ID, "editing-session") == []
    assert await repository.list_for_user(USER_ID) == []

    # Check 5: Missing mutations report that no persisted row changed.
    assert await repository.rename(USER_ID, "wf-editable", "Missing") is None
    assert await repository.delete(USER_ID, "wf-editable") is False


async def test_ids_and_source_guard(initialized_store: None) -> None:
    """Final observations:

    {
      "ids": {"prefix": "wf_", "hex_characters": 16, "unique": true},
      "guard_order": ["first entered", "first left", "second entered"]
    }

    Checks:
    1. Generated Workflow ids are unique values in the public wf_<16 hex> format.
    2. A second mutation for the same Workflow cannot enter while the first holds the guard.
    3. Releasing the first guard allows the waiting mutation to proceed.
    """
    repository = WorkflowRepository()

    # Check 1: Public id generation produces unique, correctly shaped identifiers.
    workflow_ids = [repository.new_id(), repository.new_id()]
    assert len(set(workflow_ids)) == 2
    for workflow_id in workflow_ids:
        assert workflow_id.startswith("wf_")
        assert len(workflow_id) == 19
        int(workflow_id.removeprefix("wf_"), 16)

    first_entered = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    order: list[str] = []

    async def hold_first() -> None:
        async with repository.source_guard(USER_ID, "wf-guarded"):
            order.append("first entered")
            first_entered.set()
            await release_first.wait()
            order.append("first left")

    async def wait_second() -> None:
        await first_entered.wait()
        second_started.set()
        async with repository.source_guard(USER_ID, "wf-guarded"):
            order.append("second entered")

    first_task = asyncio.create_task(hold_first())
    second_task = asyncio.create_task(wait_second())
    await first_entered.wait()
    await second_started.wait()
    await asyncio.sleep(0)

    try:
        # Check 2: The same source guard serializes the waiting mutation.
        assert order == ["first entered"]
    finally:
        release_first.set()
        await asyncio.gather(first_task, second_task)

    # Check 3: Releasing the guard preserves first-exit-before-second-entry order.
    assert order == ["first entered", "first left", "second entered"]
