"""Chat business semantics — credentials, model switch, history, LLM payload.

Phase 4 retired the ``POST /sessions/{id}/chat`` SSE path; all chat now
flows over the multiplexed ``/ws`` channel. These tests cover the chat
*business* layer (not the WS framing itself — that lives in
:mod:`test_ws`), consolidated into end-to-end scenarios:

* No-credentials guard — chat without ``/me/credentials`` errors clean.
* The service really hits the LLM with the expected shape, weaves
  multi-round history back into subsequent calls, and surfaces
  ``model_switch_warning`` iff the user changed model mid-session.
* One tool-running, mount-referencing turn's bookkeeping: tokens metered,
  last_answer persisted, tool durations attached, and an @-mention injects
  its mount path into the prompt only — never the stored transcript.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import websockets

from .conftest import live_client
from .test_ws import _create_session, _drain_until, _hello


async def _chat(ws, session_id: str, text: str, blocks=None) -> list:
    """Send one chat on an already-subscribed WS; drain to ``final``."""
    frame = {"type": "chat", "session_id": session_id, "input": text}
    if blocks is not None:
        frame["blocks"] = blocks
    await ws.send(json.dumps(frame))
    return await _drain_until(ws, lambda f: f.get("type") == "final", timeout=15.0)


async def _subscribe(ws, session_id: str) -> None:
    await ws.send(json.dumps({
        "type": "subscribe", "topics": [f"session:{session_id}"],
    }))
    await ws.recv()  # subscribe ack


async def test_chat_without_credentials_yields_cmd_error(ws_service) -> None:
    """No ``/me/credentials`` POSTed yet → ``cmd_error`` on chat."""
    app, ws_url, base = ws_service
    token = app.state.auth.current_token
    session_id = await _create_session(base, token)

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await ws.send(json.dumps({
            "type": "chat", "session_id": session_id, "input": "hi",
        }))
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))

    assert frame["type"] == "cmd_error"
    assert frame["for"] == "chat"
    assert frame["session_id"] == session_id
    assert "No AI provider key" in frame["message"]
    assert "/me/credentials" in frame["message"]


async def test_payload_history_weaving_and_model_switch_warning(
    ws_creds, ws_service, mock_llm,
) -> None:
    """Round 1: the mock sees ``stream=True``, the configured model, and the
    user's message (the service didn't shortcut the path) — and NO
    model_switch_warning when the model is unchanged. Round 2 on the same
    session weaves both user turns AND the first assistant reply back into the
    prompt. Then flipping ``/me/model`` makes a later chat surface exactly one
    ``model_switch_warning`` frame (before any token), with the from/to pair."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)  # stamps last_used_model=mock-model
    mock_llm.enqueue_text("first reply")
    mock_llm.enqueue_text("second reply")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        r1_frames = await _chat(ws, session_id, "round one")
        await _chat(ws, session_id, "round two")

    # Model unchanged across rounds 1+2 → no warning.
    assert "model_switch_warning" not in [f.get("type") for f in r1_frames]

    first = mock_llm.requests_received[0]
    assert first["stream"] is True
    assert first["model"] == "mock-model"
    assert any(
        "round one" in m["content"] for m in first["messages"] if m["role"] == "user"
    )

    assert len(mock_llm.requests_received) >= 2
    second_payload = "\n".join(
        m.get("content") or "" for m in mock_llm.requests_received[1]["messages"]
    )
    # Both user turns AND the first assistant reply are woven back into the
    # prompt — now inside the single <conversation> block, not separate messages.
    assert "round one" in second_payload
    assert "round two" in second_payload
    assert "first reply" in second_payload, (
        f"first reply not woven into 2nd call: {second_payload!r}"
    )

    # Now flip the active model → the next chat must surface a switch warning.
    async with live_client(base, token) as http:
        resp = await http.post("/me/model", json={"model": "alt-model"})
        assert resp.status_code == 200

    mock_llm.enqueue_text("after switch")
    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        switch_frames = await _chat(ws, session_id, "go")

    warnings = [f for f in switch_frames if f.get("type") == "model_switch_warning"]
    assert len(warnings) == 1
    assert warnings[0]["session_id"] == session_id
    assert warnings[0]["previous_model"] == "mock-model"
    assert warnings[0]["current_model"] == "alt-model"


