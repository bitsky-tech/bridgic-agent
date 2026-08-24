from __future__ import annotations

import asyncio

import httpx
from bridgic.core.model.types import Role

from src.amphi_agent._cognitive import VOLATILE_TAIL_EXTRA
from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm


async def create_session(flow_client: httpx.AsyncClient) -> str:
    response = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert response.status_code == 201
    return response.json()["id"]


async def test_complete_turn(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final user-visible state:

    {
      "turn": {"status": "completed", "answer": "The task is complete."},
      "session": {"status": "completed", "tokens": 18},
      "agent": {"running": false}
    }

    Checks:
    1. A Session request crosses the HTTP, Agent, LLM, and persistence boundaries.
    2. The completed answer can be reloaded as a user and assistant transcript.
    3. Token usage and the final Agent status reflect the completed Turn.
    """
    scripted_llm.enqueue_text("The task is complete.", input_tokens=12, output_tokens=6)
    session_id = await create_session(flow_client)

    # Check 1: A real Agent run returns the scripted model result through HTTP.
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Complete this task."},
    )
    assert response.status_code == 200
    result = response.json()
    assert result == {
        "session_id": session_id,
        "turn_id": result["turn_id"],
        "disposition": "completed",
        "answer": "The task is complete.",
    }

    # Check 2: The persisted conversation is available through the public Session API.
    response = await flow_client.get(f"/sessions/{session_id}/messages")
    assert response.status_code == 200
    messages = response.json()["messages"]
    assert [(message["role"], message["text"]) for message in messages] == [
        ("user", "Complete this task."),
        ("assistant", "The task is complete."),
    ]
    assert messages[1]["done"] is True
    assert messages[1]["finalAnswer"] == "The task is complete."

    # Check 3: Usage is durable and no Agent task remains active.
    response = await flow_client.get(f"/sessions/{session_id}/tokens")
    assert response.status_code == 200
    assert response.json() == {"tokens": 18}
    status = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
    assert status.json() == {
        "session_id": session_id,
        "status": "completed",
        "answer": "The task is complete.",
        "error": None,
    }
    assert (await flow_client.get("/api/agent/status")).json() == {"running": False}


async def test_continue_chat(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final conversation:

    {
      "messages": [
        {"role": "user", "text": "My name is Ada."},
        {"role": "assistant", "text": "I will remember that."},
        {"role": "user", "text": "What is my name?"},
        {"role": "assistant", "text": "Your name is Ada."}
      ],
      "tokens": 25
    }

    Checks:
    1. Two requests append two ordered Turns to the same Session.
    2. The second model call receives the earlier conversation as structured messages.
    3. The Session exposes the complete transcript and accumulated usage.
    """
    scripted_llm.enqueue_text("I will remember that.", input_tokens=8, output_tokens=4)
    scripted_llm.enqueue_text("Your name is Ada.", input_tokens=9, output_tokens=4)
    session_id = await create_session(flow_client)

    # Check 1: Both Agent requests complete against the same Session.
    first = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "My name is Ada."},
    )
    second = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "What is my name?"},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["turn_id"] != second.json()["turn_id"]

    # Check 2: The next LLM request includes the prior user and assistant content.
    assert len(scripted_llm.turn_calls) == 2
    prior_context = [
        (message.role, message.content)
        for message in scripted_llm.turn_calls[1].messages
        if message.role is not Role.SYSTEM
        and not (message.extras or {}).get(VOLATILE_TAIL_EXTRA)
    ]
    assert (Role.USER, "My name is Ada.") in prior_context
    assert (Role.AI, "I will remember that.") in prior_context
    assert prior_context[-1][0] is Role.USER
    assert prior_context[-1][1].startswith("What is my name?")

    # Check 3: Reloading the Session returns both Turns and their total usage.
    response = await flow_client.get(f"/sessions/{session_id}/messages")
    assert response.status_code == 200
    assert [(message["role"], message["text"]) for message in response.json()["messages"]] == [
        ("user", "My name is Ada."),
        ("assistant", "I will remember that."),
        ("user", "What is my name?"),
        ("assistant", "Your name is Ada."),
    ]
    assert (await flow_client.get(f"/sessions/{session_id}/tokens")).json() == {"tokens": 25}


