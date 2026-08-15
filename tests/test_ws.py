"""``/ws`` — end-to-end WebSocket coverage with a real uvicorn server.

httpx's ASGI transport doesn't speak WebSocket, so these tests need a
real network endpoint: we spin up uvicorn on a random localhost port
(same pattern as :class:`MockLLMServer`) and use the ``websockets``
package as the client. Round-trip framing, JSON, ping/pong, close
codes — all exercised for real.

Consolidated into the distinct integration flows:

* ``hello`` handshake — valid / invalid / wrong-shape / non-hello-first.
* Multiplexing: ``subscribe`` / ``unsubscribe`` acks (session + first-class
  ``system``), token stream + final with per-session_id tagging across a
  multi-session multiplex, bash running in the session workspace,
  cross-connection delivery, and the serial gate (concurrent chat →
  ``cmd_error``).
* HITL: a ``choose`` request parks and resumes the same Root Invocation;
  an option-less request_human does NOT suspend.
* Subscription-gated delivery: chatting unsubscribed → no relay; subscribing
  after a finished turn → no replay; ``system.shutdown`` broadcast.
* ``stop`` is a real cancel: a turn stopped mid first-round saves nothing,
  a turn stopped after a completed round keeps that round.
* Cross-session unread: a clean finish AND an errored turn both mark the
  session ``completed`` + broadcast ``session.completed``; the read receipt
  clears it.

All tests are ``async def`` and use the in-test uvicorn fixture.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import websockets
from websockets.asyncio.client import ClientConnection

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import (
    SessionStatus,
    TurnStatus,
    SessionRepository,
    SessionTurnRepository,
    UserInput,
)
from src.amphi_agent._workspace import BUILD_DIR_NAME, Workspace

from ._session_turns import persist_session_turn
from .conftest import live_client


async def _create_session(base: str, token: str) -> str:
    """Create a session via REST; return its id."""
    async with live_client(base, token) as http:
        resp = await http.post("/sessions", json={})
        assert resp.status_code == 201
        return resp.json()["id"]


async def _hello(ws: ClientConnection, token: str, client_id: str = "test-1") -> None:
    """Send a valid hello + assert the server's ready response."""
    await ws.send(json.dumps({
        "type": "hello",
        "token": token,
        "client_id": client_id,
        "client_type": "test",
    }))
    reply = json.loads(await ws.recv())
    assert reply == {"type": "ready"}


async def _subscribe(ws: ClientConnection, session_id: str) -> None:
    """Subscribe to a session topic + assert the ack."""
    await ws.send(json.dumps({
        "type": "subscribe", "topics": [f"session:{session_id}"],
    }))
    assert json.loads(await ws.recv())["type"] == "ack"


async def test_busy_chat_error_uses_websocket_accept_language(
    ws_creds, ws_service, mock_llm,
) -> None:
    """The WS handshake locale localizes display text without new frames."""
    ws_url, token = ws_creds
    _, _, base = ws_service
    session_id = await _create_session(base, token)
    mock_llm.enqueue_text("first")
    mock_llm.hold_next_stream()

    async with websockets.connect(
        ws_url,
        proxy=None,
        additional_headers={"Accept-Language": "en-US,en;q=0.9"},
    ) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        await ws.send(json.dumps({
            "type": "chat", "session_id": session_id, "input": "first",
        }))
        assert json.loads(await ws.recv())["type"] == "ack"

        await ws.send(json.dumps({
            "type": "chat", "session_id": session_id, "input": "second",
        }))
        frames = await _drain_until(
            ws, lambda frame: frame.get("type") == "cmd_error", timeout=3.0,
        )
        assert frames[-1]["message"] == (
            "A reply is still being generated. Wait for it to finish or stop it "
            "before sending another message."
        )

        mock_llm.release_streams()
        await _drain_until(ws, lambda frame: frame.get("type") == "final", timeout=10.0)


_BUSY_EN = (
    "A reply is still being generated. Wait for it to finish or stop it "
    "before sending another message."
)


async def _busy_error_message(ws: ClientConnection, session_id: str) -> str:
    """Provoke the serial-gate ``cmd_error`` and return its display text."""
    await ws.send(json.dumps({"type": "chat", "session_id": session_id, "input": "first"}))
    assert json.loads(await ws.recv())["type"] == "ack"
    await ws.send(json.dumps({"type": "chat", "session_id": session_id, "input": "second"}))
    frames = await _drain_until(ws, lambda frame: frame.get("type") == "cmd_error", timeout=3.0)
    return frames[-1]["message"]


async def test_hello_locale_overrides_the_handshake_header(
    ws_creds, ws_service, mock_llm,
) -> None:
    """The browser WebSocket API cannot set request headers, so the UI language the user
    picked arrives in the hello frame; ``Accept-Language`` is only the fallback for clients
    that *can* set it (CLI / tray). A Chinese header must not win over an explicit ``en``.
    """
    ws_url, token = ws_creds
    _, _, base = ws_service
    session_id = await _create_session(base, token)
    mock_llm.enqueue_text("first")
    mock_llm.hold_next_stream()

    async with websockets.connect(
        ws_url,
        proxy=None,
        additional_headers={"Accept-Language": "zh-CN,zh;q=0.9"},
    ) as ws:
        await ws.send(json.dumps({
            "type": "hello", "token": token, "client_id": "test-1",
            "client_type": "test", "locale": "en",
        }))
        assert json.loads(await ws.recv()) == {"type": "ready"}
        await _subscribe(ws, session_id)

        assert await _busy_error_message(ws, session_id) == _BUSY_EN

        mock_llm.release_streams()
        await _drain_until(ws, lambda frame: frame.get("type") == "final", timeout=10.0)


async def test_set_locale_switches_language_on_a_live_connection(
    ws_creds, ws_service, mock_llm,
) -> None:
    """Switching the UI language must not tear down the socket mid-stream, so the change
    rides a lightweight frame rather than a reconnect."""
    ws_url, token = ws_creds
    _, _, base = ws_service
    session_id = await _create_session(base, token)
    mock_llm.enqueue_text("first")
    mock_llm.hold_next_stream()

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)

        await ws.send(json.dumps({"type": "set_locale", "locale": "en"}))
        assert json.loads(await ws.recv())["type"] == "ack"

        assert await _busy_error_message(ws, session_id) == _BUSY_EN

        mock_llm.release_streams()
        await _drain_until(ws, lambda frame: frame.get("type") == "final", timeout=10.0)


