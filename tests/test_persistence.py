"""Cross-restart persistence — proves the DB really is the source of truth.

Each test constructs **two** :class:`ServiceApp` instances pointing at
the same on-disk SQLite path, runs side A → close → reopens as side B,
and asserts the state written by A is still visible to B.

This proves that the database, rather than any Service process-local cache, is
the source of truth: if writes did not reach SQLite, the second process could
not reconstruct them.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx

from src.amphi_service._app import ServiceApp
from src.amphi_store import UserRepository


# ----------------------------------------------------------------------
# Helper: build an ASGI client against a service app sharing a given
# DB path. Each ``async with`` block represents one simulated
# "service process" — lifespan runs (init_schema + seed), tests do
# their thing, and on block exit the DB engine is disposed.
# ----------------------------------------------------------------------
@asynccontextmanager
async def _service_client(db_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Spin up a ServiceApp pointing at ``db_path`` (via env var)."""
    # ``BRIDGIC_AGENT_STATE_DB`` redirects the Repository connection;
    # the ``temp_db_path`` fixture sets it for tests that just need
    # a tmp DB, but this helper is called twice with the SAME path
    # to simulate restart, so we set it ourselves rather than depend
    # on the fixture's setattr scope.
    prev = os.environ.get("BRIDGIC_AGENT_STATE_DB")
    os.environ["BRIDGIC_AGENT_STATE_DB"] = str(db_path)
    try:
        app = ServiceApp(bind_host=None, bind_port=None)
        async with app.app.router.lifespan_context(app.app):
            user = await UserRepository().load("local")
            if user is not None and not user.current_model:
                await UserRepository().set_model("local", "mock-model")
            # Each ServiceApp generates its own token, so the header has to be
            # rebuilt per "process" — a restart invalidates the previous one.
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app),
                base_url="http://127.0.0.1",
                headers={
                    "Authorization": f"Bearer {app.state.auth.current_token}"
                },
            ) as c:
                yield c
    finally:
        if prev is None:
            os.environ.pop("BRIDGIC_AGENT_STATE_DB", None)
        else:
            os.environ["BRIDGIC_AGENT_STATE_DB"] = prev


# ----------------------------------------------------------------------
# Sessions + credentials — both ride the same User/Session DB writes, so one
# A/B process pair proves the whole round trip survives a restart.
# ----------------------------------------------------------------------
async def test_session_create_and_delete_persist_across_restart(
    temp_db_path: Path,
) -> None:
    """Process A creates a session (plus a create+delete pair) and provider;
    process B on the same DB loads/lists the session, 404s the deleted one, and
    reads back the active provider mirror — proving these writes hit the DB."""
    # Process A: create one, create+delete another, and configure a provider.
    async with _service_client(temp_db_path) as client_a:
        created = (
            await client_a.post("/sessions", json={"workspace_root": "/some/path"})
        ).json()
        session_id = created["id"]
        workspace_root = created["workspace_root"]

        doomed_id = (await client_a.post("/sessions", json={})).json()["id"]
        deletion = await client_a.delete(f"/sessions/{doomed_id}")
        assert deletion.status_code == 204

        added = await client_a.post(
            "/me/providers",
            json={
                "provider_id": "persist-provider",
                "auth_mode": "api_key",
                "api_key": "sk-persist-me",
                "base_url": "https://x.example/v1",
                "protocol": "openai",
                "models": ["mock-model"],
            },
        )
        assert added.status_code == 201
        switched = await client_a.post(
            "/me/active-model",
            json={"provider_id": "persist-provider", "model": "mock-model"},
        )
        assert switched.status_code == 200
    # Process B: same DB path, fresh ServiceApp and process-local caches.
    async with _service_client(temp_db_path) as client_b:
        response = await client_b.get(f"/sessions/{session_id}")
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == session_id
        assert body["workspace_root"] == workspace_root
        assert Path(workspace_root).name == session_id
        # The list endpoint must surface it too (DB-backed, not just cache).
        listing = (await client_b.get("/sessions")).json()
        assert any(s["id"] == session_id for s in listing)
        # The deleted session stays gone after restart (row purged, not cached).
        assert (await client_b.get(f"/sessions/{doomed_id}")).status_code == 404
        # The active provider A wrote is restored into B's runtime mirror.
        creds = await client_b.get("/me/credentials")
        assert creds.status_code == 200
        assert creds.json() == {
            "api_key_set": True,
            "base_url": "https://x.example/v1",
        }


