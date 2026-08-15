from pathlib import Path
from types import SimpleNamespace

import pytest

from src.amphi_agent import WorkflowLibrary, WorkflowRunLibrary
from src.amphi_agent import _workflows as workflows_module
from src.amphi_agent._workspace import Workspace
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    UserInput,
    UserRepository,
    WorkflowNameConflictError,
    WorkflowRepository,
)


async def _verified_build(workspace: Workspace, *, workflow_id: str | None = None):
    build = await workspace.prepare_build_space("create", stage="verify", workflow_id=workflow_id)
    (build.root / "task.md").write_text("# Task\n\nCreate the final result.\n", encoding="utf-8")
    (build.root / "explore.md").write_text("# Explore\n\nUse the saved plan.\n", encoding="utf-8")
    (build.root / "verify.md").write_text("# Verify\n\nPASS\n", encoding="utf-8")
    (build.root / "workflow").mkdir()
    ((build.root / "workflow") / "WORKFLOW.md").write_text(
        "---\nname: saved-plan\ndescription: Create the result.\n---\n\n"
        "# Execute\n\nCreate the final result.\n",
        encoding="utf-8",
    )
    ((build.root / "workflow") / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    return build


async def _seed_session(tmp_path: Path) -> None:
    await UserRepository().ensure_seeded("user-1")
    await SessionRepository().save(SessionRecord(
        id="session-1",
        user_id="user-1",
        workspace_root=str(tmp_path / "session"),
    ))


def test_workflow_library_owns_the_active_package_binding(tmp_path: Path) -> None:
    root = tmp_path / "build"
    root.mkdir()
    library = WorkflowLibrary("user-1")

    package = library.open_package(root)

    assert library.package is package
    assert library.require_package(root) is package
    library.close_package()
    assert library.package is None


async def test_materialize_workflow_creates_one_idempotent_library_workflow(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    build = await _verified_build(workspace)
    library = await WorkflowLibrary("user-1").load()

    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-confirm",
        name="Saved plan",
        description="Verified plan",
    )

    retried = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-confirm",
        name="Saved plan",
        description="Verified plan",
    )

    assert retried == saved
    assert saved.workflow_id.startswith("wf_")
    assert saved.root.parent == tmp_path / "workflows"
    assert (saved.root / "task.md").read_text(encoding="utf-8").startswith(
        "# Task"
    )
    assert not (saved.root / ".state.json").exists()
    assert build.is_available
    assert build.root.is_dir()
    assert library.get(saved.workflow_id) == saved
    assert len(await WorkflowRepository().list_for_user("user-1")) == 1


async def test_delete_keeps_the_record_when_package_staging_fails(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    build = await _verified_build(workspace)
    library = await WorkflowLibrary("user-1").load()
    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-delete-stage-failure",
        name="Saved plan",
        description="Verified plan",
    )
    real_replace = workflows_module.os.replace

    def fail_package_staging(source, target) -> None:
        if Path(source) == saved.root:
            raise PermissionError("package is busy")
        real_replace(source, target)

    monkeypatch.setattr(workflows_module.os, "replace", fail_package_staging)

    with pytest.raises(PermissionError, match="package is busy"):
        await library.delete(saved.workflow_id)

    assert await WorkflowRepository().get("user-1", saved.workflow_id) is not None
    assert saved.root.is_dir()
    assert library.get(saved.workflow_id) == saved
    assert not list(saved.root.parent.glob(f".{saved.workflow_id}.removing.*"))


async def test_delete_restores_the_package_when_database_deletion_fails(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    build = await _verified_build(workspace)
    library = await WorkflowLibrary("user-1").load()
    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-delete-database-failure",
        name="Saved plan",
        description="Verified plan",
    )

    async def fail_delete(user_id: str, workflow_id: str) -> bool:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(library._repo, "delete", fail_delete)

    with pytest.raises(RuntimeError, match="database unavailable"):
        await library.delete(saved.workflow_id)

    assert await WorkflowRepository().get("user-1", saved.workflow_id) is not None
    assert saved.root.is_dir()
    assert library.get(saved.workflow_id) == saved
    assert not list(saved.root.parent.glob(f".{saved.workflow_id}.removing.*"))


