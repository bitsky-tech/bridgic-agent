from types import SimpleNamespace

import pytest

from src.amphi_agent.tools._schedule import (
    create_schedule,
    delete_schedule,
    get_schedule,
    list_schedules,
    update_schedule,
)
from tests.agent.tools._harness import ToolHarness


async def test_schedule_lifecycle(tool_harness: ToolHarness) -> None:
    """Final Schedule catalogue:

    {
      "Daily report": {
        "cron": "0 30 9 * * *",
        "enabled": false,
        "refs": ["workflow-1", "reporting"]
      }
    }

    Checks:
    1. Creation unwraps a quoted cron, persists the complete goal, and normalizes references.
    2. List and detail expose the new Schedule through the active Agent catalogue.
    3. A partial update changes supplied fields, accepts a model-style boolean, and retains the goal.
    4. Catalogue filters reflect the updated name and paused state.
    """
    # Check 1: Creation unwraps a quoted cron, persists the complete goal, and normalizes references.
    created = await create_schedule(
        "Morning report",
        "Prepare and publish the daily report.",
        "`0 0 9 * * *`",
        ["workflow-1", "reporting", "workflow-1"],
    )
    schedules = tuple(tool_harness.context.schedules.data().values())
    assert len(schedules) == 1
    schedule = schedules[0]
    assert schedule.cron == "0 0 9 * * *"
    assert schedule.refs == ("workflow-1", "reporting")
    assert schedule.description == "Prepare and publish the daily report."
    assert schedule.schedule_id in created

    # Check 2: List and detail expose the new Schedule through the active Agent catalogue.
    listed = await list_schedules("morning", enabled=True)
    detail = await get_schedule(schedule.schedule_id)
    assert schedule.schedule_id in listed
    assert "Prepare and publish the daily report." in detail
    assert "workflow-1, reporting" in detail

    # Check 3: A partial update changes supplied fields, accepts a model-style boolean, and retains the goal.
    updated = await update_schedule(
        schedule.schedule_id,
        name="Daily report",
        cron='"0 30 9 * * *"',
        enabled="false",  # type: ignore[arg-type] - exercise the model-input boundary.
    )
    current = tool_harness.context.schedules.get(schedule.schedule_id)
    assert current is not None
    assert (current.name, current.cron, current.enabled) == ("Daily report", "0 30 9 * * *", False)
    assert current.description == "Prepare and publish the daily report."
    assert schedule.schedule_id in updated

    # Check 4: Catalogue filters reflect the updated name and paused state.
    assert schedule.schedule_id in await list_schedules("daily", enabled="false")  # type: ignore[arg-type]
    assert schedule.schedule_id not in await list_schedules("morning")
    assert schedule.schedule_id not in await list_schedules(enabled=True)


async def test_schedule_removal(tool_harness: ToolHarness) -> None:
    """Final removed Schedule:

    {
      "catalogue": [],
      "inflight_run": "cancelled",
      "missing_schedule": "rejected",
      "invalid_arguments": "rejected"
    }

    Checks:
    1. Deletion removes the Schedule and asks the invocation runtime to stop an in-flight run.
    2. Reading or deleting the removed identity fails instead of returning stale catalogue data.
    3. Invalid cron and enabled values fail before they can corrupt persisted Schedule state.
    """
    await create_schedule("Temporary", "Run once per day.", "0 0 8 * * *")
    schedule_id = next(iter(tool_harness.context.schedules.data()))
    killed: list[str] = []

    async def kill_schedule(value: str) -> None:
        killed.append(value)

    tool_harness.context.invocations = SimpleNamespace(kill_schedule=kill_schedule)

    # Check 1: Deletion removes the Schedule and asks the invocation runtime to stop an in-flight run.
    removed = await delete_schedule(schedule_id)
    assert schedule_id in removed
    assert tool_harness.context.schedules.get(schedule_id) is None
    assert killed == [schedule_id]

    # Check 2: Reading or deleting the removed identity fails instead of returning stale catalogue data.
    with pytest.raises(ValueError):
        await get_schedule(schedule_id)
    with pytest.raises(ValueError):
        await delete_schedule(schedule_id)

    # Check 3: Invalid cron and enabled values fail before they can corrupt persisted Schedule state.
    with pytest.raises(ValueError):
        await create_schedule("Broken", "This must not persist.", "not a cron")
    with pytest.raises(ValueError):
        await list_schedules(enabled="sometimes")  # type: ignore[arg-type]
    assert tool_harness.context.schedules.is_empty()
