import asyncio
import io
import threading
import zipfile
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from src.amphi_agent._workflow_run import (
    RunWorkflow,
    WorkflowRun,
    WorkflowRunLibrary,
)
from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
from src.amphi_agent._workspace import Workspace
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import (
    SessionRepository,
    SubAgentMode,
    UserInput,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


async def _create_workflow(
    client: httpx.AsyncClient,
    name: str,
    *,
    validation: bool = False,
) -> dict:
    validate = (
        "# Validate\n\nConfirm the requested result exists.\n"
        if validation
        else "---\nvalidation: none\n---\n"
    )
    session_response = await client.post("/sessions", json={})
    assert session_response.status_code == 201
    session = session_response.json()
    workspace = Workspace(session["id"], session_root=Path(session["workspace_root"]))
    build = await workspace.prepare_build_space("create", stage="verify")
    (build.root / "task.md").write_text(
        "# Task\n\nProduce the requested result.\n",
        encoding="utf-8",
    )
    (build.root / "explore.md").write_text(
        "# Explore\n\nUse the pinned Workflow package.\n",
        encoding="utf-8",
    )
    (build.root / "verify.md").write_text(
        "# Verify\n\nThe package is ready to run.\n",
        encoding="utf-8",
    )
    (build.root / "workflow").mkdir()
    ((build.root / "workflow") / "WORKFLOW.md").write_text(
        "---\n"
        f"name: {name.lower().replace(' ', '-')}\n"
        f"description: Exercise {name}.\n"
        "---\n\n"
        "# Execute\n\nProduce the requested result.\n",
        encoding="utf-8",
    )
    ((build.root / "workflow") / "VALIDATE.md").write_text(validate, encoding="utf-8")
    library = await WorkflowLibrary(LOCAL_USER_ID).load()
    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id=session["id"],
        source_turn_id=f"test-{uuid4().hex}",
        name=name,
        description=f"{name} fixture",
    )
    assert build.is_available
    return {
        "id": saved.workflow_id,
        "name": saved.name,
        "root": saved.root,
    }


def _active_result(workflow: dict, result_id: str) -> RunWorkflow:
    managed_root = WorkflowRun.managed_root(workflow["id"], result_id)
    active_root = managed_root.parent / f".{result_id}.active"
    active_root.mkdir(parents=True)
    return RunWorkflow(active_root).prepare(
        "create",
        source_root=Path(workflow["root"]),
    )


async def _terminal_result(
    *,
    result_id: str,
    workflow: dict,
    session_id: str,
    source_root: Path,
    workflow_input: UserInput,
    status: WorkflowRunStatus = WorkflowRunStatus.COMPLETED,
    validation_status: WorkflowValidationStatus = WorkflowValidationStatus.NOT_REQUIRED,
):
    return await WorkflowRunLibrary(LOCAL_USER_ID).publish(
        source_root,
        result_id=result_id,
        workflow_id=workflow["id"],
        workflow_name=workflow["name"],
        source_session_id=session_id,
        workflow_input=workflow_input,
        status=status,
        validation_status=validation_status,
    )
    return row