async def test_saved_workflow_accepts_and_ignores_extra_root_entries(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    build = await _verified_build(workspace)
    library = await WorkflowLibrary("user-1").load()
    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-confirm",
        name="Saved plan",
        description="Verified plan",
    )
    (saved.root / "notes.txt").write_text("Extra metadata.\n", encoding="utf-8")
    (saved.root / ".runtime").mkdir()
    (saved.root / ".runtime" / "pyproject.toml").write_text(
        "[project]\nname = 'legacy-runtime'\n",
        encoding="utf-8",
    )

    reloaded = await WorkflowLibrary("user-1").load()
    async with reloaded.guarded_source(saved.workflow_id) as source:
        assert source.root == saved.root
    assert (saved.root / "notes.txt").read_text(encoding="utf-8") == "Extra metadata.\n"
    assert (saved.root / ".runtime" / "pyproject.toml").is_file()

    restored = tmp_path / "restored"
    restored.mkdir()
    await reloaded.restore_source(saved, restored)
    assert all((restored / name).exists() for name in saved.ROOT_ENTRY_NAMES)
    assert not (restored / "notes.txt").exists()
    assert not (restored / ".runtime").exists()


async def test_materialize_workflow_edit_replaces_content_and_preserves_workflow_id(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    first_workspace = Workspace("session-1", session_root=tmp_path / "session")
    first = await _verified_build(first_workspace)
    library = await WorkflowLibrary("user-1").load()
    first.start_acceptance_review("review-1")
    saved = await library.materialize_workflow(
        first.root,
        workflow_id=first.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-create",
        name="Saved plan",
        description="First version",
    )
    assert first.is_available

    await first_workspace.discard_build()
    async with library.guarded_source(saved.workflow_id) as workflow:
        edit = await first_workspace.prepare_build_space(
            "create",
            workflow_id=workflow.workflow_id,
            stage="verify",
        )
        await library.restore_source(workflow, edit.root)
    assert edit.stage == "verify"
    assert edit.workflow_id == saved.workflow_id
    assert not edit.acceptance_review_presented
    (edit.root / "task.md").write_text("# Task\n\nCreate the revised result.\n", encoding="utf-8")
    updated = await library.materialize_workflow(
        edit.root,
        workflow_id=edit.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-edit",
        name="Ignored rename",
        description="Second version",
    )

    assert updated.workflow_id == saved.workflow_id
    assert updated.name == "Saved plan"
    assert updated.description == "Second version"
    assert "revised" in (updated.root / "task.md").read_text(
        encoding="utf-8"
    )
    assert edit.is_available
    assert edit.root.is_dir()
    assert library.get(saved.workflow_id) == updated


async def test_materialize_workflow_edit_can_create_an_independent_workflow(
    connected_repo: None,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_WORKFLOWS_ROOT", str(tmp_path / "workflows"))
    await _seed_session(tmp_path)
    workspace = Workspace("session-1", session_root=tmp_path / "session")
    original_build = await _verified_build(workspace)
    library = await WorkflowLibrary("user-1").load()
    original = await library.materialize_workflow(
        original_build.root,
        workflow_id=original_build.workflow_id,
        source_session_id="session-1",
        source_turn_id="turn-create-original",
        name="Saved plan",
        description="Original version",
    )
    original_task = (original.root / "task.md").read_text(encoding="utf-8")

    await workspace.discard_build()
    async with library.guarded_source(original.workflow_id) as source:
        edit = await workspace.prepare_build_space(
            "create",
            workflow_id=original.workflow_id,
            stage="verify",
        )
        await library.restore_source(source, edit.root)
    (edit.root / "task.md").write_text(
        "# Task\n\nCreate the independent revised result.\n",
        encoding="utf-8",
    )

    created = await library.materialize_workflow(
        edit.root,
        workflow_id=None,
        source_session_id="session-1",
        source_turn_id="turn-save-as-new",
        name="Saved plan copy",
        description="Independent revised version",
    )

    with pytest.raises(WorkflowNameConflictError, match="Saved plan copy"):
        await library.materialize_workflow(
            edit.root,
            workflow_id=None,
            source_session_id="session-1",
            source_turn_id="turn-save-as-new-conflict",
            name="Saved plan copy",
            description="Must not overwrite either Workflow",
        )

    reloaded_original = await WorkflowLibrary("user-1").load()
    original_after = reloaded_original.get(original.workflow_id)
    assert original_after is not None
    assert created.workflow_id != original.workflow_id
    assert created.root != original.root
    assert created.name == "Saved plan copy"
    assert created.description == "Independent revised version"
    assert created.source_session_id == "session-1"
    assert created.source_turn_id == "turn-save-as-new"
    assert "independent revised" in (created.root / "task.md").read_text(
        encoding="utf-8"
    )
    assert original_after.name == "Saved plan"
    assert original_after.description == "Original version"
    assert (original_after.root / "task.md").read_text(encoding="utf-8") == original_task
    assert {row.id for row in await WorkflowRepository().list_for_session(
        "user-1", "session-1"
    )} == {original.workflow_id, created.workflow_id}
    assert len(await WorkflowRepository().list_for_user("user-1")) == 2


async def test_load_excludes_workflows_without_a_readable_directory(monkeypatch, tmp_path) -> None:
    async def list_for_user(_repository, user_id: str):
        return [SimpleNamespace(
            id="wf_missing",
            name="Missing",
            workflow_dir=str(tmp_path / "missing"),
            description=None,
            domain=None,
            source_session_id=None,
            source_turn_id=None,
        )]

    monkeypatch.setattr(WorkflowRepository, "list_for_user", list_for_user)

    library = await WorkflowLibrary("user-1").load()

    assert library.is_empty()


async def test_source_parses_execution_and_validation_sections(monkeypatch, tmp_path) -> None:
    workflow_dir = tmp_path / "wf_run"
    source_dir = workflow_dir / "workflow"
    source_dir.mkdir(parents=True)
    (source_dir / "WORKFLOW.md").write_text(
        "---\nname: run-report\ndescription: Generate a report\n---\n\n"
        "# Collect data\nRead the input.\n\n# Write report\nCreate `report.md`.\n",
        encoding="utf-8",
    )
    (source_dir / "VALIDATE.md").write_text(
        "# Check report\nConfirm `report.md` is complete.\n",
        encoding="utf-8",
    )

    async def list_for_user(_repository, user_id: str):
        return [SimpleNamespace(
            id="wf_run",
            name="Run report",
            workflow_dir=str(workflow_dir),
            description="Generate a report",
            domain=None,
            source_session_id=None,
            source_turn_id=None,
        )]

    monkeypatch.setattr(WorkflowRepository, "list_for_user", list_for_user)
    library = await WorkflowLibrary("user-1").load()

    source = library.source("wf_run")

    assert [step.title for step in source.execution_steps] == ["Collect data", "Write report"]
    assert [step.title for step in source.validation_steps] == ["Check report"]


async def test_session_input_associations_are_split_by_domain_adapter(monkeypatch) -> None:
    workflows = WorkflowLibrary("user-1")
    workflows._packages = {
        "wf_direct": SimpleNamespace(),
        "wf_result": SimpleNamespace(),
    }
    workflow_runs = WorkflowRunLibrary("user-1")
    workflow_runs._runs = {
        "wfr_1": SimpleNamespace(workflow_id="wf_result", is_published=True),
    }
    calls = []

    async def associate(user_id: str, session_id: str, workflow_id: str) -> bool:
        calls.append((user_id, session_id, workflow_id))
        return True

    monkeypatch.setattr(workflows._repo, "associate", associate)
    user_input = UserInput(
        text="/直接工作流 @上次结果",
        blocks=[
            {"type": "slash", "id": "wf_direct", "label": "直接工作流", "resource": "workflow"},
            {"type": "mention", "id": "wfr_1", "label": "上次结果", "group": "WorkflowRun"},
        ],
    )
    direct_associations = await workflows.associate_session_input("session-1", user_input)
    run_associations = []
    for run in workflow_runs.referenced_runs(user_input):
        if await workflows.associate_session("session-1", run.workflow_id):
            run_associations.append(run.workflow_id)

    assert direct_associations == ("wf_direct",)
    assert tuple(run_associations) == ("wf_result",)
    assert calls == [
        ("user-1", "session-1", "wf_direct"),
        ("user-1", "session-1", "wf_result"),
    ]
