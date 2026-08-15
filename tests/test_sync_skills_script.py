from __future__ import annotations

import importlib.util
import subprocess
import sys
from datetime import datetime, timezone
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
    / "sync_skills.py"
)


def load_sync_skills_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("test_sync_skills_module", SCRIPT_PATH)
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
def sync_skills() -> ModuleType:
    return load_sync_skills_module()


def test_run_git_distinguishes_missing_executable(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    def missing_git(*args: object, **kwargs: object) -> None:
        raise FileNotFoundError("git")

    monkeypatch.setattr(sync_skills.subprocess, "run", missing_git)

    with pytest.raises(sync_skills.GitExecutableNotFoundError) as exc_info:
        sync_skills.run_git(["status"])

    assert "Git executable was not found" in str(exc_info.value)
    assert "sync_skills_dulwich.py" in str(exc_info.value)


def test_run_git_distinguishes_command_failure(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failed_git(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(128, ["git", "status"], stderr="fatal")

    monkeypatch.setattr(sync_skills.subprocess, "run", failed_git)

    with pytest.raises(sync_skills.GitCommandError, match="fatal"):
        sync_skills.run_git(["status"])


def test_repository_validation_only_converts_command_failure_to_false(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repository = tmp_path / "repository"
    (repository / ".git").mkdir(parents=True)

    def invalid_repository(*args: object, **kwargs: object) -> str:
        raise sync_skills.GitCommandError("invalid repository")

    monkeypatch.setattr(sync_skills, "run_git", invalid_repository)
    assert sync_skills.is_valid_repository(repository) is False

    def missing_git(*args: object, **kwargs: object) -> str:
        raise sync_skills.GitExecutableNotFoundError("missing Git")

    monkeypatch.setattr(sync_skills, "run_git", missing_git)
    with pytest.raises(sync_skills.GitExecutableNotFoundError, match="missing Git"):
        sync_skills.is_valid_repository(repository)


def test_process_repository_reports_git_availability(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repository = tmp_path / "owner" / "repo"
    repository.mkdir(parents=True)
    request = sync_skills.SkillRequest(
        0, sync_skills.SkillSpec("skill", "owner", "repo", "skills/skill")
    )

    def missing_git(path: Path) -> bool:
        raise sync_skills.GitExecutableNotFoundError("missing Git")

    monkeypatch.setattr(sync_skills, "is_valid_repository", missing_git)
    results, changed = sync_skills.process_repository(
        [request], tmp_path, {}, datetime.now(timezone.utc)
    )

    assert changed is False
    assert results[0]["stage"] == "git-availability"
    assert results[0]["reason"] == "missing Git"


def test_process_repository_reports_validation_timeout(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repository = tmp_path / "owner" / "repo"
    repository.mkdir(parents=True)
    request = sync_skills.SkillRequest(
        0, sync_skills.SkillSpec("skill", "owner", "repo", "skills/skill")
    )

    def timed_out(path: Path) -> bool:
        raise sync_skills.GitCommandTimeoutError("Git validation timed out")

    monkeypatch.setattr(sync_skills, "is_valid_repository", timed_out)
    results, changed = sync_skills.process_repository(
        [request], tmp_path, {}, datetime.now(timezone.utc)
    )

    assert changed is False
    assert results[0]["stage"] == "local-repository-validation"
    assert results[0]["reason"] == "Git validation timed out"


def test_restore_only_suppresses_git_command_errors(
    sync_skills: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    request = sync_skills.SkillRequest(
        0, sync_skills.SkillSpec("skill", "owner", "repo", "skills/skill")
    )
    repository = tmp_path / "owner" / "repo"
    repository.mkdir(parents=True)
    monkeypatch.setattr(sync_skills, "is_sparse_checkout", lambda path: False)

    def restore_failed(*args: object, **kwargs: object) -> str:
        raise sync_skills.GitCommandError("path is absent")

    monkeypatch.setattr(sync_skills, "run_git", restore_failed)
    sync_skills.restore_missing_skill_files([request], repository, tmp_path)

    def missing_git(*args: object, **kwargs: object) -> str:
        raise sync_skills.GitExecutableNotFoundError("missing Git")

    monkeypatch.setattr(sync_skills, "run_git", missing_git)
    with pytest.raises(sync_skills.GitExecutableNotFoundError, match="missing Git"):
        sync_skills.restore_missing_skill_files([request], repository, tmp_path)
