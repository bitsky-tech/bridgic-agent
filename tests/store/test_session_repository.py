from datetime import datetime, timezone

from src.amphi_store import (
    SessionKind,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
)


USER_ID = "local"


async def test_save_and_update(initialized_store: None) -> None:
    """Final database state:

    {
      "sessions": [
        {
          "id": "root-session",
          "user_id": "local",
          "parent_session_id": null,
          "workspace_root": "/workspace/updated",
          "title": "Updated title",
          "status": "completed",
          "last_used_model": "test-model",
          "last_answer": "Updated answer"
        }
      ]
    }

    Checks:
    1. The first save makes the root Session loadable by its id.
    2. Saving the same id again replaces its mutable business fields.
    3. The root Session list still contains exactly one record.
    """
    repository = SessionRepository()
    original_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    updated_time = datetime(2026, 1, 2, tzinfo=timezone.utc)
    original = SessionRecord(
        id="root-session",
        user_id=USER_ID,
        workspace_root="/workspace/original",
        title="Original title",
        created_at=original_time,
        updated_at=original_time,
    )

    # Check 1: The first save makes the root Session loadable by its id.
    await repository.save(original)
    loaded = await repository.load("root-session", USER_ID)
    assert loaded is not None
    assert loaded.id == "root-session"
    assert loaded.workspace_root == "/workspace/original"
    assert loaded.title == "Original title"

    replacement = SessionRecord(
        id="root-session",
        user_id=USER_ID,
        workspace_root="/workspace/updated",
        title="Updated title",
        status=SessionStatus.COMPLETED,
        last_used_model="test-model",
        last_answer="Updated answer",
        created_at=updated_time,
        updated_at=updated_time,
    )

    # Check 2: Saving the same id again replaces its mutable business fields.
    await repository.save(replacement)
    updated = await repository.load("root-session", USER_ID)
    assert updated is not None
    assert updated.workspace_root == "/workspace/updated"
    assert updated.title == "Updated title"
    assert updated.status is SessionStatus.COMPLETED
    assert updated.last_used_model == "test-model"
    assert updated.last_answer == "Updated answer"

    # Check 3: The root Session list still contains exactly one record.
    roots = await repository.list_for_user(USER_ID)
    assert [record.id for record in roots] == ["root-session"]


async def test_turn_status_changes(initialized_store: None) -> None:
    """Final database state:

    {
      "sessions": [
        {
          "id": "root-session",
          "status": "finish",
          "last_used_model": null,
          "last_answer": null
        }
      ]
    }

    Checks:
    1. A completed turn stores its status, model, and user-facing answer.
    2. Marking the Session as read clears only the completed status.
    3. Handling an awaiting interaction returns the Session to finish.
    4. Resetting the Session removes the latest model and answer projections.
    """
    repository = SessionRepository()
    await repository.save(
        SessionRecord(
            id="root-session",
            user_id=USER_ID,
            workspace_root="/workspace/root",
        )
    )

    # Check 1: A completed turn stores its status, model, and user-facing answer.
    projected = await repository.update_turn_projection(
        "root-session",
        USER_ID,
        status=SessionStatus.COMPLETED,
        model="test-model",
        last_answer="Completed answer",
    )
    completed = await repository.load("root-session", USER_ID)
    assert projected is True
    assert completed is not None
    assert completed.status is SessionStatus.COMPLETED
    assert completed.last_used_model == "test-model"
    assert completed.last_answer == "Completed answer"

    # Check 2: Marking the Session as read clears only the completed status.
    marked_read = await repository.mark_read("root-session", USER_ID)
    read = await repository.load("root-session", USER_ID)
    assert marked_read is True
    assert read is not None
    assert read.status is SessionStatus.FINISH
    assert read.last_used_model == "test-model"
    assert read.last_answer == "Completed answer"

    await repository.update_turn_projection(
        "root-session",
        USER_ID,
        status=SessionStatus.AWAITING,
        model="test-model",
        last_answer="Waiting for input",
    )

    # Check 3: Handling an awaiting interaction returns the Session to finish.
    handled = await repository.mark_interaction_handled("root-session", USER_ID)
    resumed = await repository.load("root-session", USER_ID)
    assert handled is True
    assert resumed is not None
    assert resumed.status is SessionStatus.FINISH
    assert resumed.last_used_model == "test-model"
    assert resumed.last_answer == "Waiting for input"

    # Check 4: Resetting the Session removes the latest model and answer projections.
    reset = await repository.reset("root-session", USER_ID)
    cleared = await repository.load("root-session", USER_ID)
    assert reset is True
    assert cleared is not None
    assert cleared.status is SessionStatus.FINISH
    assert cleared.last_used_model is None
    assert cleared.last_answer is None


