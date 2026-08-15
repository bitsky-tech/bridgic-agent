"""``/schedules`` — cron schedule CRUD + run-now / kill.

Covers the REST surface only. The firing engine (SchedulerService) is exercised
separately; here ``run_now`` is stubbed so the endpoints stay deterministic (no
background agent turn). The lifespan's supervisor sleeps for its full tick after
startup, so created schedules never fire mid-test.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_service.runtime import SessionService
from src.amphi_store import (
    ScheduleRepository,
    SessionKind,
    SessionRepository,
    SubAgentMode,
    UserInput,
    WorkflowRepository,
)
from ._session_turns import persist_session_turn

_DAILY_9AM = "0 0 9 * * *"  # 6-field, seconds-first — always a future fire


async def _create(client: httpx.AsyncClient, **overrides) -> dict:
    body = {"name": "竞品监控", "desc": "每天9点抓竞品价格", "cron": _DAILY_9AM}
    body.update(overrides)
    resp = await client.post("/schedules", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_create_list_get_delete(client: httpx.AsyncClient) -> None:
    created = await _create(client)
    assert created["id"].startswith("sched_")
    assert created["status"] == "active"
    assert created["enabled"] is True
    assert created["needs_action"] == 0
    assert created["next_run_at"] is not None  # primed on create
    sid = created["id"]

    listing = (await client.get("/schedules")).json()
    assert any(s["id"] == sid for s in listing)

    detail = await client.get(f"/schedules/{sid}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["id"] == sid
    assert body["runs"] == []  # no runs yet

    assert (await client.delete(f"/schedules/{sid}")).status_code == 204
    assert (await client.get(f"/schedules/{sid}")).status_code == 404


async def test_workflow_ref_renders_current_name_after_rename(
    client: httpx.AsyncClient, tmp_path: Path,
) -> None:
    workflow = await WorkflowRepository().create(
        LOCAL_USER_ID,
        name="旧工作流名称",
        description=None,
        domain=None,
        workflow_dir=str(tmp_path / "workflow"),
    )
    schedule = await _create(client, refs=[workflow.id, "browser"])
    stored = await ScheduleRepository().get(LOCAL_USER_ID, schedule["id"])

    assert stored is not None
    assert json.loads(stored.refs_json or "[]") == [workflow.id, "browser"]
    assert schedule["refs"] == ["旧工作流名称", "browser"]

    renamed = await client.patch(
        f"/workflows/{workflow.id}", json={"name": "新工作流名称"},
    )
    assert renamed.status_code == 200, renamed.text
    detail = (await client.get(f"/schedules/{schedule['id']}")).json()
    listing = (await client.get("/schedules")).json()

    assert detail["refs"] == ["新工作流名称", "browser"]
    assert next(row for row in listing if row["id"] == schedule["id"])["refs"] == [
        "新工作流名称",
        "browser",
    ]


async def test_delete_kills_inflight_run(
    client: httpx.AsyncClient, service_app, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Deleting a schedule must also cancel any run already in flight, so a
    # stuck/long run never outlives the schedule that spawned it.
    sid = (await _create(client))["id"]
    killed: list[str] = []

    async def fake_kill(schedule_id: str) -> bool:
        killed.append(schedule_id)
        return True

    monkeypatch.setattr(service_app.state.scheduler, "kill", fake_kill)

    assert (await client.delete(f"/schedules/{sid}")).status_code == 204
    assert killed == [sid]


async def test_create_invalid_cron_422(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/schedules", json={"name": "坏", "desc": "x", "cron": "abc"},
    )
    assert resp.status_code == 422, resp.text


async def test_patch_disable_and_cron(client: httpx.AsyncClient) -> None:
    sid = (await _create(client))["id"]

    paused = await client.patch(f"/schedules/{sid}", json={"enabled": False})
    assert paused.status_code == 200
    assert paused.json()["enabled"] is False
    assert paused.json()["status"] == "paused"

    changed = await client.patch(f"/schedules/{sid}", json={"cron": "0 30 8 * * *"})
    assert changed.status_code == 200
    assert changed.json()["cron"] == "0 30 8 * * *"

    bad = await client.patch(f"/schedules/{sid}", json={"cron": "abc"})
    assert bad.status_code == 422


async def test_reenable_recomputes_next_run(client: httpx.AsyncClient, service_app) -> None:
    # A schedule paused across its fire time keeps a now-past next_run_at; on
    # re-enable it must be recomputed forward, else the supervisor fires an
    # immediate catch-up run (D9 says missed fires are dropped).
    from datetime import datetime, timedelta

    from src.amphi_store import ScheduleRepository

    sid = (await _create(client))["id"]
    await ScheduleRepository().set_run_times(sid, next_run_at=datetime.now() - timedelta(days=1))
    await client.patch(f"/schedules/{sid}", json={"enabled": False})

    reenabled = await client.patch(f"/schedules/{sid}", json={"enabled": True})
    assert reenabled.status_code == 200
    nxt = reenabled.json()["next_run_at"]
    assert nxt is not None
    assert datetime.fromisoformat(nxt) > datetime.now()  # future, not the stale past


async def test_item_ops_404_on_missing(client: httpx.AsyncClient) -> None:
    assert (await client.get("/schedules/sched_missing")).status_code == 404
    assert (await client.patch("/schedules/sched_missing", json={"name": "x"})).status_code == 404
    assert (await client.delete("/schedules/sched_missing")).status_code == 404
    assert (await client.post("/schedules/sched_missing/run-now")).status_code == 404
    assert (await client.post("/schedules/sched_missing/kill")).status_code == 404


async def test_run_now_and_kill(client: httpx.AsyncClient, service_app, monkeypatch: pytest.MonkeyPatch) -> None:
    sid = (await _create(client))["id"]

    fired: dict = {}

    async def fake_run_now(sched) -> None:
        fired["id"] = sched.id

    monkeypatch.setattr(service_app.state.scheduler, "run_now", fake_run_now)

    run = await client.post(f"/schedules/{sid}/run-now")
    assert run.status_code == 202
    assert fired["id"] == sid

    # kill on a schedule with no in-flight run → accepted, killed=False.
    killed = await client.post(f"/schedules/{sid}/kill")
    assert killed.status_code == 202
    assert killed.json()["killed"] is False


async def test_running_is_a_field_not_only_a_status(
    client: httpx.AsyncClient, service_app, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``running`` must survive as its own field even when ``status`` says ``needsAction``.

    ``status`` is a mutually-exclusive priority label (needsAction > running > paused >
    active), so a schedule that has parked runs awaiting a human AND live in-flight runs
    reports ``needsAction`` — the in-flight fact vanishes if clients can only read
    ``status``. The GUI needs it to offer "stop all runs" on exactly such a schedule.
    """
    sid = (await _create(client))["id"]
    monkeypatch.setattr(service_app.state.scheduler, "is_running", lambda _sid: True)

    async def fake_count(_self, _schedule_id: str) -> int:
        return 10

    monkeypatch.setattr(SessionRepository, "count_awaiting_scheduled", fake_count)

    body = (await client.get(f"/schedules/{sid}")).json()
    assert body["status"] == "needsAction"  # needs-action outranks running
    assert body["needs_action"] == 10
    assert body["running"] is True  # …but the in-flight fact is still readable


