from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from dulwich.repo import Repo

from src.amphi_agent._workflow_run import RunWorkflow
from src.amphi_agent._workspace import (
    BUILD_DIR_NAME,
    CHECKPOINT_AUTHOR,
    RunWorkflowSpace,
    Workspace,
    WorkspaceCheckpoints,
)
from src.amphi_agent.runtime._environment import (
    WorkspaceEnvironment,
    app_command_environment,
    bundled_node_base_runtime,
    bundled_node_runtime,
    bundled_python_runtime,
    bundled_uv_runtime,
)


async def _workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    session_id: str = "session",
    session_root: Path | None = None,
) -> Workspace:
    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace(session_id, session_root=session_root)
    await workspace.prepare_workspace()
    return workspace


async def _create_run(
    workspace: Workspace,
    source_root: Path,
    workflow_id: str = "wf-report",
) -> RunWorkflowSpace:
    package = source_root / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\nname: workspace-fixture\ndescription: Workspace fixture.\n---\n\n"
        "# Execute\n\nProduce a result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (source_root / name).write_text(f"# {name}\n", encoding="utf-8")
    def populate(root: Path) -> None:
        RunWorkflow(root).prepare("create", source_root=source_root)

    return await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": workflow_id,
            "generation": "generation-1",
            "workflow_name": workflow_id,
            "workflow_input": {"text": "", "blocks": []},
            "stage": "execute",
            "step_index": 0,
        },
        populate=populate,
    )


def test_workspace_display_path_normalizes_only_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("src.amphi_agent._workspace._IS_WINDOWS", True)
    assert WorkspaceCheckpoints._display_path(r".work\nested\file.txt") == "nested/file.txt"

    monkeypatch.setattr("src.amphi_agent._workspace._IS_WINDOWS", False)
    assert WorkspaceCheckpoints._display_path(r".work/name\literal.txt") == r"name\literal.txt"


async def test_workspace_build_lifecycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    created = await workspace.prepare_build_space("create", stage="explore")

    assert created.root == workspace.work_dir / BUILD_DIR_NAME
    assert created.root.name == BUILD_DIR_NAME
    assert created.stage == "explore"
    assert workspace.build is created

    workspace.close_build_space()
    assert workspace.build is None
    resumed = await workspace.prepare_build_space("resume")
    assert resumed.stage == "explore"

    await workspace.discard_build()
    assert not workspace.has_build
    with pytest.raises(FileNotFoundError):
        await workspace.prepare_build_space("resume")

    outside = tmp_path / "outside-build"
    outside.mkdir()
    (outside / "task.md").write_text("wrong build", encoding="utf-8")
    (workspace.work_dir / BUILD_DIR_NAME).symlink_to(outside, target_is_directory=True)
    assert not workspace.has_build
    with pytest.raises(FileNotFoundError):
        await workspace.prepare_build_space("resume")
    await workspace.discard_build()
    assert outside.is_dir()


async def test_has_build_requires_a_valid_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    build = await workspace.prepare_build_space("create")
    assert workspace.has_build

    (build.root / ".state.json").write_text("not json", encoding="utf-8")
    assert not workspace.has_build

    (build.root / ".state.json").write_text(
        json.dumps({"stage": "clarify", "unexpected": True}),
        encoding="utf-8",
    )
    assert not workspace.has_build

    (build.root / ".state.json").write_text(
        json.dumps({"stage": "clarify", "acceptance_contract": {"rules": []}}),
        encoding="utf-8",
    )
    assert not workspace.has_build


