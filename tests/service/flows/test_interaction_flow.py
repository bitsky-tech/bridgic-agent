from __future__ import annotations

import json

from bridgic.core.model.types import Role
from httpx import AsyncClient

from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm
from tests.service.flows._websocket import WebSocketRecorder


async def create_session(flow_client: AsyncClient) -> str:
    response = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert response.status_code == 201
    return response.json()["id"]


async def subscribe(flow_socket: WebSocketRecorder, session_id: str) -> None:
    await flow_socket.send({"type": "subscribe", "topics": [f"session:{session_id}"]})
    assert (await flow_socket.receive_until("ack", for_type="subscribe"))["topics"] == [
        f"session:{session_id}",
    ]


async def test_permission(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm):
    """Final interaction state:

    {
      "permission": {"decision": "allow", "pending": false},
      "schedule": {"name": "Weekly digest", "enabled": true},
      "turn": {"status": "completed", "answer": "The schedule is ready."}
    }

    Checks:
    1. Request mode parks a state-changing Tool Call before it changes durable data.
    2. A stale answer is acknowledged without consuming the pending request.
    3. The matching approval executes the held Tool Call and completes the same Turn.
    4. Repeating the resolved answer is idempotent and cannot run the Tool twice.
    """
    response = await flow_client.post("/me/execution-mode", json={"mode": "request"})
    assert response.status_code == 200
    scripted_llm.enqueue_tool(
        "create_schedule",
        {
            "name": "Weekly digest",
            "desc": "Prepare the weekly digest",
            "cron": "0 0 9 * * 1",
            "refs": [],
        },
        call_id="call_schedule",
    )
    scripted_llm.enqueue_text("The schedule is ready.")
    session_id = await create_session(flow_client)
    await subscribe(flow_socket, session_id)

    # Check 1: The first attempt persists an approval card and no Schedule.
    await flow_socket.send({
        "type": "chat",
        "session_id": session_id,
        "input": "Create my weekly digest schedule.",
        "blocks": [{"type": "text", "value": "Create my weekly digest schedule."}],
    })
    assert (await flow_socket.receive_until("ack", for_type="chat"))["session_id"] == session_id
    request = await flow_socket.receive_until("permission_request", session_id=session_id)
    assert (await flow_socket.receive_until("final", session_id=session_id))["answer"] == ""
    request_id = request["request_id"]
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"]["kind"] == "permission"
    assert transcript["pending_request"]["request_id"] == request_id
    assert transcript["pending_request"]["items"][0]["tool"] == "create_schedule"
    assert (await flow_client.get("/schedules")).json() == []

    # Check 2: A mismatched request id leaves the approval and LLM queue untouched.
    await flow_socket.send({
        "type": "permission_answer",
        "session_id": session_id,
        "request_id": "stale-request",
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="permission_answer"))["session_id"] == session_id
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"]["request_id"] == request_id
    assert len(scripted_llm.turn_calls) == 1

    # Check 3: The matching answer executes the held call and resumes model reasoning.
    await flow_socket.send({
        "type": "permission_answer",
        "session_id": session_id,
        "request_id": request_id,
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="permission_answer"))["session_id"] == session_id
    final = await flow_socket.receive_until("final", session_id=session_id)
    assert final["answer"] == "The schedule is ready."
    schedules = (await flow_client.get("/schedules")).json()
    assert [(item["name"], item["enabled"]) for item in schedules] == [("Weekly digest", True)]
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"] is None
    assert transcript["messages"][-1]["finalAnswer"] == "The schedule is ready."

    # Check 4: The resolved control frame remains harmless when delivered twice.
    await flow_socket.send({
        "type": "permission_answer",
        "session_id": session_id,
        "request_id": request_id,
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="permission_answer"))["session_id"] == session_id
    assert len((await flow_client.get("/schedules")).json()) == 1
    assert len(scripted_llm.turn_calls) == 2