async def test_rename_and_delete(initialized_store: None) -> None:
    """Final database state:

    {
      "sessions": []
    }

    Checks:
    1. Renaming changes the persisted title returned by a later load.
    2. Deleting removes the Session from subsequent loads and root listings.
    """
    repository = SessionRepository()
    await repository.save(
        SessionRecord(
            id="root-session",
            user_id=USER_ID,
            workspace_root="/workspace/root",
            title="Original title",
        )
    )

    # Check 1: Renaming changes the persisted title returned by a later load.
    renamed = await repository.rename("root-session", USER_ID, "Renamed title")
    loaded = await repository.load("root-session", USER_ID)
    assert renamed is True
    assert loaded is not None
    assert loaded.title == "Renamed title"

    # Check 2: Deleting removes the Session from subsequent loads and root listings.
    deleted = await repository.delete("root-session", USER_ID)
    assert deleted is True
    assert await repository.load("root-session", USER_ID) is None
    assert await repository.list_for_user(USER_ID) == []


async def test_conditional_rename_preserves_a_newer_title(initialized_store: None) -> None:
    """A generated title cannot replace a user title committed while it was pending."""
    repository = SessionRepository()
    await repository.save(
        SessionRecord(
            id="root-session",
            user_id=USER_ID,
            workspace_root="/workspace/root",
        )
    )

    assert await repository.rename("root-session", USER_ID, "Manual title") is True
    assert await repository.rename_if_title(
        "root-session",
        USER_ID,
        None,
        "Generated title",
    ) is False

    loaded = await repository.load("root-session", USER_ID)
    assert loaded is not None
    assert loaded.title == "Manual title"


async def test_root_with_children(initialized_store: None) -> None:
    """Final database state:

    {
      "sessions": [
        {
          "id": "root-session",
          "parent_session_id": null,
          "workspace_root": "/workspace/root"
        },
        {
          "id": "background-child",
          "parent_session_id": "root-session",
          "parent_call_id": "call-background",
          "subagent_mode": "background",
          "workspace_root": "/workspace/root"
        },
        {
          "id": "blocking-child",
          "parent_session_id": "root-session",
          "parent_call_id": "call-blocking",
          "subagent_mode": "blocking",
          "workspace_root": "/workspace/root"
        }
      ]
    }

    Checks:
    1. Every child is attached directly to the root Session.
    2. Children inherit the root workspace and latest model.
    3. Listing children returns only the root's direct children.
    4. Resolving either child returns the same root Session.
    5. Listing the tree returns the root before its direct children.
    """
    repository = SessionRepository()
    await repository.save(
        SessionRecord(
            id="root-session",
            user_id=USER_ID,
            workspace_root="/workspace/root",
            last_used_model="root-model",
        )
    )
    background = await repository.create_child(
        USER_ID,
        parent_session_id="root-session",
        parent_call_id="call-background",
        subagent_mode=SubAgentMode.BACKGROUND,
        session_id="background-child",
        title="Background task",
    )
    blocking = await repository.create_child(
        USER_ID,
        parent_session_id="root-session",
        parent_call_id="call-blocking",
        subagent_mode=SubAgentMode.BLOCKING,
        session_id="blocking-child",
        title="Blocking task",
    )

    # Check 1: Every child is attached directly to the root Session.
    assert background.parent_session_id == "root-session"
    assert background.parent_call_id == "call-background"
    assert background.subagent_mode is SubAgentMode.BACKGROUND
    assert blocking.parent_session_id == "root-session"
    assert blocking.parent_call_id == "call-blocking"
    assert blocking.subagent_mode is SubAgentMode.BLOCKING

    # Check 2: Children inherit the root workspace and latest model.
    assert background.workspace_root == "/workspace/root"
    assert background.last_used_model == "root-model"
    assert blocking.workspace_root == "/workspace/root"
    assert blocking.last_used_model == "root-model"

    # Check 3: Listing children returns only the root's direct children.
    children = await repository.list_children(USER_ID, "root-session")
    assert {record.id for record in children} == {"background-child", "blocking-child"}

    # Check 4: Resolving either child returns the same root Session.
    background_root = await repository.root("background-child", USER_ID)
    blocking_root = await repository.root("blocking-child", USER_ID)
    assert background_root is not None
    assert background_root.id == "root-session"
    assert blocking_root is not None
    assert blocking_root.id == "root-session"

    # Check 5: Listing the tree returns the root before its direct children.
    tree = await repository.list_tree(USER_ID, "root-session")
    assert tree[0].id == "root-session"
    assert {record.id for record in tree[1:]} == {"background-child", "blocking-child"}


