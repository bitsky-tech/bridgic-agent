from datetime import datetime

import httpx


async def _create_schedule(service_client: httpx.AsyncClient, *, enabled: bool = True) -> dict:
    """Create one reusable Schedule through the public HTTP boundary."""
    response = await service_client.post(
        "/schedules",
        json={
            "name": "Morning report",
            "desc": "Prepare the morning report",
            "cron": "0 0 9 * * *",
            "refs": ["report-workflow", "news-skill"],
            "enabled": enabled,
        },
    )
    assert response.status_code == 201
    return response.json()


async def test_create(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "schedules": [
        {
          "id": "<generated sched_* id>",
          "name": "Morning report",
          "cron": "0 0 9 * * *",
          "enabled": true,
          "status": "active",
          "running": false,
          "needs_action": 0,
          "runs": []
        }
      ]
    }

    Checks:
    1. Creating a Schedule returns its complete active HTTP projection.
    2. The Schedule list exposes the newly persisted Schedule.
    3. The Schedule detail starts with no run history.
    """
    # Check 1: Creating a Schedule returns its complete active HTTP projection.
    created = await _create_schedule(service_client)
    schedule_id = created["id"]
    assert schedule_id.startswith("sched_")
    assert created == {
        "id": schedule_id,
        "name": "Morning report",
        "desc": "Prepare the morning report",
        "cron": "0 0 9 * * *",
        "enabled": True,
        "status": "active",
        "running": False,
        "needs_action": 0,
        "refs": ["report-workflow", "news-skill"],
        "last_run_at": None,
        "next_run_at": created["next_run_at"],
        "created_at": created["created_at"],
    }
    assert datetime.fromisoformat(created["next_run_at"])
    assert datetime.fromisoformat(created["created_at"])

    # Check 2: The Schedule list exposes the newly persisted Schedule.
    response = await service_client.get("/schedules")
    assert response.status_code == 200
    assert response.json() == [created]

    # Check 3: The Schedule detail starts with no run history.
    response = await service_client.get(f"/schedules/{schedule_id}")
    assert response.status_code == 200
    assert response.json() == {**created, "runs": []}


async def test_update_delete(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "schedules": [],
      "deleted_schedule": "not found"
    }

    Checks:
    1. Patch replaces submitted Schedule fields and preserves its references and identity.
    2. Pausing and re-enabling update the derived public status.
    3. Delete removes the Schedule from item and list reads.
    4. Reading or deleting the removed Schedule reports not found.
    """
    created = await _create_schedule(service_client)
    schedule_id = created["id"]

    # Check 1: Patch replaces submitted fields and preserves references and identity.
    response = await service_client.patch(
        f"/schedules/{schedule_id}",
        json={
            "name": "Evening report",
            "desc": "Prepare the final report",
            "cron": "0 30 18 * * *",
            "enabled": False,
        },
    )
    assert response.status_code == 200
    paused = response.json()
    assert paused == {
        **created,
        "name": "Evening report",
        "desc": "Prepare the final report",
        "cron": "0 30 18 * * *",
        "enabled": False,
        "status": "paused",
        "next_run_at": paused["next_run_at"],
    }
    assert paused["next_run_at"] != created["next_run_at"]

    # Check 2: Re-enabling the Schedule restores its active derived status.
    response = await service_client.patch(
        f"/schedules/{schedule_id}",
        json={"enabled": True},
    )
    assert response.status_code == 200
    active = response.json()
    assert active == {
        **paused,
        "enabled": True,
        "status": "active",
        "next_run_at": active["next_run_at"],
    }

    # Check 3: Delete removes the Schedule from item and list reads.
    response = await service_client.delete(f"/schedules/{schedule_id}")
    assert response.status_code == 204
    assert response.content == b""
    response = await service_client.get("/schedules")
    assert response.status_code == 200
    assert response.json() == []

    # Check 4: The removed Schedule consistently reports not found.
    response = await service_client.get(f"/schedules/{schedule_id}")
    assert response.status_code == 404
    response = await service_client.delete(f"/schedules/{schedule_id}")
    assert response.status_code == 404


async def test_reject_cron(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "schedules": [
        {
          "id": "<generated sched_* id>",
          "cron": "0 0 9 * * *",
          "name": "Morning report"
        }
      ],
      "rejected_cron": "not-a-cron"
    }

    Checks:
    1. An invalid cron cannot create a Schedule.
    2. An invalid cron cannot partially update an existing Schedule.
    """
    # Check 1: An invalid cron cannot create a Schedule.
    response = await service_client.post(
        "/schedules",
        json={
            "name": "Invalid schedule",
            "desc": "This must not be persisted",
            "cron": "not-a-cron",
        },
    )
    assert response.status_code == 422
    response = await service_client.get("/schedules")
    assert response.status_code == 200
    assert response.json() == []

    created = await _create_schedule(service_client)

    # Check 2: An invalid cron cannot partially update an existing Schedule.
    response = await service_client.patch(
        f"/schedules/{created['id']}",
        json={"name": "Rejected name", "cron": "not-a-cron"},
    )
    assert response.status_code == 422
    response = await service_client.get(f"/schedules/{created['id']}")
    assert response.status_code == 200
    assert response.json() == {**created, "runs": []}