async def _drain_until(ws: ClientConnection, predicate, timeout: float = 5.0) -> list:
    """Read frames until ``predicate(frame)`` returns True; return all read."""
    out: list = []
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise asyncio.TimeoutError(f"predicate not satisfied; got {out}")
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=remaining))
        out.append(frame)
        if predicate(frame):
            return out


async def test_pre_shutdown_broadcast_reaches_system_subscriber_before_close(
    ws_service,
) -> None:
    """The pre-shutdown hook broadcasts while WebSocket I/O remains available."""
    app, ws_url, _base = ws_service

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, app.state.auth.current_token)
        await ws.send(json.dumps({"type": "subscribe", "topics": ["system"]}))
        assert json.loads(await ws.recv()) == {
            "type": "ack",
            "for": "subscribe",
            "topics": ["system"],
        }

        await app.pre_shutdown_hook()

        assert json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0)) == {
            "type": "system.shutdown",
            "reason": "server shutting down",
            "grace_seconds": app._shutdown_grace_seconds,
        }
        await ws.send(json.dumps({"type": "unsubscribe", "topics": ["system"]}))
        assert json.loads(await ws.recv()) == {
            "type": "ack",
            "for": "unsubscribe",
            "topics": ["system"],
        }


async def test_build_think_can_ask_before_replacing_unfinished_workspace(ws_creds, ws_service, mock_llm) -> None:
    """Main re-entry asks once, then keep restores the prior Build stage."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)
    record = await SessionRepository().load(session_id, LOCAL_USER_ID)
    assert record is not None
    await SessionRepository().rename(session_id, LOCAL_USER_ID, "Existing build")
    workspace = Workspace(session_id, session_root=Path(record.workspace_root))
    build = await workspace.prepare_build_space("create", stage="generate")
    (build.root / "task.md").write_text("existing task", encoding="utf-8")
    await persist_session_turn(
        record,
        UserInput(text="pause build"),
        {
            "state": {
                "think": {"mode": "normal", "stage": "main"},
                "interaction": None,
            },
            "ota_record": [],
        },
        status=SessionStatus.COMPLETED,
        last_answer="Build paused",
    )

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        mock_llm.enqueue_tool_calls({
            "name": "request_build",
            "arguments": {
                "goal": "构建一个新的可复用任务",
                "mode": "ask",
                "reason": "新请求像是另一个任务，而当前工作流仍停在生成阶段。",
            },
        })
        await ws.send(json.dumps({
            "type": "chat",
            "session_id": session_id,
            "input": "/build a new task",
            "blocks": [
                {"type": "slash", "id": "build", "label": "构建"},
                {"type": "text", "value": " a new task"},
            ],
        }))
        asked = await _drain_until(ws, lambda frame: frame.get("type") == "human_request")
        request = next(frame for frame in asked if frame.get("type") == "human_request")
        # 卡片文案跟随**用户输入语言**(这里是英文 "/build a new task"),而不是客户端声明的
        # 界面语言 —— 与模型自己的回复语言同源。question 里插的 reason 是模型写的,
        # 这个 mock 固定吐中文,真实模型会同样跟随输入语言。
        labels = [option["label"] for option in request["questions"][0]["options"]]
        assert labels == ["Keep and continue", "Merge new requirements", "Discard and start over"]
        assert "当前工作流仍停在生成阶段" in request["questions"][0]["question"]
        await _drain_until(ws, lambda frame: frame.get("type") == "final")

        mock_llm.enqueue_tool_calls({"name": "switch", "arguments": {"mode": "normal"}})
        await ws.send(json.dumps({
            "type": "chat",
            "session_id": session_id,
            "input": "当前 Session 中还有一个未完成的 Build，如何处理？: 保留并继续",
        }))
        resumed = await _drain_until(ws, lambda frame: frame.get("type") == "final")
        assert any(
            frame.get("type") == "stage"
            and frame.get("mode") == "build"
            and frame.get("stage") == "generate"
            for frame in resumed
        )

    latest = await SessionTurnRepository().latest(session_id, LOCAL_USER_ID)
    assert latest is not None
    assert latest.agent_state["think"] == {"mode": "normal", "stage": "main"}
    assert latest.user_input.text == "/build a new task"
    assert (workspace.work_dir / BUILD_DIR_NAME).is_dir()


@pytest.mark.parametrize("acceptance_reply", ["card", "natural_language"])
async def test_clarify_task_review_confirms_before_explore(
    ws_creds,
    ws_service,
    mock_llm,
    acceptance_reply: str,
) -> None:
    """Clarify reviews acceptance before writing task.md, then confirms the task."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)
    record = await SessionRepository().load(session_id, LOCAL_USER_ID)
    assert record is not None
    workspace = Workspace(session_id, session_root=Path(record.workspace_root))
    task_path = workspace.work_dir / BUILD_DIR_NAME / "task.md"
    task_markdown = """## Task
Build a report

## Workflow
```mermaid
flowchart TD
    A[Read input] --> B[Write report]
```

## Expected output
- A report file

    ## Constraints & notes
    - Keep the source unchanged
    """
    mock_llm.enqueue_tool_calls({
        "name": "request_build",
        "arguments": {
            "goal": "build a report workflow",
            "mode": "start",
        },
    })
    mock_llm.enqueue_tool_calls({
        "name": "request_accept_rule",
        "arguments": {"rules": ["The report file exists."]},
    })
    mock_llm.enqueue_tool_calls({
        "name": "write_file",
        "arguments": {"file_path": ".build/task.md", "content": task_markdown},
    })
    mock_llm.enqueue_tool_calls({
        "name": "request_human_task_confirm",
        "arguments": {},
    })
    mock_llm.enqueue_tool_calls({"name": "switch", "arguments": {"mode": "normal"}})

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        await ws.send(json.dumps({
            "type": "chat",
            "session_id": session_id,
            "input": "/build a report workflow",
            "blocks": [
                {"type": "slash", "id": "build", "label": "构建"},
                {"type": "text", "value": " a report workflow"},
            ],
        }))
        parked = await _drain_until(ws, lambda frame: frame.get("type") == "final")
        accept_request = next(
            (
                frame
                for frame in parked
                if frame.get("type") == "accept_rule_request"
            ),
            None,
        )
        assert accept_request is not None
        assert accept_request["rules"] == ["The report file exists."]
        assert not task_path.exists()
        if acceptance_reply == "card":
            await ws.send(json.dumps({
                "type": "accept_rule",
                "session_id": session_id,
                "request_id": accept_request["request_id"],
                "decisions": ["accept"],
                "supplement": "",
            }))
        else:
            await ws.send(json.dumps({
                "type": "chat",
                "session_id": session_id,
                "input": "The proposed completion check looks good as a whole. Please continue.",
            }))
        reviewed = await _drain_until(ws, lambda frame: frame.get("type") == "final")
        request = next(
            frame for frame in reviewed if frame.get("type") == "task_confirm_request"
        )
        assert task_path.read_text(encoding="utf-8").strip() == task_markdown.strip()
        assert request["task_markdown"] == task_markdown.strip()
        assert request["previous_task_markdown"] == ""
        assert sum(
            frame.get("type") == "accept_rule_request"
            for frame in [*parked, *reviewed]
        ) == 1
        assert any(
            frame.get("type") == "stage" and frame.get("stage") == "clarify"
            for frame in [*parked, *reviewed]
        )
        pending = await SessionTurnRepository().latest(session_id, LOCAL_USER_ID)
        assert pending is not None
        assert pending.status is TurnStatus.AWAITING_HUMAN
        assert pending.agent_state["interaction"]["task_confirm"]["request_id"] == request["request_id"]

        await ws.send(json.dumps({
            "type": "task_confirm",
            "session_id": session_id,
            "request_id": request["request_id"],
            "action": "confirm",
        }))
        resumed = await _drain_until(ws, lambda frame: frame.get("type") == "final")
        assert any(
            frame.get("type") == "stage" and frame.get("stage") == "explore"
            for frame in resumed
        )

    latest = await SessionTurnRepository().latest(session_id, LOCAL_USER_ID)
    assert latest is not None
    assert latest.status is TurnStatus.COMPLETED
    assert latest.agent_state["think"] == {"mode": "normal", "stage": "main"}


