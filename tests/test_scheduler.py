"""SchedulerService — the in-process cron engine (path A).

Drives the service directly with a fake ``AgentInvocation`` (no real LLM) and a
stubbed workspace init, so we assert the firing contract deterministically:
a due schedule creates a scheduled Session run under ``execution_mode='full'``
and records ``last_run_at``; an ``AWAITING`` run blocks the next fire (D8/B1).
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator

import pytest

from src.amphi_service.auth import LOCAL_USER_ID, seed_local_user
from src.amphi_service.runtime import _scheduler
from src.amphi_service.runtime import SchedulerService, SessionService, SystemEventBroker
from src.amphi_store import (
    ScheduleRepository,
    SessionKind,
    SessionRecord,
    SessionRepository,
    SessionStatus,
)
from src.amphi_store import Repository

_EVERY_SECOND = "* * * * * *"  # 6-field, seconds-first


class FakeInvocations:
    """Records ``arun`` calls; returns an immediately-completed task (no LLM)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def arun(self, session_id: str, user_input, *, execution_mode=None):
        self.calls.append({"session_id": session_id, "goal": user_input, "mode": execution_mode})

        async def _noop() -> None:
            return None

        return asyncio.create_task(_noop())


@pytest.fixture
async def seeded_repo(
    connected_repo,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> AsyncIterator[None]:
    await seed_local_user()
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path / "sessions"))
    monkeypatch.setattr(_scheduler, "notify", lambda title, message: None)
    yield


async def test_fires_scheduled_session_under_full_mode(seeded_repo) -> None:
    schedules = ScheduleRepository()
    sched = await schedules.create(LOCAL_USER_ID, name="秒跑", desc="每秒执行的任务", cron=_EVERY_SECOND)

    fake = FakeInvocations()
    svc = SchedulerService(fake, SessionService(), system_events=SystemEventBroker(), tick_seconds=1.0)
    await svc.start()
    await asyncio.sleep(2.5)
    await svc.stop()

    assert len(fake.calls) >= 1
    assert all(c["mode"] == "full" for c in fake.calls)          # D5
    assert all(c["goal"] == "每秒执行的任务" for c in fake.calls)  # desc as goal

    got = await schedules.get(LOCAL_USER_ID, sched.id)
    assert got.last_run_at is not None
    assert got.next_run_at is not None

    runs = await SessionRepository().list_scheduled(sched.id)
    assert len(runs) >= 1
    assert all(r.kind is SessionKind.SCHEDULED for r in runs)


async def test_awaiting_run_does_not_block_next_fire(seeded_repo) -> None:
    # Overlap is fixed to 'overlap': an AWAITING run does NOT block the next fire
    # (a run stuck waiting for a human never blocks the schedule forever).
    schedules = ScheduleRepository()
    sched = await schedules.create(LOCAL_USER_ID, name="卡住", desc="会等人", cron=_EVERY_SECOND)

    async with Repository._sessionmaker() as s:
        s.add(SessionRecord(
            id="session_awaiting", user_id=LOCAL_USER_ID, workspace_root="/tmp/x",
            status=SessionStatus.AWAITING, kind=SessionKind.SCHEDULED, schedule_id=sched.id,
        ))
        await s.commit()

    fake = FakeInvocations()
    svc = SchedulerService(fake, SessionService(), system_events=SystemEventBroker(), tick_seconds=1.0)
    await svc._fire(sched)  # fires despite the AWAITING run (no occupancy gate)
    await asyncio.sleep(0.05)
    assert len(fake.calls) == 1


async def test_run_now_fires(seeded_repo) -> None:
    schedules = ScheduleRepository()
    sched = await schedules.create(LOCAL_USER_ID, name="手动", desc="立即跑", cron=_EVERY_SECOND)

    fake = FakeInvocations()
    svc = SchedulerService(fake, SessionService(), system_events=SystemEventBroker(), tick_seconds=1.0)
    await svc.run_now(sched)
    await asyncio.sleep(0.05)
    assert len(fake.calls) == 1
    assert fake.calls[0]["mode"] == "full"