async def test_active_run_is_workspace_only_and_publishes_after_source_deletion(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Workspace Only")
    session = (await client.post("/sessions", json={})).json()
    workspace = Workspace(session["id"], session_root=Path(session["workspace_root"]))
    workflows = await WorkflowLibrary(LOCAL_USER_ID).load()
    workflow_runs = await WorkflowRunLibrary(LOCAL_USER_ID).load()
    workflow_input = UserInput(text="/Workspace Only weekly")

    async with workflows.guarded_source(workflow["id"]) as saved:
        await workflow_runs.require_completed_references(workflow_input)
        space = await workspace.prepare_run_workflow_space(
            "create",
            initial_state={
                "workflow_id": workflow["id"],
                "generation": uuid4().hex,
                "workflow_name": workflow["name"],
                "workflow_input": workflow_input.model_dump(mode="json"),
                "stage": "execute",
                "step_index": 0,
            },
            populate=lambda root: RunWorkflow(root).prepare(
                "create",
                source_root=saved.root,
            ),
        )
    active_run = RunWorkflow(space.root).prepare("resume")
    source = WorkflowPackage(
        active_run.source_dir,
        workflow_id=space.workflow_id,
        name=space.workflow_name,
    )

    assert [step.title for step in source.execution_steps] == ["Execute"]
    assert workspace.has_run_workflow
    assert (await client.get("/workflow-runs")).json() == []
    assert await WorkflowRunRepository().list_for_user(LOCAL_USER_ID) == []

    assert (await client.delete(f"/workflows/{workflow['id']}")).status_code == 204
    assert (await client.get(f"/workflows/{workflow['id']}")).status_code == 404
    reopened_space = await workspace.prepare_run_workflow_space("resume")
    reopened_run = RunWorkflow(reopened_space.root).prepare("resume")
    reopened = WorkflowPackage(
        reopened_run.source_dir,
        workflow_id=reopened_space.workflow_id,
        name=reopened_space.workflow_name,
    )
    assert [step.title for step in reopened.execution_steps] == ["Execute"]

    run = RunWorkflow(space.root).prepare("resume")
    (run.result_dir / "report.md").write_text("# Published\n", encoding="utf-8")
    step = reopened.execution_steps[0]
    run.record_step(
        stage=space.stage,
        step_number=step.index,
        step_title=step.title,
        status="success",
        summary="Result produced.",
    )
    space.checkpoint_cursor(
        expected_workflow_id=space.workflow_id,
        expected_generation=space.generation,
        expected_stage=space.stage,
        expected_step_index=space.step_index,
        stage=space.stage,
        step_index=space.step_index + 1,
    )
    published = await workflow_runs.publish(
        run.root,
        result_id=space.generation,
        workflow_id=space.workflow_id,
        workflow_name=space.workflow_name,
        source_session_id=session["id"],
        workflow_input=space.workflow_input,
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    assert space.step_index == 1
    assert workspace.has_run_workflow
    detail = (await client.get(f"/workflow-runs/{published.run_id}")).json()
    assert detail["id"] == published.run_id
    assert detail["workflow_name"] == workflow["name"]
    assert detail["workflow_input"]["text"] == workflow_input.text
    assert [file["path"] for file in detail["files"]] == ["result/report.md"]

    await workspace.discard_run_workflow()
    assert not workspace.has_run_workflow
    assert published.is_available


async def test_session_run_snapshot_is_read_only_and_reports_root_owner(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Read Only Snapshot")
    session = (await client.post("/sessions", json={})).json()
    workspace = Workspace(session["id"], session_root=Path(session["workspace_root"]))
    workflows = await WorkflowLibrary(LOCAL_USER_ID).load()
    workflow_input = UserInput(text="run read-only snapshot")

    async with workflows.guarded_source(workflow["id"]) as saved:
        space = await workspace.prepare_run_workflow_space(
            "create",
            initial_state={
                "workflow_id": workflow["id"],
                "generation": uuid4().hex,
                "workflow_name": workflow["name"],
                "workflow_input": workflow_input.model_dump(mode="json"),
                "stage": "execute",
                "step_index": 0,
            },
            populate=lambda root: RunWorkflow(root).prepare(
                "create",
                source_root=saved.root,
            ),
        )

    staging = workspace.work_dir / ".run.stage.in-progress"
    staging.mkdir()
    marker = staging / "snapshot.tmp"
    marker.write_text("still creating\n", encoding="utf-8")

    response = await client.get(f"/sessions/{session['id']}/messages")

    assert response.status_code == 200
    assert response.json()["workflow_run"] == {
        "workflow_id": workflow["id"],
        "generation": space.generation,
        "workflow_name": workflow["name"],
        "source_session_id": session["id"],
        "phase": "execute",
        "step_index": 0,
        "execution_steps": ["Execute"],
        "validation_steps": [],
    }
    assert marker.read_text(encoding="utf-8") == "still creating\n"

    child = await SessionRepository().create_child(
        LOCAL_USER_ID,
        parent_session_id=session["id"],
        parent_call_id="snapshot-child",
        subagent_mode=SubAgentMode.BACKGROUND,
    )
    child_response = await client.get(f"/sessions/{child.id}/messages")

    assert child_response.status_code == 200
    assert child_response.json()["workflow_run"]["source_session_id"] == session["id"]
    assert marker.read_text(encoding="utf-8") == "still creating\n"


async def test_run_snapshot_and_workflow_delete_share_source_guard(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow = await _create_workflow(client, "Guarded Snapshot", validation=True)
    session = (await client.post("/sessions", json={})).json()
    workspace = Workspace(session["id"], session_root=Path(session["workspace_root"]))
    workflows = await WorkflowLibrary(LOCAL_USER_ID).load()
    workflow_runs = await WorkflowRunLibrary(LOCAL_USER_ID).load()
    prepare = workspace.prepare_run_workflow_space
    entered = threading.Event()
    release = threading.Event()

    async def delayed_prepare(operation: str, **kwargs):
        if operation == "create":
            entered.set()
        if operation == "create" and not await asyncio.to_thread(release.wait, 2):
            raise TimeoutError("test did not release the Workflow snapshot")
        return await prepare(operation, **kwargs)

    monkeypatch.setattr(workspace, "prepare_run_workflow_space", delayed_prepare)
    async def initialize_run() -> WorkflowPackage:
        async with workflows.guarded_source(workflow["id"]) as saved:
            workflow_input = UserInput(text="run it")
            await workflow_runs.require_completed_references(workflow_input)
            space = await workspace.prepare_run_workflow_space(
                "create",
                initial_state={
                    "workflow_id": workflow["id"],
                    "generation": uuid4().hex,
                    "workflow_name": workflow["name"],
                    "workflow_input": workflow_input.model_dump(mode="json"),
                    "stage": "execute",
                    "step_index": 0,
                },
                populate=lambda root: RunWorkflow(root).prepare(
                    "create",
                    source_root=saved.root,
                ),
            )
        run = RunWorkflow(space.root).prepare("resume")
        return WorkflowPackage(
            run.source_dir,
            workflow_id=space.workflow_id,
            name=space.workflow_name,
        )

    initialize = asyncio.create_task(initialize_run())
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    delete = asyncio.create_task(client.delete(f"/workflows/{workflow['id']}"))
    await asyncio.sleep(0)
    try:
        assert not delete.done()
    finally:
        release.set()

    source = await initialize
    response = await delete

    assert response.status_code == 204
    assert [step.title for step in source.execution_steps] == ["Execute"]
    assert [step.title for step in source.validation_steps] == ["Validate"]
    reopened_space = await workspace.prepare_run_workflow_space("resume")
    assert WorkflowPackage(RunWorkflow(reopened_space.root).source_dir).is_available


async def test_terminal_results_preserve_input_filters_and_user_files(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Weekly Report")
    first_session = (await client.post("/sessions", json={})).json()["id"]
    second_session = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()

    first_id = repository.new_id()
    first_space = _active_result(workflow, first_id)
    (first_space.result_dir / "report.md").write_text("# First\n", encoding="utf-8")
    (first_space.result_dir / "large.txt").write_text("x" * 200_001, encoding="utf-8")
    (first_space.root / "background" / "validation.md").write_text(
        "private validation evidence\n",
        encoding="utf-8",
    )
    await _terminal_result(
        result_id=first_id,
        workflow=workflow,
        session_id=first_session,
        source_root=first_space.root,
        workflow_input=UserInput(text="/Weekly Report first"),
        validation_status=WorkflowValidationStatus.PASSED,
    )

    second_id = repository.new_id()
    second_space = _active_result(workflow, second_id)
    second_input = UserInput(
        text=f"/Weekly Report compare @{first_id} and @paper.csv",
        blocks=[
            {
                "type": "slash",
                "id": workflow["id"],
                "label": workflow["name"],
                "resource": "workflow",
            },
            {"type": "text", "value": " compare "},
            {
                "type": "mention",
                "id": first_id,
                "label": "First report",
                "group": "WorkflowRun",
            },
            {"type": "text", "value": " and "},
            {
                "type": "mention",
                "id": "mount-paper",
                "label": "paper.csv",
                "group": "文件/文件夹",
            },
        ],
    )
    await _terminal_result(
        result_id=second_id,
        workflow=workflow,
        session_id=second_session,
        source_root=second_space.root,
        workflow_input=second_input,
    )

    rows = (await client.get(
        "/workflow-runs",
        params={"workflow_id": workflow["id"]},
    )).json()
    assert [row["id"] for row in rows] == [second_id, first_id]
    assert rows[1]["validation_status"] == "passed"
    assert all(row["created_at"].endswith("+00:00") for row in rows)
    first_rows = (await client.get(
        "/workflow-runs",
        params={"source_session_id": first_session},
    )).json()
    assert [row["id"] for row in first_rows] == [first_id]
    second_rows = (await client.get(
        "/workflow-runs",
        params={
            "source_session_id": second_session,
            "workflow_id": workflow["id"],
        },
    )).json()
    assert [row["id"] for row in second_rows] == [second_id]

    first_associated = (await client.get(
        "/workflow-runs",
        params={"session_id": first_session},
    )).json()
    assert [row["id"] for row in first_associated] == [first_id]
    assert await repository.associate_session(LOCAL_USER_ID, second_session, first_id)
    second_associated = (await client.get(
        "/workflow-runs",
        params={"session_id": second_session},
    )).json()
    assert {row["id"] for row in second_associated} == {first_id, second_id}
    second_source_only = (await client.get(
        "/workflow-runs",
        params={"source_session_id": second_session},
    )).json()
    assert [row["id"] for row in second_source_only] == [second_id]

    first_detail = (await client.get(f"/workflow-runs/{first_id}")).json()
    assert first_detail["source_session_id"] == first_session
    assert first_detail["finished_at"].endswith("+00:00")
    assert {file["path"] for file in first_detail["files"]} == {
        "result/report.md",
        "result/large.txt",
    }
    assert all("content" not in file for file in first_detail["files"])
    report = await client.get(
        f"/workflow-runs/{first_id}/file",
        params={"path": "result/report.md"},
    )
    assert report.json()["content"] == "# First\n"
    large = await client.get(
        f"/workflow-runs/{first_id}/file",
        params={"path": "result/large.txt"},
    )
    assert large.json()["truncated"] is True
    assert len(large.json()["content"]) == 200_000
    private = await client.get(
        f"/workflow-runs/{first_id}/file",
        params={"path": "background/validation.md"},
    )
    assert private.status_code == 404

    second_detail = (await client.get(f"/workflow-runs/{second_id}")).json()
    assert second_detail["workflow_input"] == second_input.model_dump(mode="json")
    assert Path(second_detail["run_dir"]).is_dir()

    assert (await client.delete(f"/workflows/{workflow['id']}")).status_code == 204
    preserved = (await client.get(f"/workflow-runs/{first_id}")).json()
    assert preserved["workflow_name"] == workflow["name"]
    workflow_runs = await WorkflowRunLibrary(LOCAL_USER_ID).load()
    assert workflow_runs.get(first_id).workflow_name == workflow["name"]


async def test_failed_terminal_result_exposes_failure_reason(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Failed Result")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    (space.result_dir / "failure.md").write_text(
        "# Workflow run failure\n\nUpstream service unavailable.\n",
        encoding="utf-8",
    )
    (space.background_work_dir / "message_idempotency_key.txt").write_text(
        "retry-safe-key\n",
        encoding="utf-8",
    )
    await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Failed Result"),
        status=WorkflowRunStatus.FAILED,
        validation_status=WorkflowValidationStatus.FAILED,
    )

    detail = (await client.get(f"/workflow-runs/{run_id}")).json()
    assert detail["status"] == "failed"
    assert [file["path"] for file in detail["files"]] == [
        "result/failure.md",
        "background/work/message_idempotency_key.txt",
    ]
    result = await client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "result/failure.md"},
    )
    assert "Upstream service unavailable" in result.json()["content"]
    work_file = await client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "background/work/message_idempotency_key.txt"},
    )
    assert work_file.json()["content"] == "retry-safe-key\n"