async def test_turn_bookkeeping_and_mention_injection(
    ws_creds, ws_service, mock_llm, tmp_path,
) -> None:
    """One tool-running, mount-referencing turn carries the full bookkeeping:
    ``final`` carries the metered token split (mirrored onto ``session.tokens``),
    live ``usage`` events accrue, ``tool_result`` frames carry the act-phase
    wall-clock, and ``last_answer`` is persisted. The @-mention's absolute path
    is inlined into the prompt the agent sees, but the stored / replayed input
    stays the clean "@name" text — no path leaks into the transcript."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)

    folder = tmp_path / "proj"
    folder.mkdir()
    async with live_client(base, token) as http:
        detail = (await http.get(f"/sessions/{session_id}")).json()
        mount = (
            await http.post(
                f"/sessions/{session_id}/mounts", json={"path": str(folder)}
            )
        ).json()
    mid = mount["id"]

    mock_llm.enqueue_tool_calls({
        "name": "bash",
        "arguments": {
            "command": "echo hi",
            "cwd": str(Path(detail["workspace_root"]) / ".work"),
        },
    })
    mock_llm.enqueue_text("answer recorded")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        frames = await _chat(ws, session_id, "summarise @proj", blocks=[
            {"type": "text", "value": "summarise "},
            {"type": "mention", "id": mid, "label": "proj", "group": "文件/文件夹"},
        ])

    # --- Bookkeeping: tokens, usage, tool duration. ---
    finals = [f for f in frames if f.get("type") == "final"]
    assert len(finals) == 1
    final = finals[0]
    inp, out = final["input_tokens"], final["output_tokens"]
    assert inp > 0 and out > 0          # prompt + generation both metered
    assert final["tokens_spent"] == inp + out
    assert isinstance(final["duration_ms"], int) and final["duration_ms"] >= 0
    assert isinstance(final["completed_at"], str) and final["completed_at"]

    usages = [f for f in frames if f.get("type") == "usage"]
    assert usages, "expected at least one live usage event"
    assert all("input_tokens" in u and "output_tokens" in u for u in usages)

    tool_results = [f for f in frames if f.get("type") == "tool_result"]
    assert tool_results, "expected a tool_result frame"
    for tr in tool_results:
        assert isinstance(tr["duration_ms"], int) and tr["duration_ms"] >= 0

    # --- Mention injection: the resolved absolute path reached the LLM prompt. ---
    user_msgs = [
        m["content"]
        for req in mock_llm.requests_received
        for m in req["messages"]
        if m["role"] == "user"
    ]
    assert any(str(folder) in c for c in user_msgs), (
        f"mount path not injected into prompt: {user_msgs!r}"
    )

    # --- Persistence: last_answer + tokens land on the session row; the stored
    # transcript keeps the clean input, with no path leaked. ---
    async with live_client(base, token) as http:
        detail = None
        for _ in range(30):
            detail = (await http.get(f"/sessions/{session_id}")).json()
            if detail.get("last_answer") == "answer recorded":
                break
            await asyncio.sleep(0.05)
        assert detail["last_answer"] == "answer recorded"
        assert detail["tokens"] == final["tokens_spent"]

        msgs = (await http.get(f"/sessions/{session_id}/messages")).json()["messages"]
    user_texts = [m["text"] for m in msgs if m["role"] == "user"]
    assert user_texts == ["summarise @proj"]
    assert all(str(folder) not in t for t in user_texts)
    assistant = next(m for m in msgs if m["role"] == "assistant")
    assert assistant["durationMs"] == final["duration_ms"]
    assert isinstance(assistant["completedAt"], int)


async def test_workspace_block_includes_session_mount_roots(
    ws_creds, ws_service, mock_llm, tmp_path,
) -> None:
    """Mounted session roots are listed in the dynamic <Workspace> block so the
    model can see mounted directories/files even when the current turn does not
    @-mention them."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)

    folder = tmp_path / "proj"
    folder.mkdir()
    async with live_client(base, token) as http:
        resp = await http.post(
            f"/sessions/{session_id}/mounts", json={"path": str(folder)}
        )
        assert resp.status_code == 201

    mock_llm.enqueue_text("mount roots visible")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        await _chat(ws, session_id, "what is mounted?")

    system_prompt = mock_llm.requests_received[-1]["messages"][0]["content"]
    workspace_lines = system_prompt.splitlines()
    working_dir_idx = next(
        i for i, line in enumerate(workspace_lines)
        if line.startswith("- Session work directory (default for relative file-tool paths): ")
    )
    working_dir = json.loads(
        workspace_lines[working_dir_idx].removeprefix(
            "- Session work directory (default for relative file-tool paths): "
        )
    )
    mounted_line = workspace_lines[working_dir_idx + 1]

    prefix = "- Mounted directories / files: "
    assert mounted_line.startswith(prefix)
    mount_roots = json.loads(mounted_line.removeprefix(prefix))
    assert str(folder) in mount_roots
    assert working_dir not in mount_roots


async def test_session_mount_roots_allow_tool_reads_without_remention(
    ws_creds, ws_service, mock_llm, tmp_path,
) -> None:
    """A path mounted on the session seeds the permission system even when the
    current chat turn does not @-mention it, so a read_file inside that mount runs
    without parking for a permission approval."""
    _, _, base = ws_service
    ws_url, token = ws_creds
    session_id = await _create_session(base, token)

    folder = tmp_path / "proj"
    folder.mkdir()
    note = folder / "note.txt"
    note.write_text("mounted hello", encoding="utf-8")

    async with live_client(base, token) as http:
        resp = await http.post(f"/sessions/{session_id}/mounts", json={"path": str(folder)})
        assert resp.status_code == 201

    mock_llm.enqueue_tool_calls({"name": "read_file", "arguments": {"file_path": str(note)}})
    mock_llm.enqueue_text("read complete")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, session_id)
        frames = await _chat(ws, session_id, "read the mounted note")

    assert "permission_request" not in [f.get("type") for f in frames]

    async with live_client(base, token) as http:
        msgs = (await http.get(f"/sessions/{session_id}/messages")).json()["messages"]
    reads = [tc for m in msgs for tc in m.get("toolCalls", []) if tc["name"] == "read_file"]
    assert reads, "read_file did not run"
    assert reads[-1]["result"]["isError"] is False
    assert "mounted hello" in json.dumps(reads[-1]["result"], ensure_ascii=False)