async def test_subagent_runs_on_its_session_topic_and_rejoins_parent(ws_creds, ws_service, mock_llm) -> None:
    """A Child uses normal Session HITL before its result resumes the parent."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)
    mock_llm.enqueue_tool_calls({
        "name": "run_subagent",
        "arguments": {"goal": "Inspect the repository"},
    })
    mock_llm.enqueue_tool_calls({
        "name": "request_human_choice",
        "arguments": {"questions": json.dumps({"questions": [{
            "question": "Inspect tests or runtime first?",
            "options": [{"label": "tests"}, {"label": "runtime"}],
        }]}), "prompt": "Choose which repository area to inspect first."},
    })
    mock_llm.enqueue_text("Child inspection complete")
    mock_llm.enqueue_text("Parent joined the Child result")

    async def pending_request(child_session_id: str) -> dict:
        deadline = asyncio.get_event_loop().time() + 10
        async with live_client(base, token) as http:
            while asyncio.get_event_loop().time() < deadline:
                response = await http.get(f"/sessions/{child_session_id}/messages")
                request = response.json().get("pending_request")
                if request is not None:
                    return request
                await asyncio.sleep(0.01)
        raise asyncio.TimeoutError("Child Session did not persist its human request")

    frames = []
    child_id = None
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await ws.send(json.dumps({
            "type": "subscribe",
            "topics": [f"session:{session_id}", "system"],
        }))
        assert json.loads(await ws.recv())["type"] == "ack"
        await ws.send(json.dumps({
            "type": "chat",
            "session_id": session_id,
            "input": "Delegate repository inspection",
        }))

        deadline = asyncio.get_event_loop().time() + 15
        while asyncio.get_event_loop().time() < deadline:
            try:
                raw = await asyncio.wait_for(
                    ws.recv(),
                    timeout=deadline - asyncio.get_event_loop().time(),
                )
            except asyncio.TimeoutError:
                pytest.fail(f"parent did not rejoin its Child; frames={frames!r}")
            frame = json.loads(raw)
            frames.append(frame)
            if frame.get("type") == "subagent.event" and frame.get("phase") == "started":
                child_id = frame["invocation_id"]
                await ws.send(json.dumps({
                    "type": "subscribe",
                    "topics": [f"session:{child_id}"],
                }))
                request = await pending_request(child_id)
                assert request["questions"][0]["question"] == "Inspect tests or runtime first?"
                await ws.send(json.dumps({
                    "type": "chat",
                    "session_id": child_id,
                    "input": "Inspect tests or runtime first?: runtime",
                }))
            if (
                frame.get("type") == "final"
                and frame.get("session_id") == session_id
                and frame.get("answer") == "Parent joined the Child result"
            ):
                break
        else:
            pytest.fail(f"parent did not rejoin its Child; frames={frames!r}")

    assert child_id is not None
    lifecycle = [
        frame for frame in frames
        if frame.get("type") == "subagent.event"
        and frame.get("invocation_id") == child_id
    ]
    assert any(frame.get("phase") == "started" for frame in lifecycle)
    assert any(
        frame.get("phase") == "status" and frame.get("status") == "completed"
        for frame in lifecycle
    )
    assert any(
        frame.get("type") == "token" and frame.get("session_id") == child_id
        for frame in frames
    )
    assert [
        frame.get("answer")
        for frame in frames
        if frame.get("type") == "final" and frame.get("session_id") == session_id
    ] == ["Parent joined the Child result"]

    child = await SessionRepository().load(child_id, LOCAL_USER_ID)
    assert child is not None
    assert child.parent_session_id == session_id
    assert child.parent_call_id is not None
    child_turns = await SessionTurnRepository().list_conversation(LOCAL_USER_ID, child_id)
    assert len(child_turns) == 1
    assert child_turns[0].status is TurnStatus.COMPLETED
    async with live_client(base, token) as http:
        child_messages = (await http.get(f"/sessions/{child_id}/messages")).json()
        parent_messages = (await http.get(f"/sessions/{session_id}/messages")).json()
    assert child_messages["pending_request"] is None
    assert [message["text"] for message in child_messages["messages"]] == [
        "Inspect the repository",
        "Child inspection complete",
    ]
    assert {
        "type": "confirmation",
        "prompt": "Choose which repository area to inspect first.",
        "question": "Inspect tests or runtime first?",
        "response": "Inspect tests or runtime first?: runtime",
    } in child_messages["messages"][-1]["blocks"]
    subagent_blocks = [
        block
        for message in parent_messages["messages"]
        for block in message.get("blocks", [])
        if block.get("type") == "subagent"
    ]
    assert subagent_blocks == [{
        "type": "subagent",
        "invocationId": child_id,
        "goal": "Inspect the repository",
        "status": "completed",
        "answer": "Child inspection complete",
    }]

    child_turns = await SessionTurnRepository().list_conversation(LOCAL_USER_ID, child_id)
    assert len(child_turns) == 1
    assert child_turns[0].status is TurnStatus.COMPLETED
    assert child_turns[0].final_answer == "Child inspection complete"

    parent_turns = await SessionTurnRepository().list_conversation(LOCAL_USER_ID, session_id)
    assert len(parent_turns) == 1
    assert parent_turns[0].status is TurnStatus.COMPLETED
    assert parent_turns[0].final_answer == "Parent joined the Child result"


# ----------------------------------------------------------------------
# Multiplexing — subscribe/unsubscribe acks, per-session event delivery,
# workspace cwd, cross-connection delivery, and the serial gate
# ----------------------------------------------------------------------
async def test_multiplex_subscribe_acks_event_delivery_and_serial_gate(
    ws_creds, ws_service, mock_llm,
) -> None:
    """The full multiplexing surface in one flow:

    * Acks: session topics and the first-class ``system`` topic round-trip a
      subscribe AND an unsubscribe ack.
    * Event delivery: one WS subscribed to two sessions — session A runs a
      ``bash pwd`` turn (its concatenated tokens + ``final`` carry sid_a, every
      typed frame is tagged sid_a, and the tool ran in the session's ``.work``
      cwd from the <Workspace> line); session B then runs a text turn tagged
      sid_b, proving the multiplex keeps streams apart.
    * Cross-connection: a listener that subscribed BEFORE any chat (no bus yet)
      receives the full stream of a chat started on a DIFFERENT connection.
    * Serial gate: a second chat on a session whose turn is still in flight
      returns a user-facing ``cmd_error``, never a second concurrent run.
    """
    app, ws_url, base = ws_service
    token = app.state.auth.current_token

    # --- Acks: session topic subscribe + unsubscribe, and the system topic. ---
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await ws.send(json.dumps({"type": "subscribe", "topics": ["session:abc"]}))
        ack = json.loads(await ws.recv())
        assert ack == {"type": "ack", "for": "subscribe", "topics": ["session:abc"]}
        await ws.send(json.dumps({"type": "unsubscribe", "topics": ["session:abc"]}))
        ack = json.loads(await ws.recv())
        assert ack == {"type": "ack", "for": "unsubscribe", "topics": ["session:abc"]}
        await ws.send(json.dumps({"type": "subscribe", "topics": ["system"]}))
        ack = json.loads(await ws.recv())
        assert ack == {"type": "ack", "for": "subscribe", "topics": ["system"]}

    # --- Event delivery: two sessions on one WS, streams tagged + cwd correct. ---
    sid_a = await _create_session(base, token)
    sid_b = await _create_session(base, token)
    async with live_client(base, token) as http:
        detail = (await http.get(f"/sessions/{sid_a}")).json()
    workspace_root = detail["workspace_root"]

    mock_llm.enqueue_tool_calls({
        "name": "bash",
        "arguments": {
            "command": "pwd",
            "cwd": str(Path(workspace_root) / ".work"),
        },
    })
    mock_llm.enqueue_text("hello from ws")  # session A's final answer
    mock_llm.enqueue_text("BBB")            # session B's answer

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await ws.send(json.dumps({
            "type": "subscribe",
            "topics": [f"session:{sid_a}", f"session:{sid_b}"],
        }))
        assert json.loads(await ws.recv())["type"] == "ack"

        # Session A: a tool-running turn.
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid_a, "input": "where are you?",
        }))
        a_frames = await _drain_until(
            ws, lambda f: f.get("type") == "final" and f.get("session_id") == sid_a,
            timeout=10.0,
        )

        # Session B: a text turn.
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid_b, "input": "hi B",
        }))
        b_frames = await _drain_until(
            ws, lambda f: f.get("type") == "final" and f.get("session_id") == sid_b,
            timeout=10.0,
        )

    # The chat ack for A is present and tagged.
    acks = [f for f in a_frames if f.get("type") == "ack" and f.get("for") == "chat"]
    assert len(acks) == 1 and acks[0]["session_id"] == sid_a

    # Every typed A frame carries sid_a (no B leakage).
    for f in a_frames:
        if f.get("type") in ("token", "tool", "tool_result", "loop_abort",
                              "final", "model_switch_warning"):
            assert f.get("session_id") == sid_a

    # A's tokens + final answer.
    a_tokens = "".join(
        f["text"] for f in a_frames
        if f.get("type") == "token" and f.get("session_id") == sid_a
    )
    assert a_tokens == "hello from ws"
    a_finals = [f for f in a_frames if f.get("type") == "final"]
    assert len(a_finals) == 1
    assert a_finals[0]["answer"] == "hello from ws"

    # The bash tool ran in the session's ``.work`` subdir (its real cwd).
    a_results = [f for f in a_frames if f.get("type") == "tool_result"]
    assert len(a_results) == 1
    assert a_results[0]["output"].strip() == str(Path(workspace_root) / ".work")

    # B's stream is independently tagged + assembled.
    b_tokens = "".join(
        f["text"] for f in b_frames
        if f.get("type") == "token" and f.get("session_id") == sid_b
    )
    assert b_tokens == "BBB"
    b_finals = [f for f in b_frames if f.get("type") == "final"]
    assert len(b_finals) == 1 and b_finals[0]["session_id"] == sid_b

    # --- Cross-connection delivery: listener subscribed before any chat. ---
    sid = await _create_session(base, token)
    mock_llm.enqueue_text("cross conn hi")
    async with websockets.connect(ws_url, proxy=None) as listener, \
            websockets.connect(ws_url, proxy=None) as chatter:
        await _hello(listener, token, client_id="listener")
        await _hello(chatter, token, client_id="chatter")

        # The listener subscribes BEFORE any chat; no bus exists yet.
        await _subscribe(listener, sid)

        # A DIFFERENT connection (not subscribed) drives the chat.
        await chatter.send(json.dumps({
            "type": "chat", "session_id": sid, "input": "hi",
        }))
        assert json.loads(await chatter.recv()) == {
            "type": "ack", "for": "chat", "session_id": sid,
        }

        # The listener — though it never chatted — sees the turn's stream.
        frames = await _drain_until(
            listener, lambda f: f.get("type") == "final", timeout=10.0,
        )
    tokens = "".join(
        f["text"] for f in frames
        if f.get("type") == "token" and f.get("session_id") == sid
    )
    assert tokens == "cross conn hi"
    finals = [f for f in frames if f.get("type") == "final"]
    assert len(finals) == 1 and finals[0]["session_id"] == sid
    assert finals[0]["answer"] == "cross conn hi"

    # --- Serial gate: concurrent chat on a busy session → cmd_error. ---
    sid2 = await _create_session(base, token)
    mock_llm.enqueue_text("first")
    mock_llm.hold_next_stream()  # pin the first turn in-flight
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid2)
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid2, "input": "first",
        }))
        assert json.loads(await ws.recv())["type"] == "ack"

        # Turn 2 — same session, while turn 1 is held → cmd_error.
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid2, "input": "second",
        }))
        cmd_err = await _drain_until(
            ws, lambda f: f.get("type") == "cmd_error", timeout=3.0,
        )
        last = cmd_err[-1]
        assert last["for"] == "chat"
        assert last["session_id"] == sid2
        assert last["message"] == "当前回复仍在生成，请等待完成或先停止，再发送新消息。"

        # Release turn 1 + let it finish to keep teardown tidy.
        mock_llm.release_streams()
        await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)


async def test_human_request_marks_awaiting_then_answered_clears_it(
    ws_creds, ws_service, mock_llm,
) -> None:
    """A human request moves the Session into and back out of ``awaiting``.

    Reading cannot clear a pending request. Accepting its matching answer clears
    the awaiting projection before the resumed stream finishes; the legacy
    ``/answered`` endpoint remains idempotent.
    """
    _, _, base = ws_service
    ws_url, token = ws_creds

    sid = await _create_session(base, token)
    mock_llm.enqueue_tool_calls({
        "name": "request_human_choice",
        "arguments": {"questions": json.dumps({"questions": [{
            "question": "Skill or code?",
            "options": [{"label": "skill"}, {"label": "code"}],
        }]}), "prompt": "Pick the preferred implementation route."},
    })

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "set it up"}))
        asked = await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)
    request = next(f for f in asked if f.get("type") == "human_request")
    assert request["prompt"] == "Pick the preferred implementation route."
    assert request["questions"][0]["question"] == "Skill or code?"

    async with live_client(base, token) as http:
        status = (await http.get(f"/sessions/{sid}")).json()["status"]
        assert status == "awaiting"
        pending = (await http.get(f"/sessions/{sid}/messages")).json()["pending_request"]
        assert pending["prompt"] == "Pick the preferred implementation route."

        # Reading is not an answer, so it cannot clear the pending state.
        assert (await http.post(f"/sessions/{sid}/read")).status_code == 204
        status = (await http.get(f"/sessions/{sid}")).json()["status"]
        assert status == "awaiting"
        assert (await http.get(f"/sessions/{sid}/messages")).json()["pending_request"] is not None

        mock_llm.enqueue_text("done")
        mock_llm.hold_next_stream()
        async with websockets.connect(ws_url, proxy=None) as ws:
            await _hello(ws, token)
            await _subscribe(ws, sid)
            await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "code"}))
            await _drain_until(
                ws,
                lambda frame: frame.get("type") == "ack",
                timeout=3.0,
            )

            status = (await http.get(f"/sessions/{sid}")).json()["status"]
            assert status == "finish"
            # The parked Turn remains durable while the resumed model stream is
            # held, but switching sessions must not rehydrate its handled ask.
            assert (await http.get(f"/sessions/{sid}/messages")).json()["pending_request"] is None

            mock_llm.release_streams()
            await _drain_until(ws, lambda frame: frame.get("type") == "final", timeout=10.0)

        assert (await http.post(f"/sessions/{sid}/answered")).status_code == 204  # idempotent

        # Ownership-gated: unknown id → 404.
        assert (await http.post("/sessions/nope/answered")).status_code == 404


async def test_permission_gate_park_resume_deny_and_approve(
    ws_creds, ws_service, mock_llm,
) -> None:
    """End-to-end permission gate: a tool the policy ASKs (a read OUTSIDE the
    workspace) HOLDS the whole turn — the agent emits a ``permission_request`` (the
    request_human_choice contract: one allow/deny question per held call) and ends the
    turn awaiting the user; the Session status becomes ``awaiting``. The next
    message resolves the verdict and the turn RESUMES and finishes, clearing the
    awaiting state.

    Both verdicts in one flow:

    * Deny: the held call FOLDS (no execution) and the turn finishes.
    * Approve: the held tool actually RUNS on resume. The verdict is read from the
      user's reply (``allow``) — NOT the original request (the bug that read the
      wrong text and silently denied every approval) — so the read EXECUTES (its
      result is in the transcript, not a deny).
    """
    _, _, base = ws_service
    ws_url, token = ws_creds

    # 新引擎:读宽松(越界读也放行)。改用"越界写"在 request 模式下确定触发 ASK,
    # 且不经安全分类器(不会扰动 mock_llm 的 enqueue 序列)。
    from src.amphi_service.auth import LOCAL_USER_ID
    from src.amphi_store import UserRepository
    await UserRepository().set_execution_mode(LOCAL_USER_ID, "request")

    # --- Deny: ask parks awaiting, the reply resumes, the held call folds. ---
    sid = await _create_session(base, token)
    mock_llm.enqueue_tool_calls(
        {"name": "write_file", "arguments": {"file_path": ".env.deny", "content": "x"}}
    )
    mock_llm.enqueue_text("done")  # the resume's continuation after the verdict

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "read it"}))
        asked = await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)
        req = next(f for f in asked if f.get("type") == "permission_request")
        assert req["kind"] == "choose"
        assert "write_file" in req["questions"][0]["question"]

        # The turn parked awaiting the user → the session-card icon is on.
        async with live_client(base, token) as http:
            assert (await http.get(f"/sessions/{sid}")).json()["status"] == "awaiting"

        # Answer (deny) via the dedicated permission_answer frame (echoing request_id +
        # the held call's call_index) → the turn resumes, the held call folds, finishes.
        mock_llm.hold_next_stream()
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid,
            "request_id": req["request_id"],
            "answers": [{"call_index": req["items"][0]["call_index"], "decision": "deny"}],
        }))
        await _drain_until(
            ws,
            lambda frame: frame.get("type") == "ack" and frame.get("for") == "permission_answer",
            timeout=3.0,
        )
        async with live_client(base, token) as http:
            assert (await http.get(f"/sessions/{sid}")).json()["status"] == "finish"
            detail = (await http.get(f"/sessions/{sid}/messages")).json()
            assert detail["pending_request"] is None
        mock_llm.release_streams()
        await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)

    # The interaction resolved → no longer awaiting (the icon clears).
    async with live_client(base, token) as http:
        assert (await http.get(f"/sessions/{sid}")).json()["status"] == "completed"

    # --- Approve: the reply ("allow") runs the held tool on resume. ---
    sid2 = await _create_session(base, token)
    mock_llm.enqueue_tool_calls(
        {"name": "write_file", "arguments": {"file_path": ".env.approve", "content": "x"}}
    )
    mock_llm.enqueue_text("done")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid2)
        await ws.send(json.dumps({"type": "chat", "session_id": sid2, "input": "read /etc/hosts for me"}))
        approved_ask = await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)
        req2 = next(f for f in approved_ask if f.get("type") == "permission_request")  # the turn really asked
        # Approve via the dedicated frame — the decision comes from the answer, not any
        # chat text, so the held tool actually RUNS on resume (structurally can't misread).
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid2,
            "request_id": req2["request_id"],
            "answers": [{"call_index": req2["items"][0]["call_index"], "decision": "allow"}],
        }))
        await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)

    async with live_client(base, token) as http:
        msgs = (await http.get(f"/sessions/{sid2}/messages")).json()["messages"]
        writes = [tc for m in msgs for tc in m.get("toolCalls", []) if tc["name"] == "write_file"]
        assert writes, "write_file never ran — the approval was lost"
        assert writes[-1]["result"]["isError"] is False  # actually executed, not denied
        assert (await http.get(f"/sessions/{sid2}")).json()["status"] == "completed"


async def test_permission_gate_mixed_allow_deny_per_item(
    ws_creds, ws_service, mock_llm,
) -> None:
    """多工具队列卡:一批两个都 ASK 的调用,用户"允许 A + 拒绝 B",恢复后**逐项各自
    生效**(A 执行、B 被拒),而非旧折叠码的"非全允即全拒"。回复附 ``[instruction]``
    行也不占答案槽、不打断恢复。"""
    _, _, base = ws_service
    ws_url, token = ws_creds

    from src.amphi_service.auth import LOCAL_USER_ID
    from src.amphi_store import UserRepository
    await UserRepository().set_execution_mode(LOCAL_USER_ID, "request")

    sid = await _create_session(base, token)
    # 两个敏感文件写(相对路径落工作区内,sensitive 判定先于工作区放行 → request 模式都 ASK,
    # 且被批准的能真实写入工作区成功);顺序 = tool_calls 顺序 = 回复行顺序。
    mock_llm.enqueue_tool_calls(
        {"name": "write_file", "arguments": {"file_path": ".env.allow", "content": "x"}},
        {"name": "write_file", "arguments": {"file_path": ".env.deny", "content": "x"}},
    )
    mock_llm.enqueue_text("done")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "write both"}))
        asked = await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)
        req = next(f for f in asked if f.get("type") == "permission_request")  # 真的问了
        # 逐项:第 1 个 allow(带 instruction)、第 2 个 deny —— 按各自 call_index 独立裁决。
        idx = [it["call_index"] for it in req["items"]]
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid,
            "request_id": req["request_id"],
            "answers": [
                {"call_index": idx[0], "decision": "allow", "instruction": "be careful"},
                {"call_index": idx[1], "decision": "deny"},
            ],
        }))
        await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)

    async with live_client(base, token) as http:
        detail = (await http.get(f"/sessions/{sid}/messages")).json()
        msgs = detail["messages"]
        writes = [tc for m in msgs for tc in m.get("toolCalls", []) if tc["name"] == "write_file"]
        # 逐项裁决:恰好一个执行(isError False)、一个被拒(isError True)。
        # 旧折叠码(全允才允)会把两个都拒 → [True, True]。
        assert sorted(tc["result"]["isError"] for tc in writes) == [False, True]

        # 终态卡持久化(Phase 1.4):已决审批作为 permission block 落在 transcript(decided=True),
        # 逐项带 call_index + decision;答复后 pending_request 清空(不再重画 pending 卡)。
        perm_blocks = [b for m in msgs for b in m.get("blocks", []) if b.get("type") == "permission"]
        assert len(perm_blocks) == 1, "已决审批应派生成恰好一张终态卡"
        decided = perm_blocks[0]
        assert decided.get("decided") is True
        by_decision = {it["decision"] for it in decided["items"]}
        assert by_decision == {"allow", "deny"}  # 逐项各自生效,与工具执行结果一致
        allowed = next(it for it in decided["items"] if it["decision"] == "allow")
        assert allowed.get("instruction") == "be careful"  # 允许项携带的指令随卡持久化
        assert all("callIndex" in it for it in decided["items"])  # 对齐键持久化(REST 契约 camelCase)
        assert detail.get("pending_request") in (None, {})  # 已答复 → 无 pending 卡


async def test_permission_gate_guards_stray_messages_and_is_idempotent(
    ws_creds, ws_service, mock_llm,
) -> None:
    """专用审批通道的守卫与幂等(Phase 1.2/1.3):

    挂起审批期间——
      * 普通 chat 被拒(``cmd_error``),且**不**误当审批回复去 fail-closed 拒绝挂起工具
        (旧 chat 通道的 bug):会话保持 awaiting,挂起请求不被静默丢弃;
      * request_id 不匹配的 permission_answer 被幂等忽略(``ack``);
    答复解决后——
      * 同一 request_id 再次回传 → 幂等 ``ack``,不再跑一轮、状态仍 finish。
    """
    _, _, base = ws_service
    ws_url, token = ws_creds

    from src.amphi_service.auth import LOCAL_USER_ID
    from src.amphi_store import UserRepository
    await UserRepository().set_execution_mode(LOCAL_USER_ID, "request")

    sid = await _create_session(base, token)
    mock_llm.enqueue_tool_calls(
        {"name": "write_file", "arguments": {"file_path": "/elsewhere/amphi_guard.txt", "content": "x"}}
    )
    mock_llm.enqueue_text("done")  # resume 续跑

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "write it"}))
        asked = await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)
        req = next(f for f in asked if f.get("type") == "permission_request")

        # 1. 挂起期间发普通 chat → 被拒,且不产生新一轮(无 final)。
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "随便说点别的"}))
        err = await _drain_until(ws, lambda f: f.get("type") == "cmd_error", timeout=5.0)
        assert any(f.get("type") == "cmd_error" for f in err)
        assert err[-1]["message"] == (
            "A permission request is pending; answer it before sending other messages"
        )

        # 挂起请求没有被静默丢弃/拒绝 —— 会话仍 awaiting。
        async with live_client(base, token) as http:
            assert (await http.get(f"/sessions/{sid}")).json()["status"] == "awaiting"

        # 2. request_id 不匹配的 permission_answer → 幂等 ack，挂起请求不变。
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid, "request_id": "stale-id",
            "answers": [{"call_index": req["items"][0]["call_index"], "decision": "allow"}],
        }))
        stale = await _drain_until(
            ws,
            lambda f: f.get("type") == "ack" and f.get("for") == "permission_answer",
            timeout=5.0,
        )
        assert any(f.get("type") == "ack" for f in stale)
        async with live_client(base, token) as http:
            assert (await http.get(f"/sessions/{sid}")).json()["status"] == "awaiting"

        # 3. 正确回传 → 续跑并 finish。
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid, "request_id": req["request_id"],
            "answers": [{"call_index": req["items"][0]["call_index"], "decision": "allow"}],
        }))
        await _drain_until(ws, lambda f: f.get("type") == "final", timeout=10.0)

        # 4. 同 request_id 再次回传 → 幂等 ack,不再跑一轮。
        await ws.send(json.dumps({
            "type": "permission_answer", "session_id": sid, "request_id": req["request_id"],
            "answers": [{"call_index": req["items"][0]["call_index"], "decision": "allow"}],
        }))
        acked = await _drain_until(ws, lambda f: f.get("type") == "ack" and f.get("for") == "permission_answer", timeout=5.0)
        assert any(f.get("type") == "ack" for f in acked)
        assert not any(f.get("type") == "final" for f in acked)  # 没有新的一轮

    async with live_client(base, token) as http:
        assert (await http.get(f"/sessions/{sid}")).json()["status"] == "completed"


async def test_stale_structured_interaction_answers_are_idempotent(
    ws_creds, ws_service,
) -> None:
    """Every dedicated interaction answer ACKs when no matching request remains."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    sid = await _create_session(base, token)
    messages = [
        {
            "type": "build_confirm",
            "session_id": sid,
            "request_id": "stale-build",
            "action": "cancel",
        },
        {
            "type": "task_confirm",
            "session_id": sid,
            "request_id": "stale-task",
            "action": "revise",
        },
        {
            "type": "workflow_confirm",
            "session_id": sid,
            "request_id": "stale-workflow",
            "action": "cancel",
        },
    ]

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        for message in messages:
            await ws.send(json.dumps(message))
            frames = await _drain_until(
                ws,
                lambda frame: (
                    frame.get("type") == "ack"
                    and frame.get("for") == message["type"]
                ),
                timeout=5.0,
            )
            assert not any(frame.get("type") == "final" for frame in frames)

    async with live_client(base, token) as http:
        detail = (await http.get(f"/sessions/{sid}/messages")).json()
        assert detail["messages"] == []