async def test_terminal_result_delete_removes_record_and_files(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Deletable Result")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    (space.result_dir / "result.txt").write_text("done\n", encoding="utf-8")
    published = await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Deletable Result"),
    )

    assert (await client.delete(f"/workflow-runs/{run_id}")).status_code == 204
    assert not published.root.exists()
    assert space.root.exists()
    assert await repository.get(LOCAL_USER_ID, run_id) is None
    assert (await client.get(f"/workflow-runs/{run_id}")).status_code == 404


async def test_workflow_result_binary_download_returns_raw_bytes(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Binary Result")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    content = b"\x89PNG\r\n\x1a\n\x00\xffraw-result"
    (space.result_dir / "chart.png").write_bytes(content)
    await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Binary Result"),
    )

    preview = await client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "result/chart.png"},
    )
    assert preview.status_code == 200
    assert preview.json()["content"] is None

    download = await client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "result/chart.png", "raw": "true"},
    )
    assert download.status_code == 200
    assert download.content == content
    assert download.headers["content-type"] == "image/png"
    assert download.headers["content-disposition"] == 'attachment; filename="chart.png"'


async def test_workflow_result_export_returns_user_visible_files_as_zip(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Exportable Result")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    (space.result_dir / "summary.md").write_text("# Summary\n", encoding="utf-8")
    (space.result_dir / "charts").mkdir()
    (space.result_dir / "charts" / "trend.bin").write_bytes(b"\x00\x01result")
    (space.background_dir / "private.txt").write_text("not exported", encoding="utf-8")
    (space.background_work_dir / "request.json").write_text(
        '{"cursor":"next"}\n',
        encoding="utf-8",
    )
    await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Exportable Result"),
    )

    exported = await client.get(
        f"/workflow-runs/{run_id}",
        params={"archive": "true"},
    )

    assert exported.status_code == 200
    assert exported.headers["content-type"] == "application/zip"
    assert exported.headers["content-disposition"] == f'attachment; filename="{run_id}.zip"'
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert archive.namelist() == [
            "charts/trend.bin",
            "summary.md",
            "background/work/request.json",
        ]
        assert archive.read("summary.md") == b"# Summary\n"
        assert archive.read("charts/trend.bin") == b"\x00\x01result"
        assert archive.read("background/work/request.json") == b'{"cursor":"next"}\n'
        assert "background/private.txt" not in archive.namelist()


