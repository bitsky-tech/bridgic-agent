import asyncio
from types import SimpleNamespace

from src.amphi_agent import InvocationDisposition
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import SessionRepository, SessionTurnRepository, SubAgentMode, TurnStatus, UserInput


async def test_agent_rpc_runs_root_and_child_sessions(client, service_app, monkeypatch) -> None:
    await client.post("/me/credentials", json={"api_key": "test-key"})
    created = await client.post("/sessions", json={})
    session_id = created.json()["id"]
    calls: list[tuple[str, str, str, str | None, str | None]] = []

    async def schedule(
        kind: str,
        requested_session_id: str,
        user_input: str,
        parent_call_id=None,
        execution_mode=None,
    ):
        calls.append((kind, requested_session_id, user_input, parent_call_id, execution_mode))
        result = SimpleNamespace(
            session_id=("session-child" if kind == "child" else requested_session_id),
            turn_id=f"turn-{kind}",
            outcome=SimpleNamespace(
                disposition=InvocationDisposition.COMPLETED,
                answer=f"{kind} answer",
            ),
        )
        return asyncio.create_task(asyncio.sleep(0, result=result))

    monkeypatch.setattr(
        service_app.state.invocations,
        "arun",
        lambda requested_session_id, user_input: schedule("root", requested_session_id, user_input),
    )
    monkeypatch.setattr(
        service_app.state.invocations,
        "arun_subagent",
        lambda requested_session_id, user_input, parent_call_id=None, execution_mode=None: schedule(
            "child", requested_session_id, user_input, parent_call_id, execution_mode,
        ),
    )
    headers = {"Authorization": f"Bearer {service_app.state.auth.current_token}"}

    root = await client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "root input"},
        headers=headers,
    )
    child = await client.post(
        f"/api/agent/sessions/{session_id}/subagents",
        json={
            "input": "child input",
            "parent_tool_call_id": "call-bash",
            "execution_mode": "full",
        },
        headers=headers,
    )

    assert root.status_code == 200
    assert root.json()["answer"] == "root answer"
    assert child.status_code == 200
    assert child.json()["session_id"] == "session-child"
    assert calls == [
        ("root", session_id, "root input", None, None),
        ("child", session_id, "child input", "call-bash", "full"),
    ]


async def test_agent_rpc_rejects_an_invalid_execution_mode(client, service_app) -> None:
    """The RPC boundary accepts only the three supported execution modes."""
    await client.post("/me/credentials", json={"api_key": "test-key"})
    session_id = (await client.post("/sessions", json={})).json()["id"]
    headers = {"Authorization": f"Bearer {service_app.state.auth.current_token}"}

    response = await client.post(
        f"/api/agent/sessions/{session_id}/subagents",
        json={
            "input": "attempt elevation",
            "parent_tool_call_id": "call-bash",
            "execution_mode": "superuser",
        },
        headers=headers,
    )

    assert response.status_code == 422
    assert await SessionRepository().list_children(LOCAL_USER_ID, session_id) == []


async def test_agent_status_reports_live_task_lifecycle(
    client, anonymous_client, service_app,
) -> None:
    endpoint = "/api/agent/status"
    invocations = service_app.state.invocations

    assert (await anonymous_client.get(endpoint)).status_code == 401
    assert (await client.get(endpoint)).json() == {"running": False}

    release = asyncio.Event()
    task = asyncio.create_task(release.wait())
    session_id = "session-agent-status-test"
    invocations._tasks[session_id] = task

    def unregister(completed: asyncio.Task) -> None:
        if invocations._tasks.get(session_id) is completed:
            invocations._tasks.pop(session_id, None)

    task.add_done_callback(unregister)
    try:
        assert (await client.get(endpoint)).json() == {"running": True}
        release.set()
        await task
        await asyncio.sleep(0)
        assert (await client.get(endpoint)).json() == {"running": False}
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if invocations._tasks.get(session_id) is task:
            invocations._tasks.pop(session_id, None)


async def test_agent_rpc_rejects_a_child_session_as_another_child_parent(client, service_app) -> None:
    await client.post("/me/credentials", json={"api_key": "test-key"})
    root = (await client.post("/sessions", json={})).json()
    child = await SessionRepository().create_child(
        LOCAL_USER_ID,
        parent_session_id=root["id"],
        parent_call_id="call-root",
        subagent_mode=SubAgentMode.RPC,
    )
    headers = {"Authorization": f"Bearer {service_app.state.auth.current_token}"}

    response = await client.post(
        f"/api/agent/sessions/{child.id}/subagents",
        json={"input": "nested task", "parent_tool_call_id": "call-child"},
        headers=headers,
    )

    assert response.status_code == 409
    assert "Child Sessions cannot create sub-agents" in response.json()["detail"]
    assert await SessionRepository().list_children(LOCAL_USER_ID, child.id) == []


async def test_agent_rpc_status_reads_the_latest_turn(client, service_app) -> None:
    created = await client.post("/sessions", json={})
    session_id = created.json()["id"]
    await SessionTurnRepository().append_result(
        "local",
        session_id=session_id,
        expected_tail_id=None,
        user_input=UserInput(text="inspect"),
        ota_records=[],
        agent_state={},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="done",
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    headers = {"Authorization": f"Bearer {service_app.state.auth.current_token}"}

    response = await client.get(
        f"/api/agent/sessions/{session_id}/run",
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {
        "session_id": session_id,
        "status": "completed",
        "answer": "done",
        "error": None,
    }
