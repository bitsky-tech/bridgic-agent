import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_service.runtime._debug_runs import DebugModelRuns
from src.amphi_store import DebugModelRunRepository, SessionRepository, SessionTurnRecord, SessionTurnRepository, TurnStatus, UserInput, UserRepository
from src.amphi_store._debug_run import debug_fingerprint


@pytest.fixture
async def experiment(service_client, service_app, monkeypatch):
    created = await service_client.post("/sessions", json={"model": "test-model"})
    session_id = created.json()["id"]
    await UserRepository().set_credentials("local", api_key="test-key", base_url=None)
    raw = {"model_id": "historical-model", "think_scope": {"mode": "normal", "stage": "main"},
           "think_result": {"step_content": "Historical response", "tool_calls": []}}
    turn = SessionTurnRecord(id="source-turn", user_id="local", session_id=session_id, session_ordinal=0,
                             user_input=UserInput(text="Original input"), status=TurnStatus.COMPLETED, ota_records=[raw])
    async with SessionTurnRepository()._session() as db:
        db.add(turn)
        await db.commit()
    llm = AsyncMock()
    llm.stream_turn.return_value = StreamResult(content="Experiment output", tool_calls=[{"name": "do_not_execute", "arguments": {}}],
                                              usage={"input_tokens": 100, "output_tokens": 5, "input_tokens_details": {"cached_tokens": 80}})
    monkeypatch.setattr(service_app.state.llms, "resolve", AsyncMock(return_value=llm))
    body = {"clientRequestId": "request-1", "source": {"turnId": turn.id, "roundIndex": 0, "mode": "normal", "stage": "main", "revision": debug_fingerprint(raw)},
            "request": {"model": "historical-model", "providerId": None, "protocol": "openai", "messages": [{"role": "user", "content": "Edited prompt"}],
                        "tools": [{"name": "do_not_execute", "description": "A schema only", "parameters": {"type": "object"}}], "extraBody": {"temperature": 0.3}}}
    return session_id, body, llm


async def test_debug_run_is_durable_idempotent_and_never_changes_turns(service_client, service_app, experiment):
    session_id, body, llm = experiment
    path = f"/api/debug/sessions/{session_id}"
    before = (await SessionTurnRepository().get("local", "source-turn")).model_dump(mode="json")
    response = await service_client.post(f"{path}/llm-runs", json=body)
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    await service_app.state.debug_runs.shutdown()
    completed = (await service_client.get(f"{path}/runs/{run_id}")).json()
    assert completed["status"] == "succeeded"
    assert completed["toolCalls"][0]["name"] == "do_not_execute"
    assert completed["usage"]["input_tokens_details"]["cached_tokens"] == 80
    assert completed["durationMs"] >= 0
    assert completed["request"]["messages"][0]["blocks"][0]["text"] == "Edited prompt"
    assert (await service_client.post(f"{path}/llm-runs", json=body)).json()["id"] == run_id
    assert llm.stream_turn.await_count == 1
    assert llm.stream_turn.call_args.args[0][0].content == "Edited prompt"
    assert llm.stream_turn.call_args.kwargs["extra_body"] == {"temperature": 0.3}
    changed = deepcopy(body)
    changed["request"]["model"] = "other-model"
    assert (await service_client.post(f"{path}/llm-runs", json=changed)).status_code == 409
    reloaded = await DebugModelRuns().get("local", session_id, run_id)
    assert reloaded == completed
    listed = (await service_client.get(f"{path}/llm-runs", params={"turnId": "source-turn", "roundIndex": 0})).json()
    assert [item["id"] for item in listed] == [run_id]
    assert (await SessionTurnRepository().get("local", "source-turn")).model_dump(mode="json") == before
    assert len(await SessionTurnRepository().list_conversation("local", session_id)) == 1


async def test_stream_cancellation_retains_partial_output_and_run_ownership(service_client, service_app, experiment):
    session_id, body, llm = experiment
    started = asyncio.Event()

    async def stream(messages, tools, *, publish, extra_body):
        publish("reasoning", text="Partial reasoning")
        publish("token", text="Partial output")
        started.set()
        await asyncio.Event().wait()

    llm.stream_turn.side_effect = stream
    path = f"/api/debug/sessions/{session_id}"
    run = (await service_client.post(f"{path}/llm-runs", json=body)).json()
    await started.wait()
    foreign = (await service_client.post("/sessions", json={})).json()["id"]
    for suffix in ("", "/events"):
        assert (await service_client.get(f"/api/debug/sessions/{foreign}/runs/{run['id']}{suffix}")).status_code == 404
    assert (await service_client.post(f"/api/debug/sessions/{foreign}/runs/{run['id']}/cancel")).status_code == 404
    assert (await service_client.post(f"{path}/runs/{run['id']}/cancel", headers={"Authorization": "Bearer wrong"})).status_code == 401
    another = {**body, "clientRequestId": "other"}
    assert (await service_client.post(f"{path}/llm-runs", json=another)).status_code == 409
    cancelled = (await service_client.post(f"{path}/runs/{run['id']}/cancel")).json()
    assert cancelled["status"] == "cancelled"
    assert cancelled["content"] == "Partial output"
    assert cancelled["reasoning"] == "Partial reasoning"
    events = await service_client.get(f"{path}/runs/{run['id']}/events")
    assert events.status_code == 200
    import json
    assert json.loads(events.text)["status"] == "cancelled"
    assert "request" not in json.loads(events.text)


