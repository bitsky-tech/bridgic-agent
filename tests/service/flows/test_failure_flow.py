from __future__ import annotations

import asyncio

from bridgic.core.model.types import Role
from httpx import AsyncClient
from pytest import MonkeyPatch

from src.amphi_store import SessionTurnRepository
from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm


async def create_session(flow_client: AsyncClient) -> str:
    response = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert response.status_code == 201
    return response.json()["id"]


async def test_busy_session(flow_client: AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final concurrency state:

    {
      "first_request": "cancelled",
      "second_request": "conflict",
      "reset_while_running": "conflict",
      "active_agent": false
    }

    Checks:
    1. One blocked model request owns the Session's single active Invocation slot.
    2. A second request and reset cannot race the in-flight Turn.
    3. Stop cancels the owner and persists exactly one cancelled Turn.
    """
    gate = scripted_llm.enqueue_blocked()
    session_id = await create_session(flow_client)
    first_request = asyncio.create_task(flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Keep this request running."},
    ))

    # Check 1: The first request remains active at the model boundary.
    await gate.wait_started()
    assert (await flow_client.get("/api/agent/status")).json() == {"running": True}

    # Check 2: Competing mutation attempts fail without disturbing the owner.
    second = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Compete with the active request."},
    )
    reset = await flow_client.post(f"/sessions/{session_id}/reset")
    assert second.status_code == 409
    assert reset.status_code == 409
    assert not first_request.done()

    # Check 3: Cancellation drains the task and leaves one durable stopped Turn.
    stopped = await flow_client.post(f"/sessions/{session_id}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["stopped"] is True
    await asyncio.gather(first_request, return_exceptions=True)
    assert (await flow_client.get("/api/agent/status")).json() == {"running": False}
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert len([message for message in transcript["messages"] if message["role"] == "user"]) == 1
    assert transcript["messages"][-1]["stopped"] is True


async def test_tool_failure(flow_client: AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final Tool state:

    {
      "tool": {"name": "read_file", "isError": true},
      "turn": {"status": "completed", "answer": "I handled the missing file."}
    }

    Checks:
    1. A real Tool failure is returned to the model as structured Tool context.
    2. The Agent can reason after that failure and complete the original request.
    3. The public transcript retains both the failed Tool card and final answer.
    """
    scripted_llm.enqueue_tool("read_file", {"file_path": "missing.txt"}, call_id="call_missing")
    scripted_llm.enqueue_text("I handled the missing file.")
    session_id = await create_session(flow_client)

    # Check 1: The failed filesystem call reaches the second model round.
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Read the missing file and handle the result."},
    )
    assert response.status_code == 200
    tool_messages = [
        message for message in scripted_llm.turn_calls[1].messages
        if message.role is Role.TOOL
    ]
    assert len(tool_messages) == 1
    assert "missing.txt" in str(tool_messages[0].blocks)

    # Check 2: A Tool error does not force the whole Agent Turn to fail.
    assert response.json()["disposition"] == "completed"
    assert response.json()["answer"] == "I handled the missing file."

    # Check 3: Reloading shows the failed call and successful final response together.
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assistant = messages[-1]
    assert assistant["finalAnswer"] == "I handled the missing file."
    assert len(assistant["toolCalls"]) == 1
    assert assistant["toolCalls"][0]["name"] == "read_file"
    assert assistant["toolCalls"][0]["result"]["isError"] is True
    assert "missing.txt" in assistant["toolCalls"][0]["result"]["output"]


async def test_store_failure(flow_client: AsyncClient, scripted_llm: ScriptedLlm, monkeypatch: MonkeyPatch):
    """Final persistence state:

    {
      "failed_write": {"http_status": 500, "messages": []},
      "recovery": {"status": "completed", "answer": "Stored safely."}
    }

    Checks:
    1. A Turn write failure is surfaced and cannot expose an unpersisted answer as history.
    2. The failed persistence attempt releases its Invocation slot.
    3. Restoring the Store allows the same Session to complete normally.
    """
    async def fail_append(*_: object, **__: object) -> None:
        raise RuntimeError("State database unavailable")

    scripted_llm.enqueue_text("This answer cannot be stored.")
    session_id = await create_session(flow_client)

    # Check 1: The HTTP failure leaves no phantom durable transcript.
    with monkeypatch.context() as patch:
        patch.setattr(SessionTurnRepository, "append_result", fail_append)
        response = await flow_client.post(
            f"/api/agent/sessions/{session_id}/run",
            json={"input": "Persist this response."},
        )
    assert response.status_code == 500
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["messages"] == []

    # Check 2: The failed write cannot strand the process in a running state.
    assert (await flow_client.get("/api/agent/status")).json() == {"running": False}
    status = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
    assert status.json()["status"] == "pending"

    # Check 3: A later request uses the restored repository and persists successfully.
    scripted_llm.enqueue_text("Stored safely.")
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Try persistence again."},
    )
    assert response.status_code == 200
    assert response.json()["answer"] == "Stored safely."
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert [(message["role"], message["text"]) for message in messages] == [
        ("user", "Try persistence again."),
        ("assistant", "Stored safely."),
    ]
