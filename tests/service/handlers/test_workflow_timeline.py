import httpx
import pytest

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import SessionRepository, SessionTurnRecord, SessionTurnRepository, SubAgentMode, TurnStatus, UserInput


@pytest.mark.parametrize("status", list(TurnStatus))
async def test_session_returns_complete_turns_across_history_pages(service_client: httpx.AsyncClient, status: TurnStatus) -> None:
    """OTA boundaries and Turn state survive a newer Turn and pagination without display inference."""
    session = (await service_client.post("/sessions", json={"model": "test-model"})).json()
    repository = SessionTurnRepository()
    original = await repository.append_result(
        LOCAL_USER_ID, session_id=session["id"], expected_tail_id=None,
        user_input=UserInput(text="Summarize", blocks=[{"type": "text", "value": "Summarize"}]),
        ota_records=[{
            "think_scope": {"mode": "run_workflow", "stage": "execute", "session_history": "stage_scoped_v2"},
            "reasoning_content": "Choose directory", "custom_round_field": {"preserve": True},
        }],
        agent_state={"think": {"mode": "run_workflow", "stage": "execute", "workflow_id": "wf", "generation": "gen", "step_index": 0}},
        browser_tool_loaded=True, workspace_tools_loaded=True, skills_tool_loaded=True,
        status=status, final_answer=None, error="Failed" if status is TurnStatus.FAILED else None,
        context_usage={"input_tokens": 42}, model="test-model", execution_mode="auto", max_rounds=20,
    )
    expected = original.model_dump(mode="json")
    url = f"/sessions/{session['id']}/messages?format=turns"
    assert (await service_client.get(url)).json()["turns"] == [expected]
    newer = await repository.append_result(
        LOCAL_USER_ID, session_id=session["id"], expected_tail_id=original.id,
        user_input=UserInput(text="Continue"), ota_records=[], agent_state={"think": {"mode": "normal", "stage": "main"}},
        browser_tool_loaded=False, workspace_tools_loaded=False, skills_tool_loaded=False,
        status=TurnStatus.COMPLETED, final_answer="Done", error=None, context_usage={},
    )
    complete = (await service_client.get(url)).json()
    assert complete["turns"] == [expected, newer.model_dump(mode="json")]
    latest = (await service_client.get(url, params={"format": "turns", "limit": 1})).json()
    assert latest["turns"] == [newer.model_dump(mode="json")]
    older = (await service_client.get(url, params={"format": "turns", "limit": 1, "before_ordinal": latest["next_before"]})).json()
    assert older["turns"] == [expected]
    assert older["pending_request"] is None
    stored = await repository.list_conversation(LOCAL_USER_ID, session["id"])
    assert stored[0].model_dump(mode="json") == expected


@pytest.mark.parametrize("format", ["messages", "turns"])
async def test_session_paginates_foreground_children_with_their_parent_calls(service_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, format: str) -> None:
    """Only page-related foreground Turns are loaded; background hierarchy stays complete."""
    session = (await service_client.post("/sessions", json={"model": "test-model"})).json()
    repository = SessionTurnRepository()

    async def append(session_id: str, expected_tail_id: str | None = None, **overrides: object) -> SessionTurnRecord:
        fields = {
            "user_input": UserInput(text="Review"), "ota_records": [], "agent_state": {},
            "browser_tool_loaded": False, "workspace_tools_loaded": False, "skills_tool_loaded": False,
            "status": TurnStatus.COMPLETED, "final_answer": "Reviewed", "error": None, "context_usage": {},
            **overrides,
        }
        return await repository.append_result(LOCAL_USER_ID, session_id=session_id, expected_tail_id=expected_tail_id, **fields)

    old = await append(session["id"], ota_records=[{"action_result": {"results": [
        {"tool_name": "run_subagent", "tool_id": "old-call", "tool_arguments": {"goal": "Old review"}},
    ]}}])
    current = await append(session["id"], old.id, status=TurnStatus.AWAITING_SUBAGENTS, ota_records=[{"action_result": {"results": [
        {"tool_name": "run_subagent", "tool_id": "current-call", "tool_arguments": {"goal": "Current review"}},
        {"tool_name": "execute", "tool_id": "rpc-call", "tool_arguments": {"command": "review"}},
    ]}}], agent_state={"subagents": {"calls": [{"tool_call_id": "current-call", "goal": "Current review"}]}})
    child_records = {}
    for child_id, call_id, mode in [
        ("old-child", "old-call", SubAgentMode.BLOCKING),
        ("current-child", "current-call", SubAgentMode.BLOCKING),
        ("rpc-child", "rpc-call", SubAgentMode.RPC),
        ("starting-child", "rpc-call", SubAgentMode.RPC),
        ("background-child", "background-call", SubAgentMode.BACKGROUND),
    ]:
        await SessionRepository().create_child(
            LOCAL_USER_ID, parent_session_id=session["id"], parent_call_id=call_id,
            subagent_mode=mode, session_id=child_id, title=child_id,
        )
        child_records[child_id] = None if child_id == "starting-child" else await append(
            child_id, ota_records=[{"reasoning_content": "x" * 1_000_000 if child_id == "old-child" else "Complete trace", "custom": {"preserve": True}}],
        )
    loaded = []
    original_latest = SessionTurnRepository.latest

    async def tracked_latest(self: SessionTurnRepository, session_id: str, user_id: str) -> SessionTurnRecord | None:
        loaded.append(session_id)
        return await original_latest(self, session_id, user_id)

    monkeypatch.setattr(SessionTurnRepository, "latest", tracked_latest)
    url = f"/sessions/{session['id']}/messages"
    response = await service_client.get(url, params={"format": format, "limit": 1})
    latest = response.json()
    assert response.status_code == 200
    assert len(response.content) < 20_000
    assert set(loaded) == {"current-child", "rpc-child", "starting-child", "background-child"}
    assert latest["children"] == [{"session_id": "background-child", "title": "background-child", "subagent_mode": "background", "status": "completed"}]
    if format == "turns":
        assert latest["turns"] == [current.model_dump(mode="json")]
        assert set(latest["subagents"]) == {"current-call", "rpc-call"}
        for children in latest["subagents"].values():
            for child in children:
                stored = child_records[child["session_id"]]
                assert child["turn"] == (stored.model_dump(mode="json") if stored else None)
    else:
        blocks = latest["messages"][-1]["blocks"]
        assert any(block.get("invocationId") == "current-child" for block in blocks)
        assert {child["invocationId"] for block in blocks for child in block.get("subagents", [])} == {"rpc-child", "starting-child"}
    loaded.clear()
    older = (await service_client.get(url, params={"format": format, "limit": 1, "before_ordinal": latest["next_before"]})).json()
    assert set(loaded) == {"old-child", "background-child"}
    assert older["children"] == latest["children"]
    if format == "turns":
        assert set(older["subagents"]) == {"old-call"}
        assert older["subagents"]["old-call"][0]["turn"] == child_records["old-child"].model_dump(mode="json")
    loaded.clear()
    empty = (await service_client.get(url, params={"format": format, "limit": 1, "before_ordinal": old.session_ordinal})).json()
    assert set(loaded) == {"background-child"}
    assert empty["children"] == latest["children"]
    if format == "turns":
        assert empty["turns"] == []
        assert empty["subagents"] == {}