async def test_legacy_build_acceptance_contract_normalizes_to_request_receipt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    build = await workspace.prepare_build_space("create", stage="generate")
    state_path = build.root / ".state.json"
    legacy_rule_text = "The legacy accepted result exists."
    state_path.write_text(
        json.dumps({
            "stage": "generate",
            "workflow_id": "wf-legacy",
            "acceptance_contract": {
                "request_id": "accept-legacy",
                "mode": "criteria",
                "rules": [{
                    "id": "AC-001",
                    "text": legacy_rule_text,
                    "source": "agent_proposed_user_accepted",
                }],
            },
            "edit_task_baseline": "# Legacy task",
            "last_task_confirmation": {
                "request_id": "task-legacy",
                "task_markdown": "# Legacy task",
            },
        }),
        encoding="utf-8",
    )
    workspace.close_build_space()

    checkpoint = workspace.build_checkpoint()

    assert checkpoint is not None
    assert checkpoint.stage == "generate"
    assert checkpoint.workflow_id == "wf-legacy"
    assert checkpoint.acceptance_contract == {"request_id": "accept-legacy"}
    assert checkpoint.edit_task_baseline == "# Legacy task"
    assert checkpoint.last_task_confirmation == {
        "request_id": "task-legacy",
        "task_markdown": "# Legacy task",
    }
    raw_state = json.loads(state_path.read_text(encoding="utf-8"))
    assert raw_state["acceptance_contract"]["rules"][0]["text"] == legacy_rule_text

    resumed = await workspace.prepare_build_space("resume")
    resumed_state = state_path.read_text(encoding="utf-8")
    assert '"acceptance_contract":{"request_id":"accept-legacy"}' in resumed_state
    assert legacy_rule_text not in resumed_state
    resumed.set_stage("verify")
    normalized = json.loads(state_path.read_text(encoding="utf-8"))
    serialized = json.dumps(normalized)

    assert normalized == {
        "stage": "verify",
        "workflow_id": "wf-legacy",
        "acceptance_contract": {"request_id": "accept-legacy"},
        "edit_task_baseline": "# Legacy task",
        "last_task_confirmation": {
            "request_id": "task-legacy",
            "task_markdown": "# Legacy task",
        },
    }
    assert '"acceptance_contract"' in serialized
    assert "rules" not in serialized
    assert '"text"' not in serialized
    assert legacy_rule_text not in serialized


