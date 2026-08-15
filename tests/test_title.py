"""Session title — model-generated, persisted, and published by Invocation.

End-to-end: the first turn of a fresh session emits a ``title`` frame and persists
the title. Generation remains an Agent capability; persistence and event publication
belong to the Invocation attempt's completion path — run OFF the turn's critical
path, so the ``title`` frame arrives asynchronously AFTER ``final`` (the reply is
not blocked by the title-generation LLM call).
"""

from __future__ import annotations

import json

import websockets

from .conftest import live_client
from .test_ws import _create_session, _drain_until, _hello, _subscribe


async def test_first_turn_streams_and_persists_a_title(ws_creds, ws_service, mock_llm) -> None:
    """The first turn of a fresh session emits a ``title`` frame carrying the model's
    title (asynchronously, after ``final``), and that title is persisted (visible over
    REST). The title lands via the broker after the turn finalizes."""
    _, _, base = ws_service
    ws_url, token = ws_creds

    sid = await _create_session(base, token)
    mock_llm.set_title("目录文件统计工具")
    mock_llm.enqueue_text("done")

    async with websockets.connect(ws_url, proxy=None) as ws:
        await _hello(ws, token)
        await _subscribe(ws, sid)
        await ws.send(json.dumps({"type": "chat", "session_id": sid, "input": "统计文件"}))
        # Title is generated off the critical path → its frame arrives AFTER `final`;
        # drain until the `title` frame itself (rename happens before the emit, so the
        # REST persistence check below is race-free).
        frames = await _drain_until(ws, lambda f: f.get("type") == "title", timeout=10.0)

    titles = [f for f in frames if f.get("type") == "title"]
    assert titles, f"expected a title frame; got {[f.get('type') for f in frames]}"
    assert titles[0]["title"] == "目录文件统计工具"

    # Persisted: the session list shows the model title, not the raw first message.
    async with live_client(base, token) as http:
        listing = (await http.get("/sessions")).json()
    titled = next(s for s in listing if s["id"] == sid)
    assert titled["title"] == "目录文件统计工具"