@pytest.mark.parametrize(
    ("desc", "expected"),
    [
        ("Summarise yesterday's pull requests", ("Scheduled task failed", "“Daily report” failed this run.")),
        ("汇总昨天的 pull request", ("定时任务失败", "「Daily report」本次运行失败")),
    ],
)
async def test_failed_schedule_notification_follows_the_task_language(
    seeded_repo, monkeypatch: pytest.MonkeyPatch, desc: str, expected: tuple[str, str],
) -> None:
    """No client is connected when a schedule fires, so the notification language comes from
    the task the user wrote — the only language signal that survives to run time."""
    notices: list[tuple[str, str]] = []
    monkeypatch.setattr(_scheduler, "notify", lambda title, message: notices.append((title, message)))

    async def _failed() -> None:
        raise RuntimeError("boom")

    task = asyncio.create_task(_failed())
    await asyncio.sleep(0)
    await SchedulerService(FakeInvocations(), SessionService(), system_events=SystemEventBroker())._after_run(
        "Daily report", "missing", task, desc,
    )

    assert notices == [expected]


async def test_failed_schedule_notification_prefers_the_declared_locale(
    seeded_repo, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The locale captured at creation time outranks the desc heuristic: a one-word
    or path-heavy desc carries no language signal (and desc is model-authored
    anyway), which used to drop an English user's notifications to Chinese."""
    notices: list[tuple[str, str]] = []
    monkeypatch.setattr(_scheduler, "notify", lambda title, message: notices.append((title, message)))

    async def _failed() -> None:
        raise RuntimeError("boom")

    task = asyncio.create_task(_failed())
    await asyncio.sleep(0)
    await SchedulerService(FakeInvocations(), SessionService(), system_events=SystemEventBroker())._after_run(
        "Backup", "missing", task, "Backup", locale="en",
    )

    assert notices == [("Scheduled task failed", "“Backup” failed this run.")]


async def test_failed_run_prefers_gui_notification_over_os_notify(
    seeded_repo, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a gui subscriber on the system bus the OS notifier must stay
    silent — the desktop client owns the toast. The published event carries
    the same pre-localized strings the OS path would have shown."""
    from src.amphi_service.protocol import ScheduleNotifyEvent
    notices: list[tuple[str, str]] = []
    monkeypatch.setattr(_scheduler, "notify", lambda title, message: notices.append((title, message)))
    broker = SystemEventBroker()
    gen = broker.subscribe(tag="gui")
    received = asyncio.create_task(anext(gen))
    await asyncio.sleep(0)

    async def _failed() -> None:
        raise RuntimeError("boom")

    task = asyncio.create_task(_failed())
    await asyncio.sleep(0)
    await SchedulerService(
        FakeInvocations(), SessionService(), system_events=broker,
    )._after_run("Backup", "missing", task, "Backup", locale="en", schedule_id="sched-1")

    event = await received
    assert isinstance(event, ScheduleNotifyEvent)
    assert event.kind == "failed"
    assert event.title == "Scheduled task failed"
    assert event.body == "“Backup” failed this run."
    assert event.session_id == "missing"
    assert event.schedule_id == "sched-1"
    assert event.schedule_name == "Backup"
    assert notices == []
    await gen.aclose()


async def test_failed_run_falls_back_to_os_notify_without_gui(
    seeded_repo, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cli-only subscriber doesn't count: it receives the broadcast frame
    but can't toast, so the OS notifier must still fire."""
    notices: list[tuple[str, str]] = []
    monkeypatch.setattr(_scheduler, "notify", lambda title, message: notices.append((title, message)))
    broker = SystemEventBroker()
    gen = broker.subscribe(tag="cli")
    received = asyncio.create_task(anext(gen))
    await asyncio.sleep(0)

    async def _failed() -> None:
        raise RuntimeError("boom")

    task = asyncio.create_task(_failed())
    await asyncio.sleep(0)
    await SchedulerService(
        FakeInvocations(), SessionService(), system_events=broker,
    )._after_run("Backup", "missing", task, "Backup", locale="en")

    assert notices == [("Scheduled task failed", "“Backup” failed this run.")]
    await received
    await gen.aclose()


async def test_create_schedule_captures_the_active_request_locale(seeded_repo) -> None:
    from src.amphi_agent._schedules import ScheduleLibrary
    from src.amphi_service.i18n import use_locale

    library = await ScheduleLibrary(LOCAL_USER_ID).load()
    with use_locale("en"):
        schedule = await library.create("Backup", "Backup", _EVERY_SECOND)

    rows = await ScheduleRepository().list_for_user(LOCAL_USER_ID)
    assert [(row.id, row.locale) for row in rows] == [(schedule.schedule_id, "en")]


async def test_scheduled_run_cannot_create_schedule(seeded_repo) -> None:
    # Self-propagation guard: create_schedule must refuse inside a scheduled run
    # (else a "创建定时任务" goal multiplies every fire → runaway), but still work
    # from a normal interactive (USER) session.
    import types

    from bridgic.amphibious.builtin_tools import current_agent

    from src.amphi_agent._schedules import ScheduleLibrary
    from src.amphi_agent.tools._schedule import create_schedule

    session = types.SimpleNamespace(user_id=LOCAL_USER_ID, kind=SessionKind.SCHEDULED)
    context = types.SimpleNamespace(
        session=session,
        schedules=await ScheduleLibrary(LOCAL_USER_ID, mutable=False).load(),
    )
    agent = types.SimpleNamespace(ctx=context)

    token = current_agent.set(agent)
    try:
        with pytest.raises(ValueError, match="定时任务"):
            await create_schedule("增殖", "创建一个定时任务", "0 0 9 * * *")
        assert await ScheduleRepository().list_for_user(LOCAL_USER_ID) == []

        session.kind = SessionKind.USER  # same agent, now an interactive session
        context.schedules = await ScheduleLibrary(LOCAL_USER_ID).load()
        msg = await create_schedule("正常", "普通会话建的任务", "0 0 9 * * *")
        assert "已创建定时任务" in msg
        assert len(await ScheduleRepository().list_for_user(LOCAL_USER_ID)) == 1
    finally:
        current_agent.reset(token)


async def test_scheduled_sessions_excluded_from_conversation_list(seeded_repo) -> None:
    # A scheduled run is a root Session but must NOT surface in the user's
    # conversation list (else a frequent schedule floods the sidebar). It stays
    # reachable by id so the schedule detail can still open the run.
    sessions = SessionService()
    user_sess = await sessions.create_root(LOCAL_USER_ID, kind=SessionKind.USER)
    sched_sess = await sessions.create_root(
        LOCAL_USER_ID, kind=SessionKind.SCHEDULED, schedule_id="sched_x",
    )

    sessions = SessionRepository()
    listed = {s.id for s in await sessions.list_for_user(LOCAL_USER_ID)}
    assert user_sess.id in listed
    assert sched_sess.id not in listed
    assert await sessions.load_by_id(sched_sess.id) is not None  # openable by id


async def test_kill_cancels_every_inflight_run(seeded_repo) -> None:
    # A3: overlap (always on) can launch a second run while the first is still in
    # flight; BOTH handles must be tracked (a scalar drops the older one) and
    # kill must cancel every in-flight run, not just the newest.
    sched = await ScheduleRepository().create(
        LOCAL_USER_ID, name="并发", desc="长跑", cron=_EVERY_SECOND,
    )

    class SlowInvocations:
        async def arun(self, session_id, user_input, *, execution_mode=None):
            async def _hang() -> None:
                await asyncio.sleep(3600)

            return asyncio.create_task(_hang())

    svc = SchedulerService(SlowInvocations(), SessionService(), system_events=SystemEventBroker(), tick_seconds=1.0)
    await svc._fire(sched)  # overlap → no gate
    await svc._fire(sched)  # second concurrent run
    await asyncio.sleep(0.05)
    assert svc.is_running(sched.id)
    assert len(svc._running[sched.id]) == 2  # both handles retained

    assert await svc.kill(sched.id) is True
    await asyncio.sleep(0.05)  # let cancellations + _on_done propagate
    assert svc.is_running(sched.id) is False  # both cleaned up
    await svc.stop()


async def test_update_schedule_edits_in_place(seeded_repo) -> None:
    # #7: editing must UPDATE the existing schedule (PATCH), never create a
    # duplicate. Gated to interactive (USER) sessions; unknown id → ValueError.
    import types

    from bridgic.amphibious.builtin_tools import current_agent

    from src.amphi_agent._schedules import ScheduleLibrary
    from src.amphi_agent.tools._schedule import (
        create_schedule,
        get_schedule,
        list_schedules,
        update_schedule,
    )

    session = types.SimpleNamespace(user_id=LOCAL_USER_ID, kind=SessionKind.USER)
    context = types.SimpleNamespace(
        session=session,
        schedules=await ScheduleLibrary(LOCAL_USER_ID).load(),
    )
    agent = types.SimpleNamespace(ctx=context)

    token = current_agent.set(agent)
    try:
        await create_schedule("原名", "原任务", "0 0 9 * * *")
        sid = (await ScheduleRepository().list_for_user(LOCAL_USER_ID))[0].id
        assert sid in await list_schedules()
        assert "任务：原任务" in await get_schedule(sid)

        msg = await update_schedule(sid, name="新名", cron="0 30 8 * * *", enabled=False)
        assert "已更新定时任务" in msg
        after = await ScheduleRepository().get(LOCAL_USER_ID, sid)
        assert after.name == "新名"
        assert after.cron == "0 30 8 * * *"
        assert after.desc == "原任务"  # omitted field untouched (PATCH)
        assert after.enabled is False
        # edit, not duplicate → still exactly one schedule
        assert len(await ScheduleRepository().list_for_user(LOCAL_USER_ID)) == 1

        with pytest.raises(ValueError, match="未找到"):
            await update_schedule("sched_missing", name="x")

        session.kind = SessionKind.SCHEDULED  # scheduled run must not edit schedules
        context.schedules = await ScheduleLibrary(LOCAL_USER_ID, mutable=False).load()
        with pytest.raises(ValueError, match="定时任务运行期间"):
            await update_schedule(sid, name="x")
    finally:
        current_agent.reset(token)


async def test_delete_schedule_removes_and_kills(seeded_repo) -> None:
    # Deleting a schedule drops the row AND cancels any run already in flight
    # (via the runtime AgentInvocation bound to the context). Gated to
    # interactive (USER) sessions; unknown id → ValueError.
    import types

    from bridgic.amphibious.builtin_tools import current_agent

    from src.amphi_agent._schedules import ScheduleLibrary
    from src.amphi_agent.tools._schedule import create_schedule, delete_schedule

    killed: list[str] = []

    class FakeInvocations:
        async def kill_schedule(self, schedule_id: str) -> None:
            killed.append(schedule_id)

    session = types.SimpleNamespace(user_id=LOCAL_USER_ID, kind=SessionKind.USER)
    context = types.SimpleNamespace(
        session=session,
        schedules=await ScheduleLibrary(LOCAL_USER_ID).load(),
        invocations=FakeInvocations(),
    )
    agent = types.SimpleNamespace(ctx=context)

    token = current_agent.set(agent)
    try:
        await create_schedule("待删", "临时任务", "0 0 9 * * *")
        sid = (await ScheduleRepository().list_for_user(LOCAL_USER_ID))[0].id

        msg = await delete_schedule(sid)
        assert "已删除定时任务" in msg
        assert sid in msg
        # Row is gone.
        assert await ScheduleRepository().get(LOCAL_USER_ID, sid) is None
        assert len(await ScheduleRepository().list_for_user(LOCAL_USER_ID)) == 0
        # In-flight run was cancelled through the bound invocation.
        assert killed == [sid]

        with pytest.raises(ValueError, match="未找到"):
            await delete_schedule("sched_missing")

        session.kind = SessionKind.SCHEDULED  # scheduled run must not delete schedules
        context.schedules = await ScheduleLibrary(LOCAL_USER_ID, mutable=False).load()
        with pytest.raises(ValueError, match="定时任务运行期间"):
            await delete_schedule("sched_whatever")
    finally:
        current_agent.reset(token)


async def test_duplicate_copies_transcript_to_new_session(seeded_repo) -> None:
    # #3: 继续对话 = 整体复制一份。copy_to_session copies every turn (new turn id,
    # same ordinal, re-owned by the dest session) so the duplicate carries the
    # transcript and can continue.
    from src.amphi_store import SessionTurnRepository, TurnStatus
    from src.amphi_store import UserInput

    sessions = SessionService()
    source = await sessions.create_root(LOCAL_USER_ID, kind=SessionKind.SCHEDULED)
    turns = SessionTurnRepository()
    await turns.append_result(
        LOCAL_USER_ID,
        session_id=source.id,
        expected_tail_id=None,
        user_input=UserInput(text="定时任务:写 a.txt"),
        ota_records=[],
        agent_state={},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="已写入",
        error=None,
        input_tokens=1,
        output_tokens=2,
    )

    dest = await sessions.create_root(LOCAL_USER_ID, kind=SessionKind.USER)
    assert await turns.copy_to_session(source.id, dest.id, LOCAL_USER_ID) == 1

    convo = await turns.list_conversation(LOCAL_USER_ID, dest.id)
    assert len(convo) == 1
    assert convo[0].user_input.text == "定时任务:写 a.txt"
    assert convo[0].final_answer == "已写入"
    assert convo[0].session_id == dest.id  # re-owned by the duplicate


def test_to_local_iso_renders_local_naive() -> None:
    # Run history 时间 must be local wall-clock (no tz suffix), matching the
    # schedule's local last/next_run — not UTC. tz-independent assertions.
    from datetime import datetime, timezone

    from src.amphi_service.handler._schedules_handler import _to_local_iso

    aware = _to_local_iso(datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc))
    naive = _to_local_iso(datetime(2026, 1, 1, 12, 0, 0))  # session created_at is UTC
    assert "+00:00" not in aware and "T" in aware  # naive local
    assert aware == naive  # naive input is labeled UTC → identical result
