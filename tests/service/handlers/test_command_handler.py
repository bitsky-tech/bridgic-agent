from typing import Sequence

import httpx

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import SessionRepository, SessionStatus, SessionTurnRepository, TurnStatus, UserInput


async def create_session(service_client: httpx.AsyncClient) -> dict:
    response = await service_client.post("/sessions", json={"model": "test-model"})
    assert response.status_code == 201
    return response.json()


async def seed_turns(session_id: str, token_pairs: Sequence[tuple[int, int]]) -> None:
    repository = SessionTurnRepository()
    tail_id: str | None = None
    for ordinal, (input_tokens, output_tokens) in enumerate(token_pairs):
        turn = await repository.append_result(
            LOCAL_USER_ID,
            session_id=session_id,
            expected_tail_id=tail_id,
            user_input=UserInput(text=f"Question {ordinal}"),
            ota_records=[],
            agent_state={},
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer=f"Answer {ordinal}",
            error=None,
            context_usage={
                "model_id": "test-model",
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
            model="test-model",
            execution_mode="normal",
        )
        tail_id = turn.id


async def test_tokens(service_client: httpx.AsyncClient) -> None:
    """The tokens endpoint reports accumulated input and output usage for one Session.

    Final HTTP result:
    {"tokens": 17}

    Checks:
    1. Token usage from every persisted Turn is included in the total.
    2. Reading the total leaves the conversation available.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    await seed_turns(session_id, [(2, 3), (5, 7)])

    # Check 1: The endpoint sums input and output usage across both Turns.
    tokens_response = await service_client.get(f"/sessions/{session_id}/tokens")
    assert tokens_response.status_code == 200
    assert tokens_response.json() == {"tokens": 17}

    # Check 2: The read-only command does not consume or clear Session history.
    messages_response = await service_client.get(f"/sessions/{session_id}/messages")
    assert messages_response.status_code == 200
    assert [message["text"] for message in messages_response.json()["messages"]] == [
        "Question 0",
        "Answer 0",
        "Question 1",
        "Answer 1",
    ]


async def test_reset(service_client: httpx.AsyncClient) -> None:
    """Reset keeps the Session shell but returns its conversation to a clean state.

    Final HTTP state:
    {
      "session": {"status": "finish", "model": "", "tokens": 0},
      "messages": []
    }

    Checks:
    1. The Session has visible history before reset.
    2. Reset succeeds without starting an Agent and removes all messages and token usage.
    3. The original Session remains available as a clean idle shell.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    await seed_turns(session_id, [(3, 4), (5, 6)])

    # Check 1: Seeded history is visible through the HTTP transcript endpoint.
    before_response = await service_client.get(f"/sessions/{session_id}/messages")
    assert before_response.status_code == 200
    assert len(before_response.json()["messages"]) == 4

    # Check 2: Reset removes the conversation and its accumulated token usage.
    reset_response = await service_client.post(f"/sessions/{session_id}/reset")
    assert reset_response.status_code == 204
    messages_response = await service_client.get(f"/sessions/{session_id}/messages")
    assert messages_response.status_code == 200
    assert messages_response.json() == {
        "messages": [],
        "pending_request": None,
        "has_more": False,
        "next_before": None,
        "context_usage": None,
        "thinking_mode": None,
        "workflow_run": None,
        "children": [],
    }
    tokens_response = await service_client.get(f"/sessions/{session_id}/tokens")
    assert tokens_response.status_code == 200
    assert tokens_response.json() == {"tokens": 0}

    # Check 3: Reset preserves the same Session as a clean idle shell.
    detail_response = await service_client.get(f"/sessions/{session_id}")
    assert detail_response.status_code == 200
    assert detail_response.json()["id"] == session_id
    assert detail_response.json()["status"] == "finish"
    assert detail_response.json()["model"] == ""
    assert detail_response.json()["tokens"] == 0


async def test_read_receipt(service_client: httpx.AsyncClient) -> None:
    """Opening an unread completed Session clears its unread projection idempotently.

    Final HTTP state:
    {"id": "<generated>", "status": "finish"}

    Checks:
    1. A completed Session is exposed as unread before the receipt.
    2. The read receipt returns no content and changes the visible status to finish.
    3. Repeating the receipt is a successful no-op.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    await SessionRepository().update_turn_projection(
        session_id,
        LOCAL_USER_ID,
        status=SessionStatus.COMPLETED,
        model="test-model",
        last_answer="Done",
    )

    # Check 1: The Session detail shows its completed unread status.
    before_response = await service_client.get(f"/sessions/{session_id}")
    assert before_response.status_code == 200
    assert before_response.json()["status"] == "completed"
    assert before_response.json()["last_answer"] == "Done"

    # Check 2: Posting the receipt clears the unread status.
    read_response = await service_client.post(f"/sessions/{session_id}/read")
    assert read_response.status_code == 204
    after_response = await service_client.get(f"/sessions/{session_id}")
    assert after_response.status_code == 200
    assert after_response.json()["status"] == "finish"

    # Check 3: A second receipt remains a successful no-op.
    repeated_response = await service_client.post(f"/sessions/{session_id}/read")
    assert repeated_response.status_code == 204
    assert (await service_client.get(f"/sessions/{session_id}")).json()["status"] == "finish"


async def test_idle_stop(service_client: httpx.AsyncClient) -> None:
    """Stopping an idle Session is an idempotent no-op instead of an error.

    Final HTTP result:
    {"stopped": false, "session_id": "<generated>"}

    Checks:
    1. Stop reports that no Agent execution was running.
    2. Repeating stop returns the same safe result and leaves the Session available.
    """
    created = await create_session(service_client)
    session_id = created["id"]

    # Check 1: An idle Session reports that no running task was stopped.
    stop_response = await service_client.post(f"/sessions/{session_id}/stop")
    assert stop_response.status_code == 200
    assert stop_response.json() == {"stopped": False, "session_id": session_id}

    # Check 2: Stop remains idempotent and preserves the Session.
    repeated_response = await service_client.post(f"/sessions/{session_id}/stop")
    assert repeated_response.status_code == 200
    assert repeated_response.json() == {"stopped": False, "session_id": session_id}
    assert (await service_client.get(f"/sessions/{session_id}")).status_code == 200
