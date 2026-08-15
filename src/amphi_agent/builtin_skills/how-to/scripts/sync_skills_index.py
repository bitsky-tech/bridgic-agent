#!/usr/bin/env python3
"""Synchronize the skills-resolution repository into the local skills config."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REMOTE_URL = "https://github.com/bitsky-tech/skills-resolution"
REPOSITORY_NAME = "skills-resolution"
STATUS_KEY = "skills-resolution"
STATUS_FIELD = "last_successful_sync_at"
UPDATE_INTERVAL = timedelta(hours=6)
GIT_OPERATION_TIMEOUT_SECONDS = 120


class SyncError(RuntimeError):
    """A synchronization failure with a user-facing diagnostic."""


class GitError(SyncError):
    """Base error for failures while invoking Git."""


class GitExecutableNotFoundError(GitError):
    """Raised when the Git executable is unavailable."""


class GitCommandError(GitError):
    """Raised when Git starts but the requested command fails."""


class GitCommandTimeoutError(GitError):
    """Raised when a Git command times out."""


def run_git(
    *args: str,
    cwd: Path | None = None,
    timeout_seconds: int | float | None = None,
    operation: str | None = None,
) -> str:
    try:
        git_environment = os.environ.copy()
        git_environment.update({"LANG": "C", "LC_ALL": "C"})
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=False,
            env=git_environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise GitExecutableNotFoundError(
            "Git executable was not found. Install Git or use "
            "sync_skills_index_dulwich.py."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        operation_name = operation or f"Git command git {' '.join(args)}"
        timeout = timeout_seconds if timeout_seconds is not None else exc.timeout
        raise GitCommandTimeoutError(
            f"{operation_name} exceeded the {timeout:g}-second timeout and "
            "was terminated"
        ) from exc
    except OSError as exc:
        raise GitError(f"Unable to run Git: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "Unknown Git error"
        raise GitCommandError(f"Git command failed (git {' '.join(args)}): {detail}")
    return result.stdout.strip()


def canonical_github_repository(url: str) -> str | None:
    value = url.strip().rstrip("/")
    patterns = (
        r"https?://github\.com/([^/]+/[^/]+)",
        r"ssh://git@github\.com/([^/]+/[^/]+)",
        r"git@github\.com:([^/]+/[^/]+)",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, value, flags=re.IGNORECASE)
        if match:
            return match.group(1).removesuffix(".git").lower()
    return None


def expected_repository_id() -> str:
    repository_id = canonical_github_repository(REMOTE_URL)
    if repository_id is None:
        raise SyncError(
            f"The expected remote URL is not a recognizable GitHub repository: "
            f"{REMOTE_URL}"
        )
    return repository_id


def is_expected_repository(repository: Path) -> bool:
    if not repository.is_dir() or repository.is_symlink():
        return False
    try:
        if run_git("rev-parse", "--is-inside-work-tree", cwd=repository) != "true":
            return False
        run_git("rev-parse", "--verify", "HEAD", cwd=repository)
        remote = run_git("remote", "get-url", "origin", cwd=repository)
        is_shallow = run_git("rev-parse", "--is-shallow-repository", cwd=repository)
        commit_count = run_git("rev-list", "--count", "HEAD", cwd=repository)
    except GitCommandError:
        return False
    return (
        canonical_github_repository(remote) == expected_repository_id()
        and is_shallow == "true"
        and commit_count == "1"
    )


def load_status(path: Path) -> tuple[dict[str, Any], datetime | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}, None
    if not isinstance(value, dict):
        return {}, None
    entry = value.get(STATUS_KEY)
    timestamp = entry.get(STATUS_FIELD) if isinstance(entry, dict) else None
    if not isinstance(timestamp, str) or not timestamp.endswith("Z"):
        return value, None
    try:
        parsed = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError:
        return value, None
    if parsed.tzinfo is None:
        return value, None
    return value, parsed.astimezone(timezone.utc)


def format_utc_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def write_status(path: Path, status: dict[str, Any], synced_at: datetime) -> None:
    updated = dict(status)
    updated[STATUS_KEY] = {STATUS_FIELD: format_utc_timestamp(synced_at)}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            json.dump(updated, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
    except (OSError, TypeError) as exc:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        raise SyncError(f"Unable to write status file {path}: {exc}") from exc


def remove_target(path: Path) -> None:
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    except OSError as exc:
        raise SyncError(f"Unable to remove invalid target {path}: {exc}") from exc


def clone_repository(repository: Path) -> None:
    repository.parent.mkdir(parents=True, exist_ok=True)
    run_git(
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        "main",
        REMOTE_URL,
        str(repository),
        timeout_seconds=GIT_OPERATION_TIMEOUT_SECONDS,
        operation="Git clone operation",
    )


def update_to_latest_main(repository: Path) -> None:
    run_git(
        "fetch",
        "--depth",
        "1",
        "origin",
        "+main:refs/remotes/origin/main",
        cwd=repository,
        timeout_seconds=GIT_OPERATION_TIMEOUT_SECONDS,
        operation="Git remote update operation",
    )
    run_git("checkout", "-B", "main", "origin/main", "--force", cwd=repository)
    run_git("reset", "--hard", "origin/main", cwd=repository)


def verify_latest_main(repository: Path) -> None:
    branch = run_git("branch", "--show-current", cwd=repository)
    local_commit = run_git("rev-parse", "HEAD", cwd=repository)
    remote_commit = run_git("rev-parse", "origin/main", cwd=repository)
    is_shallow = run_git("rev-parse", "--is-shallow-repository", cwd=repository)
    commit_count = run_git("rev-list", "--count", "HEAD", cwd=repository)
    if branch != "main":
        raise SyncError(
            f"Repository is not on the main branch after synchronization; "
            f"it is on {branch or 'detached HEAD'}"
        )
    if local_commit != remote_commit:
        raise SyncError(
            "Local commit does not match the latest remote main commit after "
            "synchronization"
        )
    if is_shallow != "true" or commit_count != "1":
        raise SyncError(
            "Repository is not a shallow clone with depth 1 after synchronization"
        )


def synchronize(now: datetime | None = None) -> str:
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    skills_root = Path.home() / ".bridgic" / "AmphiAgent" / "skills"
    repository = skills_root / REPOSITORY_NAME
    status_path = skills_root / "status.json"
    status, last_sync = load_status(status_path)

    existed = repository.exists() or repository.is_symlink()
    valid = is_expected_repository(repository) if existed else False
    if not valid:
        if existed:
            remove_target(repository)
            action = "Rebuilt invalid repository"
        else:
            action = "Initial clone"
        try:
            clone_repository(repository)
            update_to_latest_main(repository)
            verify_latest_main(repository)
            write_status(status_path, status, current_time)
        except Exception:
            if repository.exists() or repository.is_symlink():
                remove_target(repository)
            raise
        return action

    if last_sync is not None and current_time - last_sync < UPDATE_INTERVAL:
        return "Skipped update because fewer than 6 hours have elapsed"

    update_to_latest_main(repository)
    verify_latest_main(repository)
    write_status(status_path, status, current_time)
    return "Scheduled update"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Synchronize bitsky-tech/skills-resolution to "
            "~/.bridgic/AmphiAgent/skills/ with a 6-hour update interval and "
            "a 120-second timeout for clone and remote update operations."
        ),
        epilog="Example: python3 sync_skills_index.py",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    parser.parse_args(argv)
    try:
        action = synchronize()
    except SyncError as exc:
        print(f"Synchronization failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Synchronization failed: {exc}", file=sys.stderr)
        return 1
    print(f"Synchronization result: {action}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
