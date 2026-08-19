from __future__ import annotations

import asyncio

import httpx
from bridgic.core.model.types import Role

from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm


async def create_session(flow_client: httpx.AsyncClient) -> str:
    response = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert response.status_code == 201
    return response.json()["id"]


async def test_parallel_children(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final delegation tree:

    {
      "parent": {"status": "completed", "answer": "Both child results were combined."},
      "children": [
        {"status": "completed", "answer": "First child result."},
        {"status": "completed", "answer": "Second child result."}
      ]
    }

    Checks:
    1. One parent Tool round creates two blocking Child Sessions and parks their parent.
    2. Both Child Agents reach the model before either is released, proving concurrent execution.
    3. The parent resumes only after both results and receives each as structured Tool context.
    4. The transcript exposes the two completed Children and nested delegation is rejected.
    """
    async def wait_for_parent(session_id: str) -> dict:
        async with asyncio.timeout(3):
            while True:
                response = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
                if response.json()["status"] == "completed":
                    return response.json()
                await asyncio.sleep(0.01)

    scripted_llm.enqueue_tools([
        ("run_subagent", {"goal": "Produce the first child result."}, "call_child_one"),
        ("run_subagent", {"goal": "Produce the second child result."}, "call_child_two"),
    ])
    first_gate = scripted_llm.enqueue_blocked("First child result.")
    second_gate = scripted_llm.enqueue_blocked("Second child result.")
    scripted_llm.enqueue_text("Both child results were combined.")
    parent_id = await create_session(flow_client)

    # Check 1: The initial request ends with a durable parent wait state.
    response = await flow_client.post(
        f"/api/agent/sessions/{parent_id}/run",
        json={"input": "Delegate both independent parts and combine their results."},
    )
    assert response.status_code == 200
    assert response.json()["disposition"] == "awaiting_subagents"

    # Check 2: Both Child tasks start without waiting for the other to finish.
    await asyncio.gather(first_gate.wait_started(), second_gate.wait_started())
    parked = await flow_client.get(f"/api/agent/sessions/{parent_id}/run")
    assert parked.json()["status"] == "awaiting_subagents"
    first_gate.release()
    second_gate.release()

    # Check 3: The automatic join resumes the parent with both Child answers.
    status = await wait_for_parent(parent_id)
    assert status["answer"] == "Both child results were combined."
    parent_call = scripted_llm.turn_calls[-1]
    tool_messages = [message for message in parent_call.messages if message.role is Role.TOOL]
    tool_context = str([message.blocks for message in tool_messages])
    assert "First child result." in tool_context
    assert "Second child result." in tool_context

    # Check 4: Public history exposes both Children and prevents a Child from delegating again.
    transcript = (await flow_client.get(f"/sessions/{parent_id}/messages")).json()["messages"]
    assistant = transcript[-1]
    child_blocks = [block for block in assistant["blocks"] if block["type"] == "subagent"]
    assert len(child_blocks) == 2
    assert {block["status"] for block in child_blocks} == {"completed"}
    assert {block["answer"] for block in child_blocks} == {
        "First child result.",
        "Second child result.",
    }
    child_id = child_blocks[0]["invocationId"]
    response = await flow_client.post(
        f"/api/agent/sessions/{child_id}/subagents",
        json={"input": "Try to create a nested Child."},
    )
    assert response.status_code == 409
    assert len(scripted_llm.turn_calls) == 4


async def test_background_child(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final background delegation:

    {
      "parent": {"status": "completed", "answer": "The parent continued immediately."},
      "child": {"status": "completed", "answer": "Background work finished."}
    }

    Checks:
    1. start_subagent creates a Background Child from the normal Agent Tool path.
    2. The parent completes while the Child remains blocked, proving it does not join.
    3. The Child finishes independently after the parent request has returned.
    4. Reloading the parent exposes the completed Child in its background pane.
    """
    async def wait_for_child(session_id: str) -> dict:
        async with asyncio.timeout(3):
            while True:
                response = await flow_client.get(f"/api/agent/sessions/{session_id}/run")
                if response.json()["status"] == "completed":
                    return response.json()
                await asyncio.sleep(0.01)

    scripted_llm.enqueue_tool(
        "start_subagent",
        {"goal": "Complete the background work."},
        call_id="call_background_child",
    )
    child_gate = scripted_llm.enqueue_blocked(
        "Background work finished.",
        match_last_role=Role.USER,
    )
    scripted_llm.enqueue_text(
        "The parent continued immediately.",
        match_last_role=Role.TOOL,
    )
    parent_id = await create_session(flow_client)

    # Check 1: The background dispatch is executed through the parent Agent.
    response = await flow_client.post(
        f"/api/agent/sessions/{parent_id}/run",
        json={"input": "Start the background work and continue without waiting."},
    )
    assert response.status_code == 200
    assert response.json()["answer"] == "The parent continued immediately."

    # Check 2: The Child is still inside its LLM call after the parent completes.
    await child_gate.wait_started()
    parent_status = await flow_client.get(f"/api/agent/sessions/{parent_id}/run")
    assert parent_status.json()["status"] == "completed"
    parent_view = (await flow_client.get(f"/sessions/{parent_id}/messages")).json()
    assert len(parent_view["children"]) == 1
    child_id = parent_view["children"][0]["session_id"]
    assert (await flow_client.get(f"/api/agent/sessions/{child_id}/run")).json()["status"] == "pending"

    # Check 3: Releasing only the Child lets it finish without another parent Turn.
    child_gate.release()
    child_status = await wait_for_child(child_id)
    assert child_status["answer"] == "Background work finished."
    child_messages = (await flow_client.get(f"/sessions/{child_id}/messages")).json()["messages"]
    assert [(message["role"], message["text"]) for message in child_messages] == [
        ("user", "Complete the background work."),
        ("assistant", "Background work finished."),
    ]
    assert len(scripted_llm.turn_calls) == 3

    # Check 4: The parent's separate background projection follows the Child result.
    parent_view = (await flow_client.get(f"/sessions/{parent_id}/messages")).json()
    assert parent_view["messages"][-1]["finalAnswer"] == "The parent continued immediately."
    assert parent_view["children"] == [{
        "session_id": child_id,
        "title": "Complete the background work.",
        "subagent_mode": "background",
        "status": "completed",
    }]


async def test_rpc_child(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final RPC delegation:

    {
      "parent": {"messages": [], "background_children": []},
      "rpc_child": {"status": "completed", "answer": "RPC child complete."}
    }

    Checks:
    1. The public Child RPC creates and runs a Child under an existing root Session.
    2. The RPC response and Child transcript expose the same completed result.
    3. RPC execution does not append a parent Turn or appear as a Background Child.
    """
    scripted_llm.enqueue_text("RPC child complete.", input_tokens=4, output_tokens=3)
    parent_id = await create_session(flow_client)

    # Check 1: The dedicated RPC endpoint returns a fresh completed Child identity.
    response = await flow_client.post(
        f"/api/agent/sessions/{parent_id}/subagents",
        json={"input": "Complete the RPC child task.", "parent_tool_call_id": "rpc_call"},
    )
    assert response.status_code == 200
    result = response.json()
    child_id = result["session_id"]
    assert child_id != parent_id
    assert result["disposition"] == "completed"
    assert result["answer"] == "RPC child complete."

    # Check 2: The Child can be independently reloaded through public Session APIs.
    status = await flow_client.get(f"/api/agent/sessions/{child_id}/run")
    assert status.json()["status"] == "completed"
    messages = (await flow_client.get(f"/sessions/{child_id}/messages")).json()["messages"]
    assert [(message["role"], message["text"]) for message in messages] == [
        ("user", "Complete the RPC child task."),
        ("assistant", "RPC child complete."),
    ]

    # Check 3: RPC is caller-owned and does not change the root's visible conversation.
    parent = (await flow_client.get(f"/sessions/{parent_id}/messages")).json()
    assert parent["messages"] == []
    assert parent["children"] == []
