from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


SCRIPT_PATH = (
    Path(__file__).parents[1]
    / "src"
    / "amphi_agent"
    / "builtin_skills"
    / "how-to"
    / "scripts"
    / "sync_skills_index.py"
)


def load_sync_skills_index_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "test_sync_skills_index_module", SCRIPT_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


@pytest.fixture
def sync_index() -> ModuleType:
    return load_sync_skills_index_module()


def test_run_git_distinguishes_missing_executable(
    sync_index: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    def missing_git(*args: object, **kwargs: object) -> None:
        raise FileNotFoundError("git")

    monkeypatch.setattr(sync_index.subprocess, "run", missing_git)

    with pytest.raises(sync_index.GitExecutableNotFoundError) as exc_info:
        sync_index.run_git("status")

    assert "Git executable was not found" in str(exc_info.value)
    assert "sync_skills_index_dulwich.py" in str(exc_info.value)


def test_run_git_distinguishes_timeout_and_command_failure(
    sync_index: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    def timed_out(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(["git", "fetch"], 120)

    monkeypatch.setattr(sync_index.subprocess, "run", timed_out)
    with pytest.raises(sync_index.GitCommandTimeoutError, match="120-second"):
        sync_index.run_git("fetch", timeout_seconds=120)

    failed = subprocess.CompletedProcess(
        ["git", "status"], returncode=128, stdout="", stderr="fatal"
    )
    monkeypatch.setattr(sync_index.subprocess, "run", lambda *args, **kwargs: failed)
    with pytest.raises(sync_index.GitCommandError, match="fatal"):
        sync_index.run_git("status")


def test_repository_check_only_converts_command_failure_to_false(
    sync_index: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repository = tmp_path / "skills-resolution"
    repository.mkdir()

    def invalid_repository(*args: object, **kwargs: object) -> str:
        raise sync_index.GitCommandError("invalid repository")

    monkeypatch.setattr(sync_index, "run_git", invalid_repository)
    assert sync_index.is_expected_repository(repository) is False

    def missing_git(*args: object, **kwargs: object) -> str:
        raise sync_index.GitExecutableNotFoundError("missing Git")

    monkeypatch.setattr(sync_index, "run_git", missing_git)
    with pytest.raises(sync_index.GitExecutableNotFoundError, match="missing Git"):
        sync_index.is_expected_repository(repository)


def test_missing_git_does_not_remove_existing_repository(
    sync_index: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    skills_root = tmp_path / ".bridgic" / "AmphiAgent" / "skills"
    repository = skills_root / sync_index.REPOSITORY_NAME
    repository.mkdir(parents=True)
    marker = repository / "keep-me"
    marker.write_text("existing index", encoding="utf-8")
    monkeypatch.setattr(sync_index.Path, "home", lambda: tmp_path)

    def missing_git(path: Path) -> bool:
        raise sync_index.GitExecutableNotFoundError("missing Git")

    monkeypatch.setattr(sync_index, "is_expected_repository", missing_git)

    with pytest.raises(sync_index.GitExecutableNotFoundError, match="missing Git"):
        sync_index.synchronize()

    assert marker.read_text(encoding="utf-8") == "existing index"


def test_failed_clone_cleans_only_the_partial_clone(
    sync_index: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    skills_root = tmp_path / ".bridgic" / "AmphiAgent" / "skills"
    repository = skills_root / sync_index.REPOSITORY_NAME
    monkeypatch.setattr(sync_index.Path, "home", lambda: tmp_path)

    def failed_clone(path: Path) -> None:
        path.mkdir(parents=True)
        (path / "partial").write_text("partial clone", encoding="utf-8")
        raise sync_index.GitCommandError("clone failed")

    monkeypatch.setattr(sync_index, "clone_repository", failed_clone)
    monkeypatch.setattr(
        sync_index,
        "is_expected_repository",
        lambda path: pytest.fail("partial clone must not be revalidated"),
    )

    with pytest.raises(sync_index.GitCommandError, match="clone failed"):
        sync_index.synchronize()

    assert not repository.exists()
