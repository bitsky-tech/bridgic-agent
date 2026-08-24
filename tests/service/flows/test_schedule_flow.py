from __future__ import annotations

import asyncio
import json

from httpx import AsyncClient

from tests.service.flows._scripted_llm import ScriptedLlm
from tests.service.flows._websocket import WebSocketRecorder as WsRecorder


async def create_schedule(flow_client: AsyncClient, name: str, description: str) -> str:
    response = await flow_client.post(
        "/schedules",
        json={
            "name": name,
            "desc": description,
            "cron": "0 0 9 * * *",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def subscribe_system(flow_socket: WsRecorder) -> None:
    await flow_socket.send({"type": "subscribe", "topics": ["system"]})
    assert (await flow_socket.receive_until("ack", for_type="subscribe"))["topics"] == ["system"]
    await asyncio.sleep(0)


async def test_run_and_kill(flow_client: AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final scheduled execution state:

    {
      "completed_run": {"answer": "Scheduled report complete.", "can_continue": true},
      "overlapping_runs": ["cancelled", "cancelled"],
      "schedule": {"running": false, "run_count": 3}
    }

    Checks:
    1. Run-now creates a scheduled Session and completes it through the real Agent path.
    2. Two further run-now requests overlap and both reach the model before either finishes.
    3. One kill request cancels every run currently owned by the Schedule.
    4. Run history preserves the completed answer and exposes both cancelled transcripts.
    """
    async def wait_until_idle(schedule_id: str) -> dict:
        async with asyncio.timeout(3):
            while True:
                response = await flow_client.get(f"/schedules/{schedule_id}")
                detail = response.json()
                if not detail["running"]:
                    return detail
                await asyncio.sleep(0.01)

    schedule_id = await create_schedule(flow_client, "Flow report", "Prepare the scheduled report.")
    scripted_llm.enqueue_text("Scheduled report complete.", input_tokens=6, output_tokens=3)

    # Check 1: A manual fire becomes one durable, completed scheduled Session.
    response = await flow_client.post(f"/schedules/{schedule_id}/run-now")
    assert response.status_code == 202
    assert response.json() == {"ok": "pending"}
    detail = await wait_until_idle(schedule_id)
    assert len(detail["runs"]) == 1
    completed = detail["runs"][0]
    assert completed["status"] == "completed"
    assert completed["can_continue"] is True
    assert completed["last_answer"] == "Scheduled report complete."

    first_gate = scripted_llm.enqueue_blocked()
    second_gate = scripted_llm.enqueue_blocked()

    # Check 2: The overlap policy starts both new Sessions concurrently.
    first = await flow_client.post(f"/schedules/{schedule_id}/run-now")
    second = await flow_client.post(f"/schedules/{schedule_id}/run-now")
    assert first.status_code == 202
    assert second.status_code == 202
    await asyncio.gather(first_gate.wait_started(), second_gate.wait_started())
    running = (await flow_client.get(f"/schedules/{schedule_id}")).json()
    assert running["running"] is True
    assert len(running["runs"]) == 3
    active_ids = [run["session_id"] for run in running["runs"] if run["running"]]
    assert len(active_ids) == 2

    # Check 3: Kill stops the complete in-flight set, not just the newest task.
    response = await flow_client.post(f"/schedules/{schedule_id}/kill")
    assert response.status_code == 202
    assert response.json() == {"ok": True, "killed": True}
    detail = await wait_until_idle(schedule_id)
    assert detail["running"] is False

    # Check 4: Each killed Session persisted cancellation while the earlier result remains.
    by_id = {run["session_id"]: run for run in detail["runs"]}
    assert by_id[completed["session_id"]]["last_answer"] == "Scheduled report complete."
    for session_id in active_ids:
        run = by_id[session_id]
        assert run["status"] == "finish"
        assert run["can_continue"] is True
        transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()["messages"]
        assert transcript[-1]["stopped"] is True


async def test_needs_action(flow_client: AsyncClient, flow_socket: WsRecorder, scripted_llm: ScriptedLlm):
    """Final scheduled interaction:

    {
      "notification": {"kind": "action_required", "schedule": "Interactive report"},
      "schedule": {"needs_action": 0, "status": "active"},
      "run": {"status": "completed", "answer": "Scheduled choice accepted."}
    }

    Checks:
    1. A scheduled Agent can park on a human choice and release its live run slot.
    2. The Schedule derives needsAction and sends one GUI notification for that run.
    3. The parked request remains durable and can be answered through WebSocket control traffic.
    4. Resuming clears needsAction and completes the original scheduled Session.
    """
    await subscribe_system(flow_socket)
    questions = {
        "questions": [{
            "question": "Should the scheduled report continue?",
            "header": "Continue",
            "options": [{"label": "Continue"}, {"label": "Stop"}],
        }],
    }
    scripted_llm.enqueue_tool(
        "request_human_choice",
        {
            "questions": json.dumps(questions),
            "prompt": "The scheduled report needs a decision before it can continue.",
        },
        call_id="call_schedule_choice",
    )
    schedule_id = await create_schedule(
        flow_client,
        "Interactive report",
        "Prepare the interactive scheduled report.",
    )

    # Check 1: The scheduled run parks durably rather than staying in-flight.
    response = await flow_client.post(f"/schedules/{schedule_id}/run-now")
    assert response.status_code == 202
    notification = await flow_socket.receive_until("schedule.notify")
    detail = (await flow_client.get(f"/schedules/{schedule_id}")).json()
    assert detail["running"] is False
    assert len(detail["runs"]) == 1
    run = detail["runs"][0]
    assert run["status"] == "awaiting"
    assert run["can_continue"] is False

    # Check 2: Derived Schedule state and notification identify the same run.
    assert detail["status"] == "needsAction"
    assert detail["needs_action"] == 1
    assert notification["kind"] == "action_required"
    assert notification["schedule_id"] == schedule_id
    assert notification["schedule_name"] == "Interactive report"
    assert notification["session_id"] == run["session_id"]

    # Check 3: The pending request survives after Scheduler ownership has ended.
    session_id = run["session_id"]
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    pending = transcript["pending_request"]
    assert pending["kind"] == "choose"
    assert pending["questions"][0]["question"] == "Should the scheduled report continue?"
    scripted_llm.enqueue_text("Scheduled choice accepted.")
    await flow_socket.send({"type": "subscribe", "topics": [f"session:{session_id}"]})
    assert (await flow_socket.receive_until("ack", for_type="subscribe"))["topics"] == [
        f"session:{session_id}",
    ]
    await flow_socket.send({
        "type": "choice_answer",
        "session_id": session_id,
        "request_id": pending["request_id"],
        "answers": [{"index": 0, "text": "Continue"}],
    })
    assert (await flow_socket.receive_until("ack", for_type="choice_answer"))["session_id"] == session_id
    final = await flow_socket.receive_until("final", session_id=session_id)
    assert final["answer"] == "Scheduled choice accepted."

    # Check 4: The same scheduled Session completes and removes the attention badge.
    detail = (await flow_client.get(f"/schedules/{schedule_id}")).json()
    assert detail["status"] == "active"
    assert detail["needs_action"] == 0
    assert detail["running"] is False
    assert detail["runs"][0]["session_id"] == session_id
    assert detail["runs"][0]["status"] == "completed"
    assert detail["runs"][0]["last_answer"] == "Scheduled choice accepted."
    transcript = (await flow_client.get(f"/sessions/{session_id}/messages")).json()
    assert transcript["pending_request"] is None
    assert transcript["messages"][-1]["finalAnswer"] == "Scheduled choice accepted."


async def test_failed_notification(flow_client: AsyncClient, flow_socket: WsRecorder, scripted_llm: ScriptedLlm):
    """Final failed scheduled run:

    {
      "notification": {"kind": "failed", "schedule": "Failing report"},
      "schedule": {"status": "active", "running": false, "needs_action": 0},
      "run": {"status": "completed", "turn_error": "safe public message"}
    }

    Checks:
    1. A model exception fails the scheduled Turn and releases Scheduler ownership.
    2. A connected GUI receives exactly the failed-run notification identity.
    3. The Schedule remains active while its run history retains the failure.
    """
    await subscribe_system(flow_socket)
    raw_error = "Scheduled provider unavailable at https://internal.invalid; token=sk-private"
    scripted_llm.enqueue_error(RuntimeError(raw_error))
    schedule_id = await create_schedule(
        flow_client,
        "Failing report",
        "Run the report that exercises provider failure.",
    )

    # Check 1: Run-now accepts the work and the failed Agent task fully settles.
    response = await flow_client.post(f"/schedules/{schedule_id}/run-now")
    assert response.status_code == 202
    notification = await flow_socket.receive_until("schedule.notify")
    detail = (await flow_client.get(f"/schedules/{schedule_id}")).json()
    assert detail["running"] is False
    assert len(detail["runs"]) == 1

    # Check 2: The GUI notification points to the exact failed run and Schedule.
    run = detail["runs"][0]
    assert notification["kind"] == "failed"
    assert notification["schedule_id"] == schedule_id
    assert notification["schedule_name"] == "Failing report"
    assert notification["session_id"] == run["session_id"]

    # Check 3: Failure does not pause the Schedule and remains inspectable in history.
    assert detail["status"] == "active"
    assert detail["needs_action"] == 0
    assert run["status"] == "completed"
    assert run["can_continue"] is True
    transcript = (await flow_client.get(f"/sessions/{run['session_id']}/messages")).json()
    assert transcript["messages"][-1]["error"] == (
        "Something went wrong while handling this task. Try again, or wait a moment if it keeps happening."
    )
    assert raw_error not in transcript["messages"][-1]["error"]