async def test_workspace_env_is_shared_across_active_spaces(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    build = await workspace.prepare_build_space("create")

    base_env = workspace.env
    assert "UV_PROJECT" not in base_env
    assert "UV_PROJECT_ENVIRONMENT" not in base_env
    assert "VIRTUAL_ENV" not in base_env

    run = await _create_run(workspace, tmp_path / "workflows" / "wf")
    assert workspace.has_run_workflow
    assert workspace.env == base_env

    workspace.close_run_workflow_space()
    assert workspace.env == base_env


async def test_has_run_workflow_requires_a_valid_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    run = await _create_run(workspace, tmp_path / "workflows" / "wf")
    assert workspace.has_run_workflow

    (run.root / ".state.json").write_text("not json", encoding="utf-8")
    assert not workspace.has_run_workflow


async def test_workspace_versioning_status_diff_and_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    (workspace.session_root / "history.md").write_text("turns", encoding="utf-8")

    assert (workspace.session_root / ".git").is_dir()
    assert (workspace.session_root / ".internal").is_dir()
    gitignore = (workspace.session_root / ".gitignore").read_text(encoding="utf-8")
    assert "history.md" in gitignore
    assert ".venv/" in gitignore
    assert "node_modules/" in gitignore
    assert ".work/.run/" in gitignore
    await _create_run(workspace, tmp_path / "workflow-source")
    assert workspace.checkpoints.current_changes() == []

    (workspace.work_dir / "a.txt").write_text("one\n", encoding="utf-8")
    changes = workspace.checkpoints.current_changes()
    assert [change["path"] for change in changes] == ["a.txt"]
    assert all(change["path"] != ".venv" for change in changes)
    assert workspace.checkpoints.changed_files_context_lines() == [
        "- Changed files:",
        "  - New File: a.txt (+1 lines, -0 lines)",
    ]

    checkpoint = workspace.checkpoints.checkpoint("Add a")
    assert checkpoint is not None
    assert workspace.checkpoints.current_changes() == []

    (workspace.work_dir / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    assert [change["path"] for change in workspace.checkpoints.current_changes()] == ["a.txt"]
    assert "+two" in workspace.checkpoints.diff()

    history = workspace.checkpoints.history()
    assert [item["message"] for item in history[:2]] == ["Add a", "Initial workspace"]
    assert str(history[0]["checkpoint_id"]).startswith(checkpoint[:12])
    assert workspace.checkpoints.checkpoint_changes(checkpoint[:12]) == [
        {"label": "New File", "path": "a.txt", "added_lines": 1, "deleted_lines": 0},
    ]

    context_lines = workspace.checkpoints.checkpoint_context_lines(max_count=2)
    assert context_lines[0].startswith(f"- Latest checkpoint: {checkpoint[:12]}")
    assert any("Add a" in line for line in context_lines)


async def test_workspace_checkpoint_ignores_session_root_uv_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    lockfile = workspace.session_root / "uv.lock"
    lockfile.write_text("version = 1\n", encoding="utf-8")
    assert workspace.checkpoints.checkpoint("add lock") is None

    lockfile.unlink()
    assert workspace.checkpoints.checkpoint("delete lock") is None


async def test_workspace_checkpoint_ignores_untracked_session_root_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    before = workspace.checkpoints.history(max_count=1)[0]["checkpoint_id"]
    (workspace.session_root / "outside.txt").write_text("outside\n", encoding="utf-8")

    assert workspace.checkpoints.checkpoint("ignored root file") is None
    assert workspace.checkpoints.history(max_count=1)[0]["checkpoint_id"] == before


async def test_workspace_checkpoint_ignores_the_user_commit_signing_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A checkpoint is never signed, whatever the user's git config asks for.

    Two things go wrong if dulwich is left to read `commit.gpgsign` itself.
    A checkpoint is authored as CHECKPOINT_AUTHOR — a synthetic identity, not
    a person — so signing it with the user's key produces a signed commit that
    user never wrote. And when the configured signer cannot run at all, the
    commit raises instead: `gpg.format = ssh` with no `ssh-keygen` on PATH is
    enough, and because every Agent turn prepares its Workspace through this
    path, the turn dies before the Agent is ever constructed.

    The git config here is written to a real file and pointed at through
    GIT_CONFIG_GLOBAL rather than mocked, because the behaviour under test is
    precisely that dulwich consults the environment's git configuration.
    """
    workspace = await _workspace(tmp_path, monkeypatch)

    gitconfig = tmp_path / "gitconfig-with-signing"
    gitconfig.write_text(
        "[user]\n"
        "\tname = Someone\n"
        "\temail = someone@example.com\n"
        "\tsigningkey = /nonexistent/key.pub\n"
        "[gpg]\n"
        "\tformat = ssh\n"
        '[gpg "ssh"]\n'
        "\tprogram = /nonexistent/ssh-keygen\n"
        "[commit]\n"
        "\tgpgsign = true\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)

    (workspace.work_dir / "a.txt").write_text("one\n", encoding="utf-8")
    checkpoint = workspace.checkpoints.checkpoint("with signing configured")

    assert checkpoint is not None
    with Repo(str(workspace.session_root)) as repo:
        commit = repo[checkpoint.encode("ascii")]
        assert commit.gpgsig is None
        assert commit.author == CHECKPOINT_AUTHOR


async def test_workspace_restore_preserves_the_active_run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    work = workspace.work_dir
    (work / "a.txt").write_text("one\n", encoding="utf-8")
    first = workspace.checkpoints.checkpoint("first")
    assert first is not None

    (work / "a.txt").write_text("two\n", encoding="utf-8")
    (work / "b.txt").write_text("bee\n", encoding="utf-8")
    assert workspace.checkpoints.checkpoint("second") is not None

    (work / "a.txt").write_text("dirty\n", encoding="utf-8")
    active_run = await _create_run(workspace, tmp_path / "workflow-source")
    assert workspace.checkpoints.restore_file(first[:12], "a.txt") == "a.txt"
    workspace.checkpoints.restore(first[:12])

    assert (work / "a.txt").read_text(encoding="utf-8") == "one\n"
    assert not (work / "b.txt").exists()
    assert active_run.workflow_id == "wf-report"
    with pytest.raises(ValueError, match="active Workflow Run"):
        workspace.checkpoints.restore_file(first[:12], ".run/.state.json")


async def test_workspace_restore_removes_a_file_absent_from_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    (workspace.work_dir / "a.txt").write_text("one\n", encoding="utf-8")
    first = workspace.checkpoints.checkpoint("first")
    assert first is not None

    target = workspace.work_dir / "b.txt"
    target.write_text("bee\n", encoding="utf-8")
    assert workspace.checkpoints.checkpoint("second") is not None
    workspace.checkpoints.restore_file(first[:12], "b.txt")
    assert not target.exists()


async def test_workspace_restore_automatically_protects_dirty_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    target = workspace.work_dir / "a.txt"
    target.write_text("one\n", encoding="utf-8")
    checkpoint = workspace.checkpoints.checkpoint("first")
    assert checkpoint is not None

    target.write_text("dirty\n", encoding="utf-8")
    workspace.checkpoints.restore_file(checkpoint, "a.txt")
    protection = workspace.checkpoints.history(max_count=1)[0]

    assert protection["message"] == "Protection checkpoint before restore"
    assert target.read_text(encoding="utf-8") == "one\n"
    workspace.checkpoints.restore_file(str(protection["checkpoint_id"]), "a.txt")
    assert target.read_text(encoding="utf-8") == "dirty\n"


async def test_workspace_constructor_is_pure_and_prepare_only_builds_the_shell(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "session"
    workspace = Workspace("session", session_root=root)

    assert not root.exists()
    assert await workspace.prepare_workspace() is None
    assert (root / ".git").is_dir()
    assert workspace.work_dir.is_dir()
    assert (root / ".internal").is_dir()
    assert not (root / "pyproject.toml").exists()
    assert not (root / "uv.lock").exists()
    assert not (root / ".venv").exists()
    assert "VIRTUAL_ENV" not in workspace.env
    assert "UV_PROJECT" not in workspace.env
    assert "UV_PROJECT_ENVIRONMENT" not in workspace.env


async def test_prepare_workspace_preserves_existing_project_files_without_syncing(
    tmp_path: Path,
) -> None:
    root = tmp_path / "copied-session"
    (root / ".work").mkdir(parents=True)
    project = root / "pyproject.toml"
    lockfile = root / "uv.lock"
    project.write_text("[project]\nname = 'copied'\n", encoding="utf-8")
    lockfile.write_text("version = 1\n", encoding="utf-8")

    workspace = Workspace("copied-session", session_root=root)
    await workspace.prepare_workspace()

    assert project.read_text(encoding="utf-8") == "[project]\nname = 'copied'\n"
    assert lockfile.read_text(encoding="utf-8") == "version = 1\n"
    assert not (root / ".venv").exists()
    assert "VIRTUAL_ENV" not in workspace.env


async def test_existing_workspace_shell_is_prepared(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace-shell"
    (root / ".work").mkdir(parents=True)

    workspace = await _workspace(tmp_path, monkeypatch, session_root=root)

    assert workspace.work_dir == root / ".work"
    assert (root / ".git").is_dir()


async def test_workspace_env_returns_independent_maps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = await _workspace(tmp_path, monkeypatch)
    first = workspace.env
    first["PATH"] = "/mutated"
    first["CUSTOM"] = "value"
    second = workspace.env

    assert second["PATH"] != "/mutated"
    assert "CUSTOM" not in second


def test_workspace_environment_consumes_the_startup_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    snapshot = SimpleNamespace(
        command_env=lambda: {"PATH": "/app/bin"},
        uv_executable=tmp_path / "uv",
        uv_version="0.9.5",
        python_executable=tmp_path / "python",
        python_version="3.13.6",
        node_executable=tmp_path / "node",
        node_version="v22.23.1",
    )

    def snapshot_result():
        calls.append("snapshot")
        return snapshot

    monkeypatch.setattr(app_command_environment, "snapshot", snapshot_result)
    monkeypatch.setattr(
        app_command_environment,
        "prepare",
        lambda: pytest.fail("Workspace repeated App startup preparation"),
    )
    environment = WorkspaceEnvironment(tmp_path / "session")

    environment.prepare()
    environment.prepare()

    assert calls == ["snapshot"]
    assert environment.subprocess_env() == {"PATH": "/app/bin"}
    assert environment.python_version == "3.13.6"


async def test_workspace_runtime_failure_does_not_create_the_session_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "session"
    workspace = Workspace("session", session_root=root)

    def fail_prepare() -> None:
        raise RuntimeError("runtime unavailable")

    monkeypatch.setattr(workspace.environment, "prepare", fail_prepare)

    with pytest.raises(RuntimeError, match="runtime unavailable"):
        await workspace.prepare_workspace()

    assert not root.exists()


def test_workspace_environment_uses_one_shared_base_without_a_local_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is required for the shared base integration test")
    base_root = tmp_path / "app-python-base"
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(Path(uv).parent))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", sys.executable)
    monkeypatch.setattr(bundled_python_runtime, "root", base_root)
    daemon_bin = "/daemon/venv/bin"
    monkeypatch.setenv("PATH", os.pathsep.join((daemon_bin, "/opt/homebrew/bin")))
    monkeypatch.setenv("VIRTUAL_ENV", "/daemon/venv")
    monkeypatch.setenv("UV_PROJECT", "/daemon/project")
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", "/daemon/project/.venv")
    bundled_uv_runtime.reset_cache()
    bundled_python_runtime.reset()

    session_root = tmp_path / "session"
    environment = WorkspaceEnvironment(session_root)
    environment.prepare()
    command_env = environment.subprocess_env()
    second_environment = WorkspaceEnvironment(tmp_path / "another-session")
    second_environment.prepare()
    second_env = second_environment.subprocess_env()
    base_python = base_root / (
        "Scripts/python.exe" if os.name == "nt" else "bin/python"
    )

    assert environment.python_executable == base_python
    assert command_env["UV_PYTHON"] == str(base_python)
    assert command_env["VIRTUAL_ENV"] == str(base_root)
    assert command_env["UV_PROJECT_ENVIRONMENT"] == str(base_root)
    assert second_env["VIRTUAL_ENV"] == str(base_root)
    assert second_env["UV_PYTHON"] == str(base_python)
    pycache_prefix = Path(command_env["PYTHONPYCACHEPREFIX"])
    assert pycache_prefix == bundled_uv_runtime.data_home / "python" / "pycache"
    assert base_root not in pycache_prefix.parents
    assert str(base_root / ("Scripts" if os.name == "nt" else "bin")) in (
        command_env["PATH"].split(os.pathsep)
    )
    assert command_env["PATH"].split(os.pathsep).index(str(base_root / "bin")) < (
        command_env["PATH"].split(os.pathsep).index(daemon_bin)
    )
    assert "UV_PROJECT" not in command_env
    assert base_python.is_file()
    assert not session_root.exists()


def test_workspace_environment_exposes_the_bundled_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    node_root = tmp_path / "Resources" / "node_runtime"
    node_bin = node_root / "bin"
    node_bin.mkdir(parents=True)
    node = node_bin / ("node.exe" if os.name == "nt" else "node")
    node.write_text("", encoding="utf-8")
    npm_bin = node_root / "lib" / "node_modules" / "npm" / "bin"
    npm_bin.mkdir(parents=True)
    (npm_bin / "npm-cli.js").write_text("", encoding="utf-8")
    (npm_bin / "npx-cli.js").write_text("", encoding="utf-8")
    (node_root / "runtime.json").write_text('{"nodeVersion":"v22.0.0"}', encoding="utf-8")
    data_home = tmp_path / "app-data"
    base_root = data_home / "node" / "base"
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(node_root))
    daemon_bin = "/daemon/venv/bin"
    homebrew_bin = "/opt/homebrew/bin"
    monkeypatch.setenv("PATH", os.pathsep.join((daemon_bin, homebrew_bin)))
    monkeypatch.delenv("npm_config_prefix", raising=False)
    monkeypatch.delenv("npm_config_cache", raising=False)
    monkeypatch.setattr(bundled_node_base_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_node_base_runtime, "root", base_root)
    monkeypatch.setattr(bundled_node_base_runtime, "cache", data_home / "node" / "cache")
    bundled_node_runtime.reset_cache()
    bundled_node_base_runtime.reset()

    environment = WorkspaceEnvironment(tmp_path / "session")
    environment.prepare()
    command_env = environment.subprocess_env()
    second_environment = WorkspaceEnvironment(tmp_path / "other-session")
    second_environment.prepare()
    second_env = second_environment.subprocess_env()

    assert environment.node_executable == node.resolve()
    assert environment.node_version == "v22.0.0"
    path = command_env["PATH"].split(os.pathsep)
    shim_dir = str(base_root / ".amphi" / "bin")
    shared_bin = str(base_root if os.name == "nt" else base_root / "bin")
    assert path.index(shim_dir) < path.index(str(node_bin))
    assert path.index(str(node_bin)) < path.index(shared_bin)
    assert path.index(shared_bin) < path.index(daemon_bin)
    assert path.index(str(node_bin)) < path.index(homebrew_bin)
    assert command_env["npm_config_prefix"] == str(base_root)
    assert command_env["npm_config_cache"] == str(data_home / "node" / "cache")
    assert command_env["npm_config_global"] == "true"
    assert second_env["npm_config_prefix"] == str(base_root)
    assert second_env["NODE_PATH"] == command_env["NODE_PATH"]
    assert base_root.is_dir()
    assert not (tmp_path / "session").exists()
    assert not (tmp_path / "other-session").exists()


def test_workspace_environment_strips_the_daemon_playwright_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("PLAYWRIGHT_NODEJS_PATH", "/daemon/private/node")
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", "/shared/browsers")
    environment = WorkspaceEnvironment(tmp_path / "session")
    environment.prepare()
    command_env = environment.subprocess_env()

    assert "PLAYWRIGHT_NODEJS_PATH" not in command_env
    assert command_env["PLAYWRIGHT_BROWSERS_PATH"] == "/shared/browsers"