async def test_workflow_result_export_rejects_colliding_published_paths(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Colliding Export")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    result_collision = space.result_dir / "background" / "work"
    result_collision.mkdir(parents=True)
    (result_collision / "request.json").write_text("final\n", encoding="utf-8")
    (space.background_work_dir / "request.json").write_text(
        "intermediate\n",
        encoding="utf-8",
    )
    await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Colliding Export"),
    )

    exported = await client.get(
        f"/workflow-runs/{run_id}",
        params={"archive": "true"},
    )

    assert exported.status_code == 409
    assert "collide at archive path 'background/work/request.json'" in (
        exported.json()["detail"]
    )


async def test_workflow_result_search_filters_before_recent_limit(
    client: httpx.AsyncClient,
) -> None:
    workflow = await _create_workflow(client, "Search Results")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    target_id = repository.new_id()
    target_space = _active_result(workflow, target_id)
    await _terminal_result(
        result_id=target_id,
        workflow=workflow,
        session_id=session_id,
        source_root=target_space.root,
        workflow_input=UserInput(text="unique old result"),
    )
    for index in range(25):
        result_id = repository.new_id()
        space = _active_result(workflow, result_id)
        await _terminal_result(
            result_id=result_id,
            workflow=workflow,
            session_id=session_id,
            source_root=space.root,
            workflow_input=UserInput(text=f"ordinary result {index}"),
        )

    matches = (await client.get(
        "/workflow-runs",
        params={"q": "unique old result", "limit": 5},
    )).json()
    assert [run["id"] for run in matches] == [target_id]

    last_page = (await client.get(
        "/workflow-runs",
        params={"limit": 5, "offset": 25},
    )).json()
    assert [run["id"] for run in last_page] == [target_id]


