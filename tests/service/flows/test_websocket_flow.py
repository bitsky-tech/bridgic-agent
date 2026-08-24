from __future__ import annotations

import asyncio

from httpx import AsyncClient

from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm
from tests.service.flows._websocket import WebSocketRecorder


async def create_session(flow_client: AsyncClient) -> str:
    response = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert response.status_code == 201
    return response.json()["id"]


async def subscribe(flow_socket: WebSocketRecorder, *topics: str) -> None:
    await flow_socket.send({"type": "subscribe", "topics": list(topics)})
    ack = await flow_socket.receive_until("ack", for_type="subscribe")
    assert ack["topics"] == list(topics)


async def test_chat_events(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm):
    """Final client state:

    {
      "events": ["stage", "reasoning", "token", "token", "usage", "final"],
      "final": {"answer": "Hello Ada.", "tokens_spent": 10},
      "system": {"type": "session.completed"}
    }

    Checks:
    1. WebSocket hello and subscription expose one authenticated Session stream.
    2. A chat emits structured reasoning, token, usage, and final events in one attempt.
    3. The system topic announces completion and REST reloads the same final answer.
    """
    scripted_llm.enqueue_text(
        "Hello Ada.",
        input_tokens=7,
        output_tokens=3,
        chunks=("Hello ", "Ada."),
        reasoning="Recall the name.",
    )
    session_id = await create_session(flow_client)

    # Check 1: The connection subscribes to the Session and process-wide topics.
    await subscribe(flow_socket, f"session:{session_id}", "system")
    await flow_socket.send({
        "type": "chat",
        "session_id": session_id,
        "input": "Say hello to Ada.",
        "blocks": [{"type": "text", "value": "Say hello to Ada."}],
    })
    assert (await flow_socket.receive_until("ack", for_type="chat"))["session_id"] == session_id

    # Check 2: The live stream preserves model output types and final usage.
    final = await flow_socket.receive_until("final", session_id=session_id)
    session_events = [
        message for message in flow_socket.messages
        if message.get("session_id") == session_id
    ]
    event_types = [message["type"] for message in session_events]
    assert "stage" in event_types
    assert [message["text"] for message in session_events if message["type"] == "token"] == [
        "Hello ",
        "Ada.",
    ]
    assert [message["text"] for message in session_events if message["type"] == "reasoning"] == [
        "Recall the name.",
    ]
    assert [
        (message["input_tokens"], message["output_tokens"])
        for message in session_events if message["type"] == "usage"
    ] == [(7, 3)]
    assert final["answer"] == "Hello Ada."
    assert final["tokens_spent"] == 10

    # Check 3: Completion reaches the system topic and the durable transcript.
    completed = await flow_socket.receive_until("session.completed", session_id=session_id)
    assert completed == {"type": "session.completed", "session_id": session_id}
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert messages[-1]["finalAnswer"] == "Hello Ada."


async def test_chat_runtime_error_is_presented_safely(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm) -> None:
    """A provider payload becomes one safe live and durable terminal error."""
    class ContextLimitError(RuntimeError):
        status_code = 400
        code = "context_length_exceeded"

    raw_error = (
        "Error code: 400 - context window exceeded at https://internal.invalid; "
        "token=sk-private; type=upstream_error"
    )
    public_error = (
        "This conversation has too much content for the current model. "
        "Shorten it or start a new conversation and try again."
    )
    scripted_llm.enqueue_error(ContextLimitError(raw_error))
    session_id = await create_session(flow_client)

    await subscribe(flow_socket, f"session:{session_id}", "system")
    await flow_socket.send({
        "type": "chat",
        "session_id": session_id,
        "input": "Continue the oversized workflow.",
    })
    assert (await flow_socket.receive_until("ack", for_type="chat"))["session_id"] == session_id

    error = await flow_socket.receive_until("error", session_id=session_id)
    await flow_socket.receive_until("session.completed", session_id=session_id)
    assert error["message"] == public_error
    assert raw_error not in error["message"]
    assert "ContextLimitError" not in error["message"]
    assert [
        message["type"]
        for message in flow_socket.messages
        if message.get("session_id") == session_id
        and message.get("type") in {"error", "final", "cancelled"}
    ] == ["error"]

    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert messages[-1]["error"] == public_error
    assert raw_error not in messages[-1]["error"]


async def test_attempt_replay(flow_client: AsyncClient, flow_socket: WebSocketRecorder, scripted_llm: ScriptedLlm):
    """Final replay state:

    {
      "late_subscriber": {"token": "Partial answer"},
      "turn": {"status": "cancelled", "stopped": true}
    }

    Checks:
    1. A Turn can begin before a WebSocket subscribes to its Session topic.
    2. The late subscription replays already-published events from the active attempt.
    3. The same subscriber receives cancellation and REST reloads the stopped Turn.
    """
    gate = scripted_llm.enqueue_blocked("Partial answer")
    session_id = await create_session(flow_client)
    request = asyncio.create_task(flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Start before I subscribe."},
    ))

    # Check 1: The Agent publishes partial output while no Session relay exists.
    await gate.wait_started()
    assert (await flow_client.get("/api/agent/status")).json() == {"running": True}

    # Check 2: Subscribing during the attempt replays the buffered token.
    await subscribe(flow_socket, f"session:{session_id}")
    replayed = await flow_socket.receive_until("token", session_id=session_id)
    assert replayed["text"] == "Partial answer"

    # Check 3: The open relay sees cancellation and the persisted Turn is stopped.
    response = await flow_client.post(f"/sessions/{session_id}/stop")
    assert response.json()["stopped"] is True
    await asyncio.gather(request, return_exceptions=True)
    assert await flow_socket.receive_until("cancelled", session_id=session_id)
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert messages[-1]["stopped"] is True
