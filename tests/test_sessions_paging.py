"""GET /sessions/{id}/messages cursor pagination (before_ordinal + limit).

Contract under test (``SessionMessagesHandler.get``): no params = full transcript
(back-compat); `limit` returns the newest page; `next_before` walks older
pages; `has_more` signals remaining history; only the tail page carries
pending_request / thinking_mode projections.
"""
import httpx

from src.amphi_store import SessionRepository, UserInput
from tests._session_turns import persist_session_turn


async def _append_turn(session_id: str, text: str, answer: str) -> None:
    record = await SessionRepository().load(session_id, "local")
    assert record is not None
    await persist_session_turn(
        record, UserInput(text=text), {}, last_answer=answer,
    )


async def _seed(client: httpx.AsyncClient, count: int) -> str:
    created = await client.post("/sessions", json={})
    session_id = created.json()["id"]
    for index in range(count):
        await _append_turn(session_id, f"第 {index} 问", f"第 {index} 答")
    return session_id


async def test_no_params_returns_full_transcript(client: httpx.AsyncClient) -> None:
    session_id = await _seed(client, 5)
    body = (await client.get(f"/sessions/{session_id}/messages")).json()
    assert len(body["messages"]) == 10  # user + ai per turn
    assert body["has_more"] is False


async def test_limit_returns_newest_page_and_cursor_walks_back(
    client: httpx.AsyncClient,
) -> None:
    session_id = await _seed(client, 7)
    page1 = (await client.get(
        f"/sessions/{session_id}/messages", params={"limit": 3},
    )).json()
    texts1 = [m["text"] for m in page1["messages"] if m["role"] == "user"]
    assert texts1 == ["第 4 问", "第 5 问", "第 6 问"]
    assert page1["has_more"] is True

    page2 = (await client.get(
        f"/sessions/{session_id}/messages",
        params={"limit": 3, "before_ordinal": page1["next_before"]},
    )).json()
    texts2 = [m["text"] for m in page2["messages"] if m["role"] == "user"]
    assert texts2 == ["第 1 问", "第 2 问", "第 3 问"]
    assert page2["has_more"] is True
    # Older pages never carry trailing-turn projections.
    assert page2["pending_request"] is None
    assert page2["thinking_mode"] is None

    page3 = (await client.get(
        f"/sessions/{session_id}/messages",
        params={"limit": 3, "before_ordinal": page2["next_before"]},
    )).json()
    texts3 = [m["text"] for m in page3["messages"] if m["role"] == "user"]
    assert texts3 == ["第 0 问"]
    assert page3["has_more"] is False


async def test_cursor_is_stable_while_new_turns_append(
    client: httpx.AsyncClient,
) -> None:
    session_id = await _seed(client, 6)
    page1 = (await client.get(
        f"/sessions/{session_id}/messages", params={"limit": 3},
    )).json()
    # A new turn lands between page fetches — the older page must not shift.
    await _append_turn(session_id, "插队问", "插队答")
    page2 = (await client.get(
        f"/sessions/{session_id}/messages",
        params={"limit": 3, "before_ordinal": page1["next_before"]},
    )).json()
    texts2 = [m["text"] for m in page2["messages"] if m["role"] == "user"]
    assert texts2 == ["第 0 问", "第 1 问", "第 2 问"]