# ----------------------------------------------------------------------
# stop — a real cancel: the visible partial Turn always survives
# ----------------------------------------------------------------------
async def test_stop_cancels_inflight_turn_and_keeps_completed_rounds(
    ws_creds, ws_service, mock_llm,
) -> None:
    """``POST /sessions/{id}/stop`` is a REAL cancel of the in-flight agent
    task, and it KEEPS the work already done.

    * Stopped during round 1's held LLM call: the gate frees promptly and the
      cancelled Turn's user input remains visible after reload.
    * Stopped after a completed round (round 1 wrote a file; round 2 hangs in a
      long bash): the completed round survives — GET /messages shows the
      stopped turn's user input AND its write_file tool card.
    """
    app, _, base = ws_service
    ws_url, token = ws_creds

    # --- Scenario A: stop before round 1 completes → keep the cancelled Turn. ---
    sid = await _create_session(base, token)
    mock_llm.hold_next_stream()  # the turn will hang inside the LLM call
    mock_llm.enqueue_text("should never finish")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        requests_before = len(mock_llm.requests_received)
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid, "input": "burn tokens",
        }))
        # Wait until the request reaches the held LLM stream. `is_running()`
        # becomes true as soon as the task is registered, while it may still be
        # preparing context; cancelling there intentionally has no partial Turn
        # to persist and does not exercise this scenario.
        for _ in range(40):
            if len(mock_llm.requests_received) > requests_before:
                break
            await asyncio.sleep(0.05)
        assert len(mock_llm.requests_received) > requests_before
        assert app.state.invocations.is_running(sid)

        async with live_client(base, token) as http:
            resp = await http.post(f"/sessions/{sid}/stop")
        assert resp.status_code == 200
        assert resp.json()["stopped"] is True

        # The agent task dies promptly — no turn keeps running in the dark.
        for _ in range(40):
            if not app.state.invocations.is_running(sid):
                break
            await asyncio.sleep(0.05)
        assert not app.state.invocations.is_running(sid)

        # The session is immediately usable: a fresh chat completes.
        mock_llm.release_streams()  # free the abandoned server-side generator
        mock_llm.enqueue_text("second turn ok")
        await _subscribe(ws, sid)
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid, "input": "again",
        }))
        frames = await _drain_until(
            ws, lambda f: f.get("type") == "final", timeout=10.0,
        )
    assert [f for f in frames if f.get("type") == "final"]
    # The stopped input remains before the next completed turn.
    async with live_client(base, token) as http:
        msgs = (await http.get(f"/sessions/{sid}/messages")).json()["messages"]
    assert [m["text"] for m in msgs if m["role"] == "user"] == ["burn tokens", "again"]
    stopped = next(m for m in msgs if m["role"] == "assistant" and m.get("stopped"))
    assert stopped["blocks"] == [{"type": "text", "text": "should never finish"}]

    # --- Scenario B: stop after a completed round → that round is SAVED. ---
    sid2 = await _create_session(base, token)
    async with live_client(base, token) as http:
        sid2_detail = (await http.get(f"/sessions/{sid2}")).json()
    sid2_work_dir = str(Path(sid2_detail["workspace_root"]) / ".work")
    mock_llm.enqueue_tool_calls(
        {"name": "write_file",
         "arguments": {"file_path": "marker.txt", "content": "kept\n"}},
    )
    mock_llm.enqueue_tool_calls(
        {"name": "bash", "arguments": {"command": "sleep 30", "cwd": sid2_work_dir}},
    )

    # Baseline the request log: scenario A already drove several requests, so
    # we wait for *two more* (this turn's round 1 + round 2), not an absolute
    # count.
    requests_before = len(mock_llm.requests_received)
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid2)
        await ws.send(json.dumps({
            "type": "chat", "session_id": sid2,
            "input": "write a marker then hang",
        }))

        # Wait until round 2's LLM call fired — its request landing proves
        # round 1's write_file ran and its result was fed back. bash is now
        # sleeping, so the turn is in flight with one COMPLETED round behind it.
        for _ in range(100):
            if len(mock_llm.requests_received) >= requests_before + 2:
                break
            await asyncio.sleep(0.05)
        assert len(mock_llm.requests_received) >= requests_before + 2
        assert app.state.invocations.is_running(sid2)

        async with live_client(base, token) as http:
            resp = await http.post(f"/sessions/{sid2}/stop")
        assert resp.json()["stopped"] is True

        # is_running flips False only after the cancel handler's persist ran.
        for _ in range(60):
            if not app.state.invocations.is_running(sid2):
                break
            await asyncio.sleep(0.05)
        assert not app.state.invocations.is_running(sid2)

    # The completed round was SAVED — the stopped turn's input + write_file card.
    async with live_client(base, token) as http:
        msgs = (await http.get(f"/sessions/{sid2}/messages")).json()["messages"]
    assert "write a marker then hang" in [m["text"] for m in msgs if m["role"] == "user"]
    assert "write_file" in [tc["name"] for m in msgs for tc in m.get("toolCalls", [])]