# ----------------------------------------------------------------------
# SessionTurnRepository — normalized history + Session status projection,
# driven directly against a tmp DB (one connect/close per test).
# ----------------------------------------------------------------------
async def test_session_repository_lifecycle(temp_db_path: Path) -> None:
    """SessionRepository through its public surface in one pass.

    * One top-level Turn hydrates the conversation without a Session snapshot.
    * ``completed`` and ``awaiting`` are mutually exclusive Session projections.
    * Read and answered receipts only move their matching status to ``finish``.
    """
    from src.amphi_store import (
        Repository,
        SessionRecord,
        SessionRepository,
        SubAgentMode,
        SessionStatus,
        SessionTurnRepository,
        UserInput,
    )
    from ._session_turns import persist_session_turn

    Repository.connect(temp_db_path)
    await Repository.init_schema()
    try:
        repo = SessionRepository()

        # --- The top-level SessionTurn owns both input and Agent context.
        record = SessionRecord(id="s", user_id="u", workspace_root="/tmp")
        await repo.save(record)
        conversation = await persist_session_turn(
            record,
            UserInput(text="goal"),
            {"ota_record": [{"think_result": {"step_content": "done", "tool_calls": []}}]},
            status=SessionStatus.COMPLETED,
            model="m",
            last_answer="done",
        )
        assert len(conversation) == 1
        assert conversation[0].user_id == record.user_id
        assert conversation[0].user_input.text == "goal"

        loaded = await repo.load("s", "u")
        assert loaded is not None
        hydrated = await SessionTurnRepository().list_conversation("u", loaded.id)
        assert len(hydrated) == 1
        assert await SessionTurnRepository().get("other", hydrated[0].id) is None
        assert await SessionTurnRepository().list_conversation("other", loaded.id) == []
        assert loaded.last_answer == "done"
        assert loaded.status is SessionStatus.COMPLETED

        # --- Awaiting is not also unread; reading it does not answer it.
        await repo.save(SessionRecord(
            id="p", user_id="u", workspace_root="/tmp",
            status=SessionStatus.AWAITING,
        ))

        assert await repo.mark_read("p", "u") is True
        row = await repo.load("p", "u")
        assert row.status is SessionStatus.AWAITING

        assert await repo.mark_interaction_handled("p", "u") is True
        row = await repo.load("p", "u")
        assert row.status is SessionStatus.FINISH

        # idempotent no-op still True; unknown / unowned id → False.
        assert await repo.mark_interaction_handled("p", "u") is True
        assert await repo.mark_interaction_handled("nope", "u") is False
        assert await repo.mark_interaction_handled("p", "other") is False
    finally:
        await Repository.close()


async def test_session_turn_history_isolated_from_child_sessions(
    connected_repo,
) -> None:
    """Each Session orders only its own Turns and summary."""
    from src.amphi_store import (
        SessionTurnRepository,
        SubAgentMode,
        TurnStatus,
        SessionRecord,
        SessionRepository,
        UserInput,
    )

    record = SessionRecord(
        id="ordered-session",
        user_id="u",
        workspace_root="/tmp",
    )
    await SessionRepository().save(record)
    turns = SessionTurnRepository()

    async def append(session_id: str, text: str, expected_tail_id, input_tokens: int, output_tokens: int) -> str:
        turn = await turns.append_result(
            "u",
            session_id=session_id,
            expected_tail_id=expected_tail_id,
            user_input=UserInput(text=text),
            ota_records=[],
            agent_state={},
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer=None,
            error=None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        return turn.id

    first_id = await append(record.id, "first", None, 1, 2)
    await append(record.id, "second", first_id, 7, 3)
    child = await SessionRepository().create_child(
        "u",
        parent_session_id=record.id,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    await append(child.id, "nested", None, 0, 0)

    loaded = await SessionRepository().load(record.id, "u")
    assert loaded is not None
    conversation = await turns.list_conversation("u", loaded.id)
    assert [turn.user_input.text for turn in conversation] == ["first", "second"]
    child_conversation = await turns.list_conversation("u", child.id)
    assert [turn.user_input.text for turn in child_conversation] == ["nested"]
    summary = await turns.load_summary(loaded)
    assert summary.first_user_input == "first"
    assert summary.tokens == 13