async def test_workflow_result_api_rejects_unsafe_result_paths(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    workflow = await _create_workflow(client, "Safe Result")
    session_id = (await client.post("/sessions", json={})).json()["id"]
    repository = WorkflowRunRepository()
    run_id = repository.new_id()
    space = _active_result(workflow, run_id)
    (space.result_dir / "safe.txt").write_text("safe\n", encoding="utf-8")
    (space.root / "background" / "validation.md").write_text(
        "private evidence\n",
        encoding="utf-8",
    )
    (space.background_work_dir / "safe-work.txt").write_text(
        "published intermediate\n",
        encoding="utf-8",
    )
    private_file = tmp_path / "private.txt"
    private_file.write_text("secret\n", encoding="utf-8")
    (space.result_dir / "leak.txt").symlink_to(private_file)
    (space.background_work_dir / "leak-work.txt").symlink_to(private_file)
    private_dir = tmp_path / "private-dir"
    private_dir.mkdir()
    (private_dir / "nested.txt").write_text("nested secret\n", encoding="utf-8")
    (space.result_dir / "linked-dir").symlink_to(private_dir, target_is_directory=True)
    await _terminal_result(
        result_id=run_id,
        workflow=workflow,
        session_id=session_id,
        source_root=space.root,
        workflow_input=UserInput(text="/Safe Result"),
    )

    detail = (await client.get(f"/workflow-runs/{run_id}")).json()
    assert [file["path"] for file in detail["files"]] == [
        "result/safe.txt",
        "background/work/safe-work.txt",
    ]
    safe_work = await client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "background/work/safe-work.txt"},
    )
    assert safe_work.json()["content"] == "published intermediate\n"
    for path in (
        "result/leak.txt",
        "result/linked-dir/nested.txt",
        "background/work/leak-work.txt",
        "background/validation.md",
        "source/workflow/WORKFLOW.md",
        ".state.json",
    ):
        assert (
            await client.get(
                f"/workflow-runs/{run_id}/file",
                params={"path": path},
            )
        ).status_code == 404
        assert (
            await client.get(
                f"/workflow-runs/{run_id}/file",
                params={"path": path, "raw": "true"},
            )
        ).status_code == 404

    forged_id = repository.new_id()
    forged = tmp_path / "forged-result"
    (forged / "result").mkdir(parents=True)
    (forged / "result" / "secret.txt").write_text("secret\n", encoding="utf-8")
    await repository.create_or_confirm_terminal(
        LOCAL_USER_ID,
        result_id=forged_id,
        workflow_id=workflow["id"],
        workflow_name=workflow["name"],
        source_session_id=session_id,
        result_dir=str(forged),
        workflow_input=UserInput(text="/Forged Result"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    assert (await client.get(f"/workflow-runs/{forged_id}")).status_code == 409
    assert (
        await client.get(
            f"/workflow-runs/{forged_id}/file",
            params={"path": "result/secret.txt", "raw": "true"},
        )
    ).status_code == 400
