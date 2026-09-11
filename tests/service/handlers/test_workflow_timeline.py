import httpx
import pytest

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import SessionTurnRepository, TurnStatus, UserInput


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