async def test_run_continue_requires_a_terminal_root_and_an_idle_session_tree(
    client: httpx.AsyncClient,
    service_app,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = (await _create(client))["id"]
    sessions = SessionRepository()
    root = await SessionService().create_root(
        LOCAL_USER_ID,
        kind=SessionKind.SCHEDULED,
        schedule_id=sid,
    )
    await persist_session_turn(
        root,
        UserInput(text="delegate report"),
        {"state": {"subagents": {"calls": [{"session_id": "child"}]}}},
    )
    child = await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=root.id,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
    )

    monkeypatch.setattr(
        service_app.state.invocations,
        "is_running",
        lambda session_id: session_id == child.id,
    )
    running = (await client.get(f"/schedules/{sid}")).json()["runs"][0]
    assert running["running"] is True
    assert running["can_continue"] is False

    monkeypatch.setattr(service_app.state.invocations, "is_running", lambda _session_id: False)
    parked = (await client.get(f"/schedules/{sid}")).json()["runs"][0]
    assert parked["running"] is False
    assert parked["can_continue"] is False

    await persist_session_turn(
        root,
        UserInput(text="children joined"),
        {"state": {}},
        last_answer="done",
    )
    finished = (await client.get(f"/schedules/{sid}")).json()["runs"][0]
    assert finished["can_continue"] is True