async def test_tool_round(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final Agent Turn:

    {
      "rounds": [
        {"tool": "help", "success": true},
        {"answer": "I checked the product capabilities."}
      ],
      "turn_count": 1
    }

    Checks:
    1. A model Tool Call invokes the real registered Tool and returns to the model.
    2. The follow-up model call receives the Tool result as a structured message.
    3. One user request persists as one Turn containing the Tool card and final answer.
    """
    scripted_llm.enqueue_tool("help", {}, call_id="call_help")
    scripted_llm.enqueue_text("I checked the product capabilities.", input_tokens=20, output_tokens=5)
    session_id = await create_session(flow_client)

    # Check 1: The Agent executes the Tool round before returning its final answer.
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Explain what this product can do."},
    )
    assert response.status_code == 200
    assert response.json()["answer"] == "I checked the product capabilities."
    assert len(scripted_llm.turn_calls) == 2

    # Check 2: The second reasoning round contains the successful Tool result.
    tool_messages = [
        message for message in scripted_llm.turn_calls[1].messages
        if message.role is Role.TOOL
    ]
    assert len(tool_messages) == 1
    tool_result = "".join(str(getattr(block, "content", "")) for block in tool_messages[0].blocks)
    assert "What this Agent is designed for" in tool_result

    # Check 3: The public transcript retains the Tool card inside a single Turn.
    response = await flow_client.get(f"/sessions/{session_id}/messages")
    assert response.status_code == 200
    messages = response.json()["messages"]
    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert messages[1]["finalAnswer"] == "I checked the product capabilities."
    tool_calls = messages[1]["toolCalls"]
    assert len(tool_calls) == 1
    assert tool_calls[0]["name"] == "help"
    assert tool_calls[0]["result"]["isError"] is False
    assert "What this Agent is designed for" in tool_calls[0]["result"]["output"]


async def test_failed_turn(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final recovery state:

    {
      "first_turn": {"status": "failed", "error": "safe public message"},
      "second_turn": {"status": "completed", "answer": "Recovered."},
      "agent": {"running": false}
    }

    Checks:
    1. A provider failure returns an HTTP failure and persists a failed Turn.
    2. The failed transcript exposes only the safe error without leaving an active task.
    3. A later request can recover by appending a successful Turn.
    """
    raw_error = "Provider unavailable at https://internal.invalid; token=sk-private"
    public_error = "Something went wrong while handling this task. Try again, or wait a moment if it keeps happening."
    scripted_llm.enqueue_error(RuntimeError(raw_error))
    session_id = await create_session(flow_client)

    # Check 1: The failed provider call crosses the HTTP boundary as a server error.
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Try the unavailable provider."},
    )
    assert response.status_code == 500
    status = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
    assert status.status_code == 200
    assert status.json()["status"] == "failed"
    assert status.json()["error"] == public_error
    assert raw_error not in status.json()["error"]

    # Check 2: The failed Turn remains visible and the Invocation task is drained.
    response = await flow_client.get(f"/sessions/{session_id}/messages")
    assert response.status_code == 200
    assert response.json()["messages"][-1]["error"] == public_error
    assert raw_error not in response.json()["messages"][-1]["error"]
    assert (await flow_client.get("/api/agent/status")).json() == {"running": False}

    # Check 3: The same Session accepts a later successful Turn.
    scripted_llm.enqueue_text("Recovered.", input_tokens=3, output_tokens=2)
    response = await flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Try again."},
    )
    assert response.status_code == 200
    assert response.json()["answer"] == "Recovered."
    assert (await flow_client.get(f"/api/agent/sessions/{session_id}/run")).json()["status"] == "completed"


async def test_cancel_turn(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final cancellation state:

    {
      "stop": {"stopped": true},
      "turn": {"status": "cancelled", "stopped": true},
      "agent": {"running": false}
    }

    Checks:
    1. A blocked model call keeps the Agent visible as running.
    2. The stop endpoint cancels and drains the in-flight Invocation.
    3. Cancellation is persisted and reloads as a stopped assistant message.
    """
    gate = scripted_llm.enqueue_blocked()
    session_id = await create_session(flow_client)
    request = asyncio.create_task(flow_client.post(
        f"/api/agent/sessions/{session_id}/run",
        json={"input": "Wait until I stop this."},
    ))

    # Check 1: The request is inside the model call while the Agent reports running.
    await gate.wait_started()
    assert (await flow_client.get("/api/agent/status")).json() == {"running": True}

    # Check 2: Stop cancels the Invocation and removes it from the active-task projection.
    response = await flow_client.post(f"/sessions/{session_id}/stop")
    assert response.status_code == 200
    assert response.json() == {"stopped": True, "session_id": session_id}
    await asyncio.gather(request, return_exceptions=True)
    assert (await flow_client.get("/api/agent/status")).json() == {"running": False}

    # Check 3: The cancelled Turn remains durable and renders as stopped after reload.
    status = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
    assert status.status_code == 200
    assert status.json()["status"] == "cancelled"
    assert "cancelled" in status.json()["error"].lower()
    messages = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
    assert messages[-1]["role"] == "assistant"
    assert messages[-1]["stopped"] is True