@pytest.mark.parametrize("mutation,expected", [
    ({"source": {"turnId": "other"}}, 404),
    ({"source": {"roundIndex": 9}}, 422),
    ({"source": {"stage": "other"}}, 422),
    ({"source": {"revision": "old-revision"}}, 409),
    ({"request": {"protocol": "anthropic"}}, 409),
    ({"request": {"extraBody": {"messages": []}}}, 422),
    ({"request": {"messages": [{"role": "user", "content": [], "blocks": []}]}}, 422),
])
async def test_invalid_experiments_never_call_model(service_client, experiment, mutation, expected):
    session_id, body, llm = experiment
    for key, patch in mutation.items():
        body[key].update(patch)
    response = await service_client.post(f"/api/debug/sessions/{session_id}/llm-runs", json=body)
    assert response.status_code == expected, response.text
    llm.stream_turn.assert_not_awaited()


async def test_failed_retry_preserves_failure_and_latest_attempt_output(service_client, service_app, experiment):
    session_id, body, llm = experiment

    async def stream(messages, tools, *, publish, extra_body):
        publish("token", text="Discarded attempt")
        publish("model_retry", attempt=1, active=True)
        publish("token", text="Second attempt")
        raise RuntimeError("Provider test failure")

    llm.stream_turn.side_effect = stream
    path = f"/api/debug/sessions/{session_id}"
    run = (await service_client.post(f"{path}/llm-runs", json=body)).json()
    await service_app.state.debug_runs.shutdown()
    failed = (await service_client.get(f"{path}/runs/{run['id']}")).json()
    assert failed["status"] == "failed"
    assert failed["error"] == "Provider test failure"
    assert failed["content"] == "Second attempt"
    assert len(failed["retries"]) == 1


async def test_restart_marks_unfinished_experiment_interrupted(service_client, service_app, experiment):
    session_id, body, llm = experiment
    run = (await service_client.post(f"/api/debug/sessions/{session_id}/llm-runs", json=body)).json()
    await service_app.state.debug_runs.shutdown()
    repo = DebugModelRunRepository()
    row = await repo.get("local", session_id, run["id"])
    row.status = "running"
    row.snapshot = {**row.snapshot, "status": "running"}
    await repo.save(row)
    restored = await DebugModelRuns().get("local", session_id, run["id"])
    assert restored["status"] == "interrupted"
    llm.stream_turn.assert_awaited_once()


async def test_deleting_session_cancels_experiment_and_removes_its_record(service_client, service_app, experiment):
    session_id, body, llm = experiment

    async def stream(messages, tools, *, publish, extra_body):
        publish("token", text="Partial output")
        await asyncio.Event().wait()

    llm.stream_turn.side_effect = stream
    path = f"/api/debug/sessions/{session_id}"
    run = (await service_client.post(f"{path}/llm-runs", json=body)).json()
    assert run["status"] == "running"
    deleted = await service_client.delete(f"/sessions/{session_id}")
    assert deleted.status_code == 204, deleted.text
    assert await DebugModelRunRepository().get("local", session_id, run["id"]) is None
    assert not service_app.state.debug_runs._tasks


