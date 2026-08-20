from datetime import datetime

from src.amphi_store import ScheduleRepository


USER_ID = "local"


async def test_create_and_list(initialized_store: None) -> None:
    """Final database state:

    {
      "schedules": [
        {
          "id": "<generated sched_* id>",
          "name": "Weekly review",
          "enabled": true
        },
        {
          "id": "schedule-morning",
          "name": "Morning summary",
          "cron": "0 0 9 * * *",
          "timezone": "Asia/Shanghai",
          "locale": "zh-CN",
          "refs_json": "{\"skills\":[\"news\"]}",
          "enabled": false,
          "next_run_at": "2026-08-19T09:00:00"
        }
      ]
    }

    Checks:
    1. Creating a Schedule persists its task, timing, references, and switch.
    2. Omitting an id creates a recognizable Schedule id with enabled defaults.
    3. A Schedule can be loaded later by its persisted id.
    4. The user list returns newest first and supports page boundaries.
    """
    repository = ScheduleRepository()
    next_run_at = datetime(2026, 8, 19, 9, 0, 0)

    # Check 1: Creating a Schedule persists its task, timing, references, and switch.
    morning = await repository.create(
        USER_ID,
        name="Morning summary",
        desc="Summarize overnight activity",
        cron="0 0 9 * * *",
        timezone="Asia/Shanghai",
        refs_json='{"skills":["news"]}',
        enabled=False,
        schedule_id="schedule-morning",
        next_run_at=next_run_at,
        locale="zh-CN",
    )
    assert morning.id == "schedule-morning"
    assert morning.user_id == USER_ID
    assert morning.name == "Morning summary"
    assert morning.desc == "Summarize overnight activity"
    assert morning.cron == "0 0 9 * * *"
    assert morning.timezone == "Asia/Shanghai"
    assert morning.locale == "zh-CN"
    assert morning.refs_json == '{"skills":["news"]}'
    assert morning.enabled is False
    assert morning.next_run_at == next_run_at

    # Check 2: Omitting an id creates a recognizable Schedule id with enabled defaults.
    weekly = await repository.create(
        USER_ID,
        name="Weekly review",
        desc="Review this week's work",
        cron="0 0 18 * * 5",
    )
    assert weekly.id.startswith("sched_")
    assert weekly.enabled is True
    assert weekly.timezone is None
    assert weekly.locale is None
    assert weekly.refs_json is None
    assert weekly.next_run_at is None

    # Check 3: A Schedule can be loaded later by its persisted id.
    loaded = await repository.get(USER_ID, morning.id)
    assert loaded is not None
    assert loaded.id == morning.id
    assert loaded.desc == "Summarize overnight activity"
    assert loaded.next_run_at == next_run_at

    # Check 4: The user list returns newest first and supports page boundaries.
    schedules = await repository.list_for_user(USER_ID)
    second_page = await repository.list_for_user(USER_ID, limit=1, offset=1)
    assert [schedule.id for schedule in schedules] == [weekly.id, morning.id]
    assert [schedule.id for schedule in second_page] == [morning.id]


async def test_update_and_run(initialized_store: None) -> None:
    """Final database state:

    {
      "schedules": [
        {
          "id": "schedule-report",
          "name": "Evening report",
          "desc": "Prepare the final report",
          "cron": "0 30 18 * * *",
          "timezone": "UTC",
          "locale": "en-GB",
          "refs_json": "{\"skills\":[\"report\"]}",
          "enabled": false,
          "last_run_at": "2026-08-18T18:30:00",
          "next_run_at": "2026-08-19T18:30:00"
        }
      ]
    }

    Checks:
    1. Updating a Schedule replaces every submitted editable field.
    2. Fields outside the update request keep their original values.
    3. Recording a fire persists the Schedule's last and next run times.
    """
    repository = ScheduleRepository()
    original_next_run = datetime(2026, 8, 18, 18, 0, 0)
    updated_next_run = datetime(2026, 8, 18, 18, 30, 0)
    last_run_at = datetime(2026, 8, 18, 18, 30, 0)
    following_run_at = datetime(2026, 8, 19, 18, 30, 0)
    await repository.create(
        USER_ID,
        schedule_id="schedule-report",
        name="Daily report",
        desc="Prepare a draft report",
        cron="0 0 18 * * *",
        timezone="UTC",
        refs_json='{"skills":["report"]}',
        enabled=True,
        next_run_at=original_next_run,
        locale="en-US",
    )

    # Check 1: Updating a Schedule replaces every submitted editable field.
    updated = await repository.update(
        USER_ID,
        "schedule-report",
        name="Evening report",
        desc="Prepare the final report",
        cron="0 30 18 * * *",
        enabled=False,
        next_run_at=updated_next_run,
        locale="en-GB",
    )
    assert updated is not None
    assert updated.name == "Evening report"
    assert updated.desc == "Prepare the final report"
    assert updated.cron == "0 30 18 * * *"
    assert updated.enabled is False
    assert updated.next_run_at == updated_next_run
    assert updated.locale == "en-GB"

    # Check 2: Fields outside the update request keep their original values.
    assert updated.timezone == "UTC"
    assert updated.refs_json == '{"skills":["report"]}'

    # Check 3: Recording a fire persists the Schedule's last and next run times.
    await repository.set_run_times(
        "schedule-report",
        last_run_at=last_run_at,
        next_run_at=following_run_at,
    )
    loaded = await repository.get(USER_ID, "schedule-report")
    assert loaded is not None
    assert loaded.last_run_at == last_run_at
    assert loaded.next_run_at == following_run_at


async def test_enable_and_delete(initialized_store: None) -> None:
    """Final database state:

    {
      "schedules": [
        {
          "id": "schedule-paused",
          "enabled": false
        }
      ],
      "enabled_schedules": []
    }

    Checks:
    1. The runtime list contains enabled Schedules and excludes paused ones.
    2. Deleting a Schedule removes it from direct and user-list reads.
    3. Deleting the same Schedule again reports that nothing was removed.
    """
    repository = ScheduleRepository()
    active = await repository.create(
        USER_ID,
        schedule_id="schedule-active",
        name="Active task",
        desc="Run the active task",
        cron="0 * * * * *",
    )
    paused = await repository.create(
        USER_ID,
        schedule_id="schedule-paused",
        name="Paused task",
        desc="Do not run the paused task",
        cron="0 * * * * *",
        enabled=False,
    )

    # Check 1: The runtime list contains enabled Schedules and excludes paused ones.
    enabled = await repository.list_all_enabled()
    assert [schedule.id for schedule in enabled] == [active.id]
    assert paused.id not in {schedule.id for schedule in enabled}

    # Check 2: Deleting a Schedule removes it from direct and user-list reads.
    deleted = await repository.delete(USER_ID, active.id)
    remaining = await repository.list_for_user(USER_ID)
    assert deleted is True
    assert await repository.get(USER_ID, active.id) is None
    assert [schedule.id for schedule in remaining] == [paused.id]
    assert await repository.list_all_enabled() == []

    # Check 3: Deleting the same Schedule again reports that nothing was removed.
    assert await repository.delete(USER_ID, active.id) is False
