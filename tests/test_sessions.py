"""``/sessions`` — CRUD + per-session commands, user-scoped + DB-backed.

Consolidated into lifecycle flows: one case walks create → list → detail →
delete → 404 rather than one case per verb. Behaviour anchors kept inside
the flows: the turn-gate 409s (reset / compact must not race a live turn)
and the retired-endpoint guards.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from src.amphi_agent._workspace import Workspace
from src.amphi_service._app import ServiceApp
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_service.runtime import SessionService
from src.amphi_store import (
    SessionMountRepository,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
    SessionTurnRepository,
    UserInput,
)
from ._session_turns import persist_session_turn


async def _park_running_turn(invocations: object, session_id: str) -> asyncio.Task:
    """Park a task in the Invocation registry without driving an Agent."""
    task = asyncio.create_task(asyncio.Event().wait())
    invocations._tasks[session_id] = task

    def release(completed: asyncio.Task) -> None:
        if invocations._tasks.get(session_id) is completed:
            invocations._tasks.pop(session_id, None)

    task.add_done_callback(release)
    return task


async def test_reset_cancels_parked_root_and_clears_turns(
    client: httpx.AsyncClient,
) -> None:
    """Reset removes conversation indexes and makes a parked Root non-runnable."""
    session_id = (await client.post("/sessions", json={})).json()["id"]
    record = await SessionRepository().load(session_id, LOCAL_USER_ID)
    assert record is not None
    await persist_session_turn(
        record,
        UserInput(text="choose"),
        {
            "state": {
                "interaction": {
                    "questions": [{
                        "question": "Continue?",
                        "options": [{"label": "yes"}, {"label": "no"}],
                    }],
                },
            },
            "ota_record": [{}],
        },
        status=SessionStatus.AWAITING,
    )
    latest = await SessionTurnRepository().latest(session_id, LOCAL_USER_ID)
    assert latest is not None
    turn_id = latest.id

    response = await client.post(f"/sessions/{session_id}/reset")

    assert response.status_code == 204
    turn = await SessionTurnRepository().get(
        LOCAL_USER_ID,
        turn_id,
    )
    assert turn is None
    cleared = await SessionRepository().load(session_id, LOCAL_USER_ID)
    assert cleared is not None and cleared.status == SessionStatus.FINISH
    assert await SessionTurnRepository().list_conversation(
        LOCAL_USER_ID,
        cleared.id,
    ) == []


async def test_session_crud_lifecycle(client: httpx.AsyncClient) -> None:
    """One session's full life: create visible work without initializing runtime →
    list → detail → per-session commands (rename / messages / tokens /
    reset) → delete → 404. Creation variants, every command's unknown-id 404, the
    404 help text, and the phase-2/3 retired endpoints all ride along."""
    # Create: 201 + full detail shape (model is stamped from current_model).
    created = (await client.post("/sessions", json={})).json()
    sid = created["id"]
    assert sid.startswith("session_")
    assert created["model"] == "mock-model"  # selected by the product test fixture
    assert created["tokens"] == 0
    assert created["last_answer"] is None
    workspace_root = Path(created["workspace_root"])
    assert workspace_root.name == sid
    assert workspace_root.is_absolute()
    assert sorted(path.name for path in workspace_root.iterdir()) == [".work"]
    assert not (workspace_root / ".git").exists()
    assert not (workspace_root / "pyproject.toml").exists()

    mounts = await SessionMountRepository().list_for_session(sid, "local")
    assert len(mounts) == 1
    assert mounts[0].name == ".work"
    assert mounts[0].abs_path == str(workspace_root / ".work")

    # List: the new session shows up as a summary row.
    listing = (await client.get("/sessions")).json()
    assert [s["id"] for s in listing] == [sid]
    assert listing[0]["last_answer_preview"] is None

    # Detail.
    detail = await client.get(f"/sessions/{sid}")
    assert detail.status_code == 200
    assert detail.json()["id"] == sid

    # Variants: ``model`` is recorded; client ``workspace_root`` is ignored.
    alt = (await client.post("/sessions", json={"model": "alt-model"})).json()
    assert alt["model"] == "alt-model"
    ws = (await client.post("/sessions", json={"workspace_root": "/tmp/x"})).json()
    assert ws["workspace_root"] != "/tmp/x"
    assert Path(ws["workspace_root"]).name == ws["id"]

    # --- Per-session commands against the fresh session. ---
    # Rename → title shows in the list summary (column-only rename).
    resp = await client.patch(f"/sessions/{sid}", json={"title": "My project"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "My project"
    row = next(s for s in (await client.get("/sessions")).json() if s["id"] == sid)
    assert row["title"] == "My project"

    # Transcript and tokens are empty when fresh.
    resp = await client.get(f"/sessions/{sid}/messages")
    assert resp.status_code == 200
    assert resp.json() == {
        "messages": [],
        "pending_request": None,
        "has_more": False,
        "next_before": None,
        "thinking_mode": None,
        "workflow_run": None,
        "children": [],
    }
    assert (await client.get(f"/sessions/{sid}/tokens")).json() == {"tokens": 0}

    # Reset wipes last_used_model (detail model → '').
    assert (await client.post(f"/sessions/{sid}/reset")).status_code == 204
    assert (await client.get(f"/sessions/{sid}")).json()["model"] == ""

    # Every command 404s on an unknown id.
    assert (await client.patch("/sessions/nope", json={"title": "x"})).status_code == 404
    assert (await client.get("/sessions/nope/messages")).status_code == 404
    assert (await client.get("/sessions/nope/tokens")).status_code == 404
    assert (await client.post("/sessions/nope/reset")).status_code == 404

    # Retired endpoints (phase 2/3) are unreachable.
    assert (await client.get("/sessions/saved")).status_code == 404
    assert (await client.post("/sessions/load", json={"id": "x"})).status_code in (404, 405)
    assert (await client.post(f"/sessions/{sid}/save")).status_code == 404
    assert (await client.post(f"/sessions/{sid}/model", json={"model": "x"})).status_code == 404
    assert (await client.get("/credentials")).status_code == 404

    # --- Delete → 204, then both detail and the unknown-id path are 404. ---
    assert (await client.delete(f"/sessions/{sid}")).status_code == 204
    assert (await client.get(f"/sessions/{sid}")).status_code == 404
    assert (await client.delete(f"/sessions/{sid}")).status_code == 404

    # The 404 names the id and points at the (only) creation path.
    detail_text = (await client.get("/sessions/nonexistent-id")).json()["detail"]
    assert "nonexistent-id" in detail_text
    assert "POST /sessions" in detail_text


async def test_session_delete_removes_parent_and_child_invocations(
    client: httpx.AsyncClient,
) -> None:
    """Deleting a session removes its complete parked invocation tree."""
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = SessionTurnRepository()
    parent_session = await SessionRepository().load(session_id, LOCAL_USER_ID)
    assert parent_session is not None
    child_session = await SessionRepository().create_child(
        LOCAL_USER_ID,
        parent_session_id=session_id,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    await persist_session_turn(
        parent_session,
        UserInput(text="parent"),
        {"state": {"subagents": {"calls": [{
            "session_id": child_session.id,
            "tool_call_id": "call-child",
            "goal": "child",
        }]}}},
    )
    await persist_session_turn(
        child_session,
        UserInput(text="child"),
        {"state": {"interaction": {"questions": []}}},
    )

    listing = (await client.get("/sessions")).json()
    parent_summary = next(row for row in listing if row["id"] == session_id)
    assert parent_summary["status"] == "running"
    assert parent_summary["turn_status"] == "awaiting_subagents"
    detail = (await client.get(f"/sessions/{session_id}")).json()
    assert detail["status"] == "running"
    assert detail["turn_status"] == "awaiting_subagents"
    transcript = (await client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"] is None

    assert (await client.delete(f"/sessions/{session_id}")).status_code == 204
    assert await repository.list_conversation(LOCAL_USER_ID, session_id) == []
    sessions = SessionRepository()
    assert await sessions.load(session_id, LOCAL_USER_ID) is None
    assert await sessions.load(child_session.id, LOCAL_USER_ID) is None


async def test_duplicate_copies_the_session_root_through_session_service(
    client: httpx.AsyncClient,
) -> None:
    """SessionService copies durable files but not legacy local dependency trees."""
    source = (await client.post("/sessions", json={})).json()
    source_record = await SessionRepository().load(source["id"], LOCAL_USER_ID)
    assert source_record is not None
    await persist_session_turn(
        source_record,
        UserInput(text="prepare report"),
        {"state": {}},
        last_answer="ready",
    )
    source_workspace = Workspace(
        source["id"],
        session_root=Path(source["workspace_root"]),
    )
    await source_workspace.prepare_workspace()
    (source_workspace.work_dir / "report.txt").write_text(
        "ready\n",
        encoding="utf-8",
    )
    (source_workspace.session_root / "uv.lock").write_text("version = 1\n", encoding="utf-8")
    (source_workspace.session_root / "pyproject.toml").write_text(
        "[project]\nname = 'copied-user-project'\nversion = '0.1.0'\n",
        encoding="utf-8",
    )
    node_module = source_workspace.session_root / "node_modules" / "demo" / "index.js"
    node_module.parent.mkdir(parents=True)
    node_module.write_text("export default true\n", encoding="utf-8")
    internal_marker = source_workspace.session_root / ".internal" / "copied.txt"
    internal_marker.write_text("internal\n", encoding="utf-8")
    nested_venv = source_workspace.work_dir / "project" / ".venv" / "marker.txt"
    nested_venv.parent.mkdir(parents=True)
    nested_venv.write_text("nested\n", encoding="utf-8")
    legacy_session_venv = source_workspace.session_root / ".venv" / "legacy.txt"
    legacy_session_venv.parent.mkdir()
    legacy_session_venv.write_text("legacy\n", encoding="utf-8")
    source_checkpoint = source_workspace.checkpoints.checkpoint("source snapshot")
    assert source_checkpoint is not None

    response = await client.post(f"/sessions/{source['id']}/duplicate")

    assert response.status_code == 201
    duplicate = response.json()
    duplicate_root = Path(duplicate["workspace_root"])
    assert duplicate["status"] == "completed"
    assert duplicate["last_answer"] == "ready"
    assert (duplicate_root / ".work" / "report.txt").read_text(encoding="utf-8") == "ready\n"
    assert (duplicate_root / "uv.lock").read_text(encoding="utf-8") == "version = 1\n"
    assert not (duplicate_root / "node_modules").exists()
    assert (duplicate_root / ".internal" / "copied.txt").is_file()
    assert (duplicate_root / ".work" / "project" / ".venv" / "marker.txt").is_file()
    assert not (duplicate_root / ".venv").exists()
    assert (duplicate_root / ".git").is_dir()
    assert (duplicate_root / "pyproject.toml").is_file()
    duplicate_workspace = Workspace(duplicate["id"], session_root=duplicate_root)
    assert duplicate_workspace.checkpoints.history(max_count=1)[0]["message"] == "source snapshot"
    await duplicate_workspace.prepare_workspace()
    assert not (duplicate_root / ".venv").exists()
    assert legacy_session_venv.is_file()


async def test_duplicate_rejects_a_live_turn(
    client: httpx.AsyncClient,
    service_app: ServiceApp,
) -> None:
    source = (await client.post("/sessions", json={})).json()
    running = await _park_running_turn(service_app.state.invocations, source["id"])
    try:
        response = await client.post(f"/sessions/{source['id']}/duplicate")
        assert response.status_code == 409
    finally:
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)


async def test_duplicate_rejects_a_session_waiting_for_user_input(
    client: httpx.AsyncClient,
) -> None:
    source = (await client.post("/sessions", json={})).json()
    source_record = await SessionRepository().load(source["id"], LOCAL_USER_ID)
    assert source_record is not None
    await persist_session_turn(
        source_record,
        UserInput(text="approve this action"),
        {"state": {"interaction": {"permission": {"request_id": "permission-1"}}}},
    )

    response = await client.post(
        f"/sessions/{source['id']}/duplicate",
        headers={"Accept-Language": "en-US,en;q=0.9"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Only finished Sessions can be duplicated."
    assert [record["id"] for record in (await client.get("/sessions")).json()] == [source["id"]]


async def test_duplicate_rejects_a_session_without_a_terminal_turn(
    client: httpx.AsyncClient,
) -> None:
    source = (await client.post("/sessions", json={})).json()

    response = await client.post(
        f"/sessions/{source['id']}/duplicate",
        headers={"Accept-Language": "en-US,en;q=0.9"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Only finished Sessions can be duplicated."


async def test_duplicate_rolls_back_when_the_filesystem_copy_fails(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    source = (await client.post("/sessions", json={})).json()
    source_root = Path(source["workspace_root"])
    source_record = await SessionRepository().load(source["id"], LOCAL_USER_ID)
    assert source_record is not None
    await persist_session_turn(source_record, UserInput(text="copy me"), {"state": {}})

    def fail_copy(_source_root: Path, target_root: Path, **_options) -> None:
        (target_root / "partial.txt").write_text("partial\n", encoding="utf-8")
        raise RuntimeError("copy failed")

    monkeypatch.setattr("src.amphi_service.runtime._sessions.shutil.copytree", fail_copy)

    response = await client.post(f"/sessions/{source['id']}/duplicate")

    assert response.status_code == 500
    assert "copy failed" in response.json()["detail"]
    assert sorted(path.name for path in source_root.parent.iterdir()) == [source_root.name]
    assert [record["id"] for record in (await client.get("/sessions")).json()] == [source["id"]]


async def test_duplicate_rolls_back_when_turn_copy_fails(
    client: httpx.AsyncClient,
    monkeypatch,
) -> None:
    source = (await client.post("/sessions", json={})).json()
    source_root = Path(source["workspace_root"])
    source_record = await SessionRepository().load(source["id"], LOCAL_USER_ID)
    assert source_record is not None
    await persist_session_turn(source_record, UserInput(text="copy me"), {"state": {}})

    async def fail_copy(*_args, **_kwargs) -> int:
        raise RuntimeError("turn copy failed")

    monkeypatch.setattr(SessionTurnRepository, "copy_to_session", fail_copy)

    response = await client.post(f"/sessions/{source['id']}/duplicate")

    assert response.status_code == 500
    assert "turn copy failed" in response.json()["detail"]
    assert sorted(path.name for path in source_root.parent.iterdir()) == [source_root.name]
    assert [record["id"] for record in (await client.get("/sessions")).json()] == [source["id"]]


async def test_session_views_separate_background_and_inline_children(client: httpx.AsyncClient) -> None:
    """The sidebar exposes background children while RPC children stay inline."""
    parent_id = (await client.post("/sessions", json={})).json()["id"]
    sessions = SessionRepository()
    parent = await sessions.load(parent_id, LOCAL_USER_ID)
    assert parent is not None
    background = await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=parent_id,
        parent_call_id="call-background",
        subagent_mode=SubAgentMode.BACKGROUND,
        title="后台分析",
    )
    await persist_session_turn(
        background,
        UserInput(text="后台任务"),
        {"state": {"interaction": {"permission": {
            "calls": [],
            "verdicts": [],
            "questions": [],
            "items": [],
        }}}},
    )
    unstarted_background = await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=parent_id,
        parent_call_id="call-unstarted-background",
        subagent_mode=SubAgentMode.BACKGROUND,
        title="尚未开始",
    )
    await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=parent_id,
        parent_call_id="call-blocking",
        subagent_mode=SubAgentMode.BLOCKING,
        title="阻塞分析",
    )
    rpc = await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=parent_id,
        parent_call_id="call-rpc",
        subagent_mode=SubAgentMode.RPC,
        title="脚本分析",
    )
    await persist_session_turn(
        parent,
        UserInput(text="调用脚本子任务"),
        {"ota_record": [{
            "think_result": {
                "step_content": "run child",
                "tool_calls": [{"tool": "bash"}],
            },
            "action_result": {"results": [{
                "tool_id": "call-rpc",
                "tool_name": "bash",
                "tool_arguments": {"command": "amphi agent run 脚本分析"},
                "tool_result": "running",
                "success": True,
            }]},
        }]},
    )

    listing = (await client.get("/sessions")).json()

    assert {record["id"] for record in listing} == {
        parent_id,
        background.id,
        unstarted_background.id,
    }
    child = next(record for record in listing if record["id"] == background.id)
    assert child["title"] == "后台分析"
    assert child["parent_session_id"] == parent_id
    assert child["subagent_mode"] == "background"
    assert child["status"] == "awaiting"
    assert child["turn_status"] == "awaiting_permission"

    transcript = (await client.get(f"/sessions/{parent_id}/messages")).json()
    rpc_block = next(
        block
        for message in transcript["messages"]
        for block in message.get("blocks", [])
        if block.get("toolUseId") == "call-rpc"
    )
    assert rpc_block["subagents"] == [{
        "invocationId": rpc.id,
        "goal": "脚本分析",
        "status": "running",
        "answer": None,
    }]
    children = {child["session_id"]: child for child in transcript["children"]}
    assert children == {
        background.id: {
            "session_id": background.id,
            "title": "后台分析",
            "subagent_mode": "background",
            "status": "awaiting_permission",
        },
        unstarted_background.id: {
            "session_id": unstarted_background.id,
            "title": "尚未开始",
            "subagent_mode": "background",
            "status": "unknown",
        },
    }


async def test_turn_gate_blocks_mutators_and_stop_is_a_real_stop(
    client: httpx.AsyncClient, service_app: ServiceApp,
) -> None:
    """While a turn is live the serial gate blocks ``/reset`` with 409.

    ``/stop`` is a real
    stop — it cancels the AgentInvocation-owned task without destroying this
    Session's long-lived event subscription. Unknown ids 404; stopping an idle
    Session is a no-op, not an error.
    """
    invocations = service_app.state.invocations

    # --- Mutators 409 mid-turn. ---
    await client.post("/me/credentials", json={"api_key": "k", "base_url": "http://x"})
    blocked = (await client.post("/sessions", json={})).json()["id"]
    blocked_task = await _park_running_turn(invocations, blocked)
    assert (await client.post(f"/sessions/{blocked}/reset")).status_code == 409
    assert await invocations.cancel(blocked)
    await asyncio.gather(blocked_task, return_exceptions=True)

    # --- Stop: cancels the task while the Session subscription stays live. ---
    sid = (await client.post("/sessions", json={})).json()["id"]
    agent_task = await _park_running_turn(invocations, sid)
    subscription = service_app.state.session_events.subscribe(sid)
    waiting = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)

    resp = await client.post(f"/sessions/{sid}/stop")
    assert resp.status_code == 200
    assert resp.json() == {"stopped": True, "session_id": sid}

    await asyncio.gather(agent_task, return_exceptions=True)
    assert agent_task.cancelled()
    assert not invocations.is_running(sid)
    assert not waiting.done()

    # Idempotent: stopping again (nothing live) is a no-op, not an error.
    assert (await client.post(f"/sessions/{sid}/stop")).json()["stopped"] is False
    assert (await client.post("/sessions/nope/stop")).status_code == 404

    waiting.cancel()
    await asyncio.gather(waiting, return_exceptions=True)
    await subscription.aclose()


async def test_session_file_read(client: httpx.AsyncClient) -> None:
    """``GET /sessions/{id}/files?path=`` returns a workspace file verbatim
    (the GUI renders ``.work/.build/task.md`` as the build brief from this) — and
    fails closed: traversal/absolute paths 400, missing files/dirs 404."""
    created = (await client.post("/sessions", json={})).json()
    sid = created["id"]
    workspace = Workspace(sid, session_root=Path(created["workspace_root"]))
    build = workspace.work_dir / ".build"
    build.mkdir()
    (build / "task.md").write_text("# Task\nbuild a changelog tool", encoding="utf-8")

    resp = await client.get(f"/sessions/{sid}/files", params={"path": ".work/.build/task.md"})
    assert resp.status_code == 200
    assert resp.json() == {
        "path": ".work/.build/task.md",
        "content": "# Task\nbuild a changelog tool",
    }

    # Missing file and directory targets read as 404 (nothing to render).
    assert (await client.get(f"/sessions/{sid}/files", params={"path": ".work/nope.md"})).status_code == 404
    assert (await client.get(f"/sessions/{sid}/files", params={"path": ".work"})).status_code == 404

    # Containment is fail-closed: absolute / escaping / empty paths are 400.
    for bad in ("/etc/hosts", "../outside.txt", ".work/../../x", ""):
        resp = await client.get(f"/sessions/{sid}/files", params={"path": bad})
        assert resp.status_code == 400, bad

    assert (await client.get("/sessions/nope/files", params={"path": "x"})).status_code == 404


def test_user_blocks_preserve_mention_path() -> None:
    """``path``(挂载内相对路径)必须随 user 消息的 blocks 出网。

    它是 @ 文件芯片身份的一部分:GUI 用 ↑ 调取历史输入时,靠 blocks 反解回
    可交互的芯片。此前这里只映射 id/label/group,存进库的 path 到了前端就丢了,
    历史回放只能退化成纯文本。
    """
    from src.amphi_service.handler._session_handler import _user_blocks

    out = _user_blocks([
        {"type": "text", "value": "看 "},
        {
            "type": "mention",
            "id": "mnt_x",
            "label": "行程单.pdf",
            "group": "文件/文件夹",
            "path": "发票/行程单.pdf",
        },
        {"type": "slash", "id": "build", "label": "构建", "resource": "workflow"},
    ])

    assert out == [
        # 出站把 text 的 ``value`` 改名成 ``text``(与入站 ChatBlock 的差异)。
        {"type": "text", "text": "看 "},
        {
            "type": "mention",
            "id": "mnt_x",
            "label": "行程单.pdf",
            "group": "文件/文件夹",
            "path": "发票/行程单.pdf",
        },
        {"type": "slash", "id": "build", "label": "构建", "resource": "workflow"},
    ]


def test_user_blocks_omit_path_when_absent() -> None:
    """挂载根的 mention 没有 path —— 不能凭空补一个空串。

    多出一个 ``"path": ""`` 会让前端的 segments 相等性比较失配,历史去重
    (相邻重复折叠)随之失效。旧 payload 形状必须逐字保持。
    """
    from src.amphi_service.handler._session_handler import _user_blocks

    out = _user_blocks([{"type": "mention", "id": "m", "label": "发票", "group": "文件/文件夹"}])
    assert out == [{"type": "mention", "id": "m", "label": "发票", "group": "文件/文件夹"}]
    assert "path" not in out[0]