async def test_read_during_creation_waits_for_live_registration(service_client, service_app, experiment, monkeypatch):
    session_id, body, llm = experiment
    manager = service_app.state.debug_runs
    saved, resume_save, reading = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_save, original_get = manager._repo.save, manager.get

    async def save(row):
        await original_save(row)
        if row.status == "running":
            saved.set()
            await resume_save.wait()

    async def get(user_id, session_id, run_id):
        reading.set()
        return await original_get(user_id, session_id, run_id)

    async def stream(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(manager._repo, "save", save)
    monkeypatch.setattr(manager, "get", get)
    llm.stream_turn.side_effect = stream
    path = f"/api/debug/sessions/{session_id}"
    submission = asyncio.create_task(service_client.post(f"{path}/llm-runs", json=body))
    listing = None
    try:
        await asyncio.wait_for(saved.wait(), 5)
        listing = asyncio.create_task(service_client.get(f"{path}/llm-runs", params={"turnId": "source-turn", "roundIndex": 0}))
        await asyncio.wait_for(reading.wait(), 5)
        resume_save.set()
        response = await asyncio.wait_for(submission, 5)
        listed = await asyncio.wait_for(listing, 5)
        assert response.status_code == 202
        assert listed.status_code == 200
        assert listed.json()[0]["status"] == "running"
        assert listed.json()[0]["error"] is None
        row = await DebugModelRunRepository().get("local", session_id, response.json()["id"])
        assert row.status == "running"
        llm.stream_turn.assert_awaited_once()
    finally:
        resume_save.set()
        await asyncio.gather(submission, *([listing] if listing else []), return_exceptions=True)
        await manager.shutdown()


@pytest.mark.parametrize("delete_parent", [False, True])
async def test_delete_during_model_resolution_rejects_late_start(
    service_client, service_app, experiment, monkeypatch, delete_parent,
):
    session_id, body, llm = experiment
    deletion_id = session_id
    if delete_parent:
        parent = (await service_client.post("/sessions", json={})).json()
        repo = SessionRepository()
        session = await repo.load(session_id, "local")
        session.parent_session_id = parent["id"]
        await repo.save(session)
        deletion_id = parent["id"]
    resolving, resume_resolve = asyncio.Event(), asyncio.Event()

    async def resolve(*args, **kwargs):
        resolving.set()
        await resume_resolve.wait()
        return llm

    monkeypatch.setattr(service_app.state.llms, "resolve", resolve)
    path = f"/api/debug/sessions/{session_id}"
    submission = asyncio.create_task(service_client.post(f"{path}/llm-runs", json=body))
    try:
        await asyncio.wait_for(resolving.wait(), 5)
        deleted = await service_client.delete(f"/sessions/{deletion_id}")
        assert deleted.status_code == 204
    finally:
        resume_resolve.set()
        response = await asyncio.wait_for(submission, 5)
    assert response.status_code == 409
    assert response.json()["detail"] == "The Session is no longer available"
    llm.stream_turn.assert_not_awaited()
    assert await DebugModelRunRepository().list_round("local", session_id, "source-turn", 0) == []
    assert not service_app.state.debug_runs._tasks


async def test_delete_during_creation_waits_and_removes_the_started_run(service_client, service_app, experiment, monkeypatch):
    session_id, body, llm = experiment
    manager = service_app.state.debug_runs
    saved, resume_save, deleting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_save, original_deletion = manager._repo.save, manager.deleting_session_tree

    async def save(row):
        await original_save(row)
        if row.status == "running":
            saved.set()
            await resume_save.wait()

    @asynccontextmanager
    async def deletion(user_id, session_id):
        deleting.set()
        async with original_deletion(user_id, session_id) as tree:
            yield tree

    async def stream(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(manager._repo, "save", save)
    monkeypatch.setattr(manager, "deleting_session_tree", deletion)
    llm.stream_turn.side_effect = stream
    submission = asyncio.create_task(service_client.post(f"/api/debug/sessions/{session_id}/llm-runs", json=body))
    removal = None
    try:
        await asyncio.wait_for(saved.wait(), 5)
        removal = asyncio.create_task(service_client.delete(f"/sessions/{session_id}"))
        await asyncio.wait_for(deleting.wait(), 5)
        resume_save.set()
        response = await asyncio.wait_for(submission, 5)
        deleted = await asyncio.wait_for(removal, 5)
        assert response.status_code == 202
        assert deleted.status_code == 204
        assert await DebugModelRunRepository().get("local", session_id, response.json()["id"]) is None
        assert not manager._tasks
        assert not manager._live
    finally:
        resume_save.set()
        await asyncio.gather(submission, *([removal] if removal else []), return_exceptions=True)
        await manager.shutdown()


async def test_listing_omits_runs_deleted_during_the_read(service_client, service_app, experiment, monkeypatch):
    session_id, body, _ = experiment
    path = f"/api/debug/sessions/{session_id}"
    assert (await service_client.post(f"{path}/llm-runs", json=body)).status_code == 202
    await service_app.state.debug_runs.shutdown()
    listed, resume_listing = asyncio.Event(), asyncio.Event()
    original_list = DebugModelRunRepository.list_round

    async def list_round(repo, *args):
        rows = await original_list(repo, *args)
        listed.set()
        await resume_listing.wait()
        return rows

    monkeypatch.setattr(DebugModelRunRepository, "list_round", list_round)
    listing = asyncio.create_task(service_client.get(f"{path}/llm-runs", params={"turnId": "source-turn", "roundIndex": 0}))
    try:
        await asyncio.wait_for(listed.wait(), 5)
        assert (await service_client.delete(f"/sessions/{session_id}")).status_code == 204
    finally:
        resume_listing.set()
        response = await asyncio.wait_for(listing, 5)
    assert response.status_code == 200
    assert response.json() == []
