import pytest

from src.amphi_agent._schedules import ScheduleLibrary


async def test_read_only_library() -> None:
    """Final read-only Schedule catalogue:

    {
      "visible_schedules": {},
      "create": "blocked",
      "update": "blocked",
      "delete": "blocked"
    }

    Checks:
    1. Read operations remain available while scheduled execution owns the catalogue.
    2. Every mutation reaches the same read-only rejection before validating its payload.
    """
    schedules = ScheduleLibrary("local", mutable=False)

    # Check 1: Scheduled execution can inspect its read-only catalogue normally.
    assert schedules.is_empty()
    assert schedules.data() == {}
    assert schedules.search() == ()

    # Check 2: The immutable boundary, rather than payload validation, rejects every mutation.
    with pytest.raises(ValueError) as create_error:
        await schedules.create("Recursive task", "Create another Schedule", "0 0 * * * *")
    with pytest.raises(ValueError) as update_error:
        await schedules.update("schedule-missing", enabled=False)
    with pytest.raises(ValueError) as delete_error:
        await schedules.delete("schedule-missing")
    assert str(create_error.value)
    assert str(update_error.value) == str(create_error.value)
    assert str(delete_error.value) == str(create_error.value)
    assert schedules.data() == {}