# ----------------------------------------------------------------------
# Cross-session unread — the sidebar dot, for both clean and errored turns
# ----------------------------------------------------------------------
async def test_completed_and_errored_turns_are_unread_and_read_receipt_clears(
    ws_creds, ws_service, mock_llm, monkeypatch,
) -> None:
    """Both a clean finish AND an errored turn are unread results that mark the
    session ``completed`` and BROADCAST ``session.completed`` on the system bus
    — so a client watching only ``system`` (not the session) still learns it has
    an unread result, the cross-session sidebar dot.

    * Clean finish: a ``system``-only subscriber gets ``session.completed`` (and
      none of the turn's per-session frames); ``POST /sessions/{id}/read`` then
      clears the status back to ``finish`` (idempotent), and the status rides on
      the REST summary so the dot survives a reload.
    * Errored turn (``AmphiAgent.arun`` raises): ends with an ``error`` frame,
      still marks ``completed`` + broadcasts ``session.completed`` — same as a
      clean finish — and the failed turn PERSISTS (user input + an error bubble)
      so the GUI can show its red dot.
    """
    _, _, base = ws_service
    ws_url, token = ws_creds

    # --- Clean finish: completed + broadcast, then read clears it. ---
    sid = await _create_session(base, token)
    mock_llm.enqueue_text("done")

    # Subscribe to `system` ONLY (never the session topic) — the completion must
    # still reach us, because it's a cross-session broadcast.
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await ws.send(json.dumps({"type": "subscribe", "topics": ["system"]}))
        assert json.loads(await ws.recv())["type"] == "ack"
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "hi"}))
        frames = await _drain_until(
            ws, lambda f: f.get("type") == "session.completed", timeout=10.0,
        )
    completed = next(f for f in frames if f.get("type") == "session.completed")
    assert completed["session_id"] == sid
    # A system-only subscriber never saw the turn's own per-session frames.
    assert not any(f.get("type") in ("token", "final") for f in frames)

    async with live_client(base, token) as http:
        assert (await http.get(f"/sessions/{sid}")).json()["status"] == "completed"
        assert (await http.post(f"/sessions/{sid}/read")).status_code == 204
        assert (await http.get(f"/sessions/{sid}")).json()["status"] == "finish"
        assert (await http.post(f"/sessions/{sid}/read")).status_code == 204  # idempotent

    # --- Errored turn: still an unread result (error frame + broadcast). ---
    from src.amphi_agent import AmphiAgent

    async def _boom(self, **kwargs):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(AmphiAgent, "arun", _boom)

    sid2 = await _create_session(base, token)

    # Watch the session (the error frame) AND system (the broadcast); drain until
    # BOTH land — they ride separate relays, so the wire order isn't fixed.
    seen: set = set()

    def _both(f) -> bool:
        seen.add(f.get("type"))
        return {"error", "session.completed"} <= seen

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid2)
        await ws.send(json.dumps({"type": "subscribe", "topics": ["system"]}))
        assert json.loads(await ws.recv())["type"] == "ack"
        await ws.send(json.dumps({"type": "chat", "session_id": sid2, "input": "hi"}))
        frames = await _drain_until(ws, _both, timeout=10.0)
    assert next(f for f in frames if f.get("type") == "session.completed")["session_id"] == sid2

    async with live_client(base, token) as http:
        assert (await http.get(f"/sessions/{sid2}")).json()["status"] == "completed"
        # The failed turn PERSISTS for the GUI: the user input + an error bubble.
        msgs = (await http.get(f"/sessions/{sid2}/messages")).json()["messages"]
        assert "hi" in [m["text"] for m in msgs if m["role"] == "user"]
        assert any("kaboom" in (m.get("error") or "") for m in msgs)