async def test_permission_denial(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm):
    """Final denied interaction:

    {
      "permission": {"decision": "deny", "pending": false},
      "schedules": [],
      "turn": {"status": "completed", "answer": "I left the schedule unchanged."}
    }

    Checks:
    1. Request mode parks the proposed write with no immediate side effect.
    2. Denial returns a failed Tool observation to the model without executing it.
    3. Reloaded history retains the denial decision and the completed explanation.
    """
    response = await flow_client.post("/me/execution-mode", json={"mode": "request"})
    assert response.status_code == 200
    scripted_llm.enqueue_tool(
        "create_schedule",
        {
            "name": "Rejected schedule",
            "desc": "This Schedule must not be created",
            "cron": "0 0 9 * * 1",
            "refs": [],
        },
        call_id="call_rejected_schedule",
    )
    scripted_llm.enqueue_text("I left the schedule unchanged.")
    session_id = await create_session(flow_client)
    await subscribe(flow_socket, session_id)

    # Check 1: The write is held before it reaches Schedule persistence.
    await flow_socket.send({
        "type": "chat",
        "session_id": session_id,
        "input": "Propose a Schedule, but wait for my decision.",
        "blocks": [{"type": "text", "value": "Propose a Schedule, but wait for my decision."}],
    })
    assert (await flow_socket.receive_until("ack", for_type="chat"))["session_id"] == session_id
    request = await flow_socket.receive_until("permission_request", session_id=session_id)
    assert (await flow_socket.receive_until("final", session_id=session_id))["answer"] == ""
    assert (await flow_client.get("/schedules")).json() == []

    # Check 2: Denial resumes reasoning with an error result but performs no write.
    await flow_socket.send({
        "type": "permission_answer",
        "session_id": session_id,
        "request_id": request["request_id"],
        "answers": [{"call_index": 0, "decision": "deny"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="permission_answer"))["session_id"] == session_id
    assert (await flow_socket.receive_until("final", session_id=session_id))["answer"] == (
        "I left the schedule unchanged."
    )
    assert (await flow_client.get("/schedules")).json() == []
    tool_messages = [
        message for message in scripted_llm.turn_calls[1].messages
        if message.role is Role.TOOL
    ]
    assert len(tool_messages) == 1
    assert "Denied by the user" in str(tool_messages[0].blocks)

    # Check 3: The durable card records the decision beside the final response.
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"] is None
    assistant = transcript["messages"][-1]
    permission = next(block for block in assistant["blocks"] if block["type"] == "permission")
    assert permission["decided"] is True
    assert permission["items"][0]["decision"] == "deny"
    assert assistant["finalAnswer"] == "I left the schedule unchanged."


async def test_human_choice(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm):
    """Final interaction state:

    {
      "choice": {"answer": "Blue", "pending": false},
      "turn": {"status": "completed", "answer": "Blue selected."}
    }

    Checks:
    1. A human-choice Tool parks one durable question instead of inventing an answer.
    2. A stale choice is idempotently ignored while the original card remains pending.
    3. The matching choice becomes Tool context and resumes the same logical Turn.
    4. A duplicate choice cannot create another model round or transcript entry.
    """
    questions = {
        "questions": [{
            "question": "Which color should I use?",
            "header": "Color",
            "options": [{"label": "Blue"}, {"label": "Green"}],
        }],
    }
    scripted_llm.enqueue_tool(
        "request_human_choice",
        {
            "questions": json.dumps(questions),
            "prompt": "The design needs one color before work can continue.",
        },
        call_id="call_choice",
    )
    scripted_llm.enqueue_text("Blue selected.")
    session_id = await create_session(flow_client)
    await subscribe(flow_socket, session_id)

    # Check 1: The Tool publishes and persists the exact pending question.
    await flow_socket.send({
        "type": "chat",
        "session_id": session_id,
        "input": "Ask me which color to use.",
        "blocks": [{"type": "text", "value": "Ask me which color to use."}],
    })
    assert (await flow_socket.receive_until("ack", for_type="chat"))["session_id"] == session_id
    request = await flow_socket.receive_until("human_request", session_id=session_id)
    assert (await flow_socket.receive_until("final", session_id=session_id))["answer"] == ""
    request_id = request["request_id"]
    assert request["questions"][0]["question"] == "Which color should I use?"
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"]["kind"] == "choose"
    assert transcript["pending_request"]["request_id"] == request_id

    # Check 2: The wrong correlation id neither clears the card nor calls the model.
    await flow_socket.send({
        "type": "choice_answer",
        "session_id": session_id,
        "request_id": "stale-request",
        "answers": [{"index": 0, "text": "Blue"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="choice_answer"))["session_id"] == session_id
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"]["request_id"] == request_id
    assert len(scripted_llm.turn_calls) == 1

    # Check 3: The accepted answer enters Tool context and finishes the Turn.
    await flow_socket.send({
        "type": "choice_answer",
        "session_id": session_id,
        "request_id": request_id,
        "answers": [{"index": 0, "text": "Blue"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="choice_answer"))["session_id"] == session_id
    assert (await flow_socket.receive_until("final", session_id=session_id))["answer"] == "Blue selected."
    tool_messages = [
        message for message in scripted_llm.turn_calls[1].messages
        if message.role is Role.TOOL
    ]
    assert len(tool_messages) == 1
    assert "Blue" in str(tool_messages[0].blocks)
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"] is None
    assert transcript["messages"][-1]["finalAnswer"] == "Blue selected."

    # Check 4: Repeating the same answer remains an acknowledged no-op.
    await flow_socket.send({
        "type": "choice_answer",
        "session_id": session_id,
        "request_id": request_id,
        "answers": [{"index": 0, "text": "Blue"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="choice_answer"))["session_id"] == session_id
    assert len(scripted_llm.turn_calls) == 2
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert sum(message.get("finalAnswer") == "Blue selected." for message in messages) == 1