async def test_sidebar_pages(initialized_store: None) -> None:
    """Returned sidebar pages:

    {
      "page_1": {
        "root_sessions": ["new-root"],
        "background_children": ["new-root-background-child"]
      },
      "page_2": {
        "root_sessions": ["old-root"],
        "background_children": []
      },
      "excluded": [
        "new-root-blocking-child",
        "scheduled-root"
      ]
    }

    Checks:
    1. Pagination counts root Sessions instead of flattened rows.
    2. A background child remains on the same page as its root.
    3. Blocking children are not exposed as standalone sidebar rows.
    4. Scheduled runs are excluded from conversation roots and sidebar pages.
    """
    repository = SessionRepository()
    old_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
    scheduled_time = datetime(2026, 1, 2, tzinfo=timezone.utc)
    blocking_time = datetime(2026, 1, 3, tzinfo=timezone.utc)
    background_time = datetime(2026, 1, 4, tzinfo=timezone.utc)
    new_time = datetime(2026, 1, 5, tzinfo=timezone.utc)
    records = [
        SessionRecord(
            id="old-root",
            user_id=USER_ID,
            workspace_root="/workspace/old",
            created_at=old_time,
            updated_at=old_time,
        ),
        SessionRecord(
            id="scheduled-root",
            user_id=USER_ID,
            workspace_root="/workspace/scheduled",
            kind=SessionKind.SCHEDULED,
            schedule_id="schedule-a",
            created_at=scheduled_time,
            updated_at=scheduled_time,
        ),
        SessionRecord(
            id="new-root",
            user_id=USER_ID,
            workspace_root="/workspace/new",
            created_at=new_time,
            updated_at=new_time,
        ),
        SessionRecord(
            id="new-root-blocking-child",
            user_id=USER_ID,
            parent_session_id="new-root",
            parent_call_id="call-blocking",
            subagent_mode=SubAgentMode.BLOCKING,
            workspace_root="/workspace/new",
            created_at=blocking_time,
            updated_at=blocking_time,
        ),
        SessionRecord(
            id="new-root-background-child",
            user_id=USER_ID,
            parent_session_id="new-root",
            parent_call_id="call-background",
            subagent_mode=SubAgentMode.BACKGROUND,
            workspace_root="/workspace/new",
            created_at=background_time,
            updated_at=background_time,
        ),
    ]
    for record in records:
        await repository.save(record)

    first_page = await repository.list_sidebar(USER_ID, limit=1)
    second_page = await repository.list_sidebar(USER_ID, limit=1, offset=1)

    # Check 1: Pagination counts root Sessions instead of flattened rows.
    assert [record.id for record in first_page if record.parent_session_id is None] == ["new-root"]
    assert [record.id for record in second_page if record.parent_session_id is None] == ["old-root"]

    # Check 2: A background child remains on the same page as its root.
    assert [record.id for record in first_page] == ["new-root", "new-root-background-child"]

    # Check 3: Blocking children are not exposed as standalone sidebar rows.
    sidebar_ids = {record.id for record in first_page + second_page}
    assert "new-root-blocking-child" not in sidebar_ids

    # Check 4: Scheduled runs are excluded from conversation roots and sidebar pages.
    conversation_roots = await repository.list_for_user(USER_ID)
    assert [record.id for record in conversation_roots] == ["new-root", "old-root"]
    assert "scheduled-root" not in sidebar_ids


async def test_scheduled_runs(initialized_store: None) -> None:
    """Returned schedule projections:

    {
      "schedule-a": {
        "history": ["run-a-new", "run-a-old"],
        "awaiting_count": 1
      },
      "bulk_awaiting_counts": {
        "schedule-a": 1,
        "schedule-b": 1
      }
    }

    Checks:
    1. Run history contains only Sessions belonging to the requested schedule.
    2. Run history is ordered from newest to oldest.
    3. The single-schedule count includes only awaiting runs.
    4. The bulk count reports awaiting runs for every matching schedule.
    """
    repository = SessionRepository()
    old_time = datetime(2026, 2, 1, tzinfo=timezone.utc)
    other_time = datetime(2026, 2, 2, tzinfo=timezone.utc)
    new_time = datetime(2026, 2, 3, tzinfo=timezone.utc)
    records = [
        SessionRecord(
            id="run-a-old",
            user_id=USER_ID,
            workspace_root="/workspace/run-a-old",
            status=SessionStatus.AWAITING,
            kind=SessionKind.SCHEDULED,
            schedule_id="schedule-a",
            created_at=old_time,
            updated_at=old_time,
        ),
        SessionRecord(
            id="run-b-awaiting",
            user_id=USER_ID,
            workspace_root="/workspace/run-b-awaiting",
            status=SessionStatus.AWAITING,
            kind=SessionKind.SCHEDULED,
            schedule_id="schedule-b",
            created_at=other_time,
            updated_at=other_time,
        ),
        SessionRecord(
            id="run-a-new",
            user_id=USER_ID,
            workspace_root="/workspace/run-a-new",
            status=SessionStatus.COMPLETED,
            kind=SessionKind.SCHEDULED,
            schedule_id="schedule-a",
            created_at=new_time,
            updated_at=new_time,
        ),
    ]
    for record in records:
        await repository.save(record)

    history = await repository.list_scheduled("schedule-a")

    # Check 1: Run history contains only Sessions belonging to the requested schedule.
    assert {record.schedule_id for record in history} == {"schedule-a"}
    assert {record.id for record in history} == {"run-a-old", "run-a-new"}

    # Check 2: Run history is ordered from newest to oldest.
    assert [record.id for record in history] == ["run-a-new", "run-a-old"]

    # Check 3: The single-schedule count includes only awaiting runs.
    assert await repository.count_awaiting_scheduled("schedule-a") == 1

    # Check 4: The bulk count reports awaiting runs for every matching schedule.
    bulk_counts = await repository.count_awaiting_scheduled_bulk(
        ["schedule-a", "schedule-b", "schedule-empty"]
    )
    assert bulk_counts == {"schedule-a": 1, "schedule-b": 1}
