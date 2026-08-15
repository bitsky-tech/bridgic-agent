#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "dulwich==1.2.12",
# ]
# ///
"""Synchronize the skills-resolution repository with Dulwich."""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dulwich.client import get_transport_and_path
from dulwich.config import ConfigDict, StackedConfig
from dulwich.index import build_index_from_tree
from dulwich.objects import Commit
from dulwich.repo import Repo


REMOTE_URL = "https://github.com/bitsky-tech/skills-resolution"
REPOSITORY_NAME = "skills-resolution"
STATUS_KEY = "skills-resolution"
STATUS_FIELD = "last_successful_sync_at"
UPDATE_INTERVAL = timedelta(hours=6)
GIT_OPERATION_TIMEOUT_SECONDS = 120

HEAD_REF = b"HEAD"
MAIN_REF = b"refs/heads/main"
ORIGIN_MAIN_REF = b"refs/remotes/origin/main"
MAIN_FETCH_REFSPEC = b"+refs/heads/main:refs/remotes/origin/main"
MAIN_REF_PREFIXES = (MAIN_REF,)
RFC3339_UTC_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)


class SyncError(RuntimeError):
    """A synchronization failure with a user-facing diagnostic."""


def canonical_github_repository(url: str) -> str | None:
    """Return a normalized GitHub owner/repository identity."""
    value = url.strip().rstrip("/")
    patterns = (
        r"https?://github\.com/([^/]+/[^/]+)",
        r"ssh://git@github\.com/([^/]+/[^/]+)",
        r"git@github\.com:([^/]+/[^/]+)",
    )
    for pattern in patterns:
        match = re.fullmatch(pattern, value, flags=re.IGNORECASE)
        if match:
            return match.group(1).lower().removesuffix(".git")
    return None


def remote_urls_match(actual: str, expected: str) -> bool:
    """Compare GitHub URLs canonically and other URLs exactly."""
    actual_github = canonical_github_repository(actual)
    expected_github = canonical_github_repository(expected)
    if actual_github is not None or expected_github is not None:
        return actual_github is not None and actual_github == expected_github
    return actual.strip().rstrip("/") == expected.strip().rstrip("/")


def load_status(path: Path) -> tuple[dict[str, Any], datetime | None]:
    """Load the status object and its last valid successful sync time."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}, None
    if not isinstance(value, dict):
        return {}, None

    entry = value.get(STATUS_KEY)
    timestamp = entry.get(STATUS_FIELD) if isinstance(entry, dict) else None
    if (
        not isinstance(timestamp, str)
        or RFC3339_UTC_PATTERN.fullmatch(timestamp) is None
    ):
        return value, None
    try:
        parsed = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError:
        return value, None
    return value, parsed.astimezone(timezone.utc)


def format_utc_timestamp(value: datetime) -> str:
    """Format a datetime as a whole-second UTC RFC 3339 timestamp."""
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def write_status(path: Path, status: dict[str, Any], synced_at: datetime) -> None:
    """Atomically update this task's status while preserving other keys."""
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
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)
        raise SyncError(f"Unable to write the synchronization status: {exc}") from exc


def remove_path(path: Path) -> None:
    """Remove one file, symlink, or directory tree."""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    except OSError as exc:
        raise SyncError(f"Unable to remove the invalid synchronization target: {exc}") from exc


def clear_working_tree(repository: Path) -> None:
    """Remove all working-tree entries while retaining repository metadata."""
    for child in repository.iterdir():
        if child.name != ".git":
            remove_path(child)


def checkout_commit(repository: Path, repo: Repo, commit_id: bytes) -> None:
    """Check out one commit without consulting any external Git configuration."""
    commit = repo[commit_id]
    if not isinstance(commit, Commit):
        raise SyncError("The remote main reference does not point to a commit")

    clear_working_tree(repository)
    build_index_from_tree(
        repo.path,
        repo.index_path(),
        repo.object_store,
        commit.tree,
    )


def configure_origin(repo: Repo, remote_url: str) -> None:
    """Write the repository-local origin metadata used for later validation."""
    config = repo.get_config()
    config.set((b"remote", b"origin"), b"url", remote_url.encode("utf-8"))
    config.set((b"remote", b"origin"), b"fetch", MAIN_FETCH_REFSPEC)
    config.write_to_path()


def select_main_want(
    refs: Mapping[bytes, bytes],
    depth: int | None = None,
) -> list[bytes]:
    """Request only the remote main tip."""
    del depth
    try:
        return [refs[MAIN_REF]]
    except KeyError as exc:
        raise SyncError("The remote repository does not provide a main branch") from exc


def install_main_tip(
    repository: Path,
    repo: Repo,
    main_commit: bytes,
) -> None:
    """Point local and tracking refs at main, retain depth 1, and check it out."""
    repo[main_commit]
    previous_shallow = repo.get_shallow()
    repo.update_shallow({main_commit}, previous_shallow - {main_commit})
    repo.refs[ORIGIN_MAIN_REF] = main_commit
    repo.refs[MAIN_REF] = main_commit
    repo.refs.set_symbolic_ref(HEAD_REF, MAIN_REF)
    checkout_commit(repository, repo, main_commit)


def clone_repository_worker(repository_text: str, remote_url: str) -> None:
    """Clone main at depth 1 using only Dulwich and an empty config backend."""
    repository = Path(repository_text)
    repository.parent.mkdir(parents=True, exist_ok=True)
    client, remote_path = get_transport_and_path(remote_url, config=ConfigDict())
    empty_config = ConfigDict()
    repo = Repo.init(
        str(repository),
        mkdir=True,
        config=StackedConfig([empty_config], writable=empty_config),
        default_branch=b"main",
    )
    try:
        result = client.fetch(
            remote_path,
            repo,
            determine_wants=select_main_want,
            depth=1,
            ref_prefix=MAIN_REF_PREFIXES,
        )
        try:
            main_commit = result.refs[MAIN_REF]
        except KeyError as exc:
            raise SyncError(
                "The remote repository does not provide a main branch"
            ) from exc
        configure_origin(repo, remote_url)
        install_main_tip(repository, repo, main_commit)
    finally:
        repo.close()


def update_repository_worker(repository_text: str, remote_url: str) -> None:
    """Fetch and install only the latest remote main tip at depth 1."""
    repository = Path(repository_text)
    with Repo(str(repository)) as repo:
        client, remote_path = get_transport_and_path(remote_url, config=ConfigDict())
        result = client.fetch(
            remote_path,
            repo,
            determine_wants=select_main_want,
            depth=1,
            ref_prefix=MAIN_REF_PREFIXES,
        )
        try:
            main_commit = result.refs[MAIN_REF]
        except KeyError as exc:
            raise SyncError(
                "The remote repository does not provide a main branch"
            ) from exc
        configure_origin(repo, remote_url)
        install_main_tip(repository, repo, main_commit)


def operation_process_entry(
    connection: Any,
    worker: Callable[..., None],
    arguments: Sequence[str],
) -> None:
    """Run a Dulwich operation in a terminable child process."""
    try:
        worker(*arguments)
    except BaseException as exc:
        try:
            connection.send((False, type(exc).__name__, str(exc)))
        finally:
            connection.close()
        return
    try:
        connection.send((True, "", ""))
    finally:
        connection.close()


def run_remote_operation(
    operation: str,
    worker: Callable[..., None],
    *arguments: str,
) -> None:
    """Run a clone or fetch with a wall-clock timeout."""
    methods = multiprocessing.get_all_start_methods()
    context = multiprocessing.get_context("fork" if "fork" in methods else "spawn")
    receive_connection, send_connection = context.Pipe(duplex=False)
    process = context.Process(
        target=operation_process_entry,
        args=(send_connection, worker, arguments),
        daemon=False,
    )
    process.start()
    send_connection.close()
    process.join(GIT_OPERATION_TIMEOUT_SECONDS)

    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive():
            process.kill()
            process.join()
        receive_connection.close()
        raise SyncError(
            f"{operation} exceeded the {GIT_OPERATION_TIMEOUT_SECONDS}-second "
            "timeout and was terminated"
        )

    result = receive_connection.recv() if receive_connection.poll() else None
    receive_connection.close()
    if result is None:
        raise SyncError(
            f"{operation} failed because the Dulwich worker exited unexpectedly"
        )
    succeeded, error_type, detail = result
    if not succeeded:
        diagnostic = detail.strip() or "No additional diagnostic was provided"
        raise SyncError(f"{operation} failed ({error_type}): {diagnostic}")


def repository_is_expected(
    repository: Path,
    remote_url: str | None = None,
) -> bool:
    """Check repository identity, usability, branch, tracking ref, and depth."""
    expected_remote = REMOTE_URL if remote_url is None else remote_url
    if (
        not repository.is_dir()
        or repository.is_symlink()
        or not (repository / ".git").is_dir()
    ):
        return False
    try:
        with Repo(str(repository)) as repo:
            if repo.bare or not Path(repo.index_path()).is_file():
                return False
            config = repo.get_config()
            configured_remote = config.get(
                (b"remote", b"origin"),
                b"url",
            ).decode("utf-8")
            if not remote_urls_match(configured_remote, expected_remote):
                return False

            ref_chain, head = repo.refs.follow(HEAD_REF)
            if not ref_chain or ref_chain[-1] != MAIN_REF or head is None:
                return False
            if repo.refs[MAIN_REF] != head or repo.refs[ORIGIN_MAIN_REF] != head:
                return False
            if not isinstance(repo[head], Commit):
                return False
            if repo.get_shallow() != {head}:
                return False
            return len(list(repo.get_walker(include=[head], max_entries=2))) == 1
    except (Exception, UnicodeError):
        return False


def verify_latest_main(repository: Path) -> None:
    """Verify the final local main and shallow-depth invariants."""
    if not repository_is_expected(repository):
        raise SyncError(
            "The synchronized repository is not on the verified remote main "
            "commit with shallow depth 1"
        )


def successful_sync_time(requested_now: datetime | None) -> datetime:
    """Use deterministic test time or the actual completion time."""
    if requested_now is not None:
        return requested_now.astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def synchronize(now: datetime | None = None) -> str:
    """Synchronize the fixed repository and return a user-facing action."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    skills_root = Path.home() / ".bridgic" / "AmphiAgent" / "skills"
    repository = skills_root / REPOSITORY_NAME
    status_path = skills_root / "status.json"
    status, last_sync = load_status(status_path)

    existed = repository.exists() or repository.is_symlink()
    valid = repository_is_expected(repository) if existed else False
    if not valid:
        if existed:
            remove_path(repository)
            action = "Rebuilt invalid repository"
        else:
            action = "Initial clone"
        try:
            run_remote_operation(
                "Dulwich clone operation",
                clone_repository_worker,
                str(repository),
                REMOTE_URL,
            )
            verify_latest_main(repository)
            write_status(
                status_path,
                status,
                successful_sync_time(now),
            )
        except Exception:
            if repository.exists() and not repository_is_expected(repository):
                remove_path(repository)
            raise
        return action

    if (
        last_sync is not None
        and last_sync <= current_time
        and current_time - last_sync < UPDATE_INTERVAL
    ):
        return "Skipped update because fewer than 6 hours have elapsed"

    run_remote_operation(
        "Dulwich remote update operation",
        update_repository_worker,
        str(repository),
        REMOTE_URL,
    )
    verify_latest_main(repository)
    write_status(
        status_path,
        status,
        successful_sync_time(now),
    )
    return "Scheduled update"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Synchronize bitsky-tech/skills-resolution to "
            "~/.bridgic/AmphiAgent/skills/ with Dulwich, a 6-hour update "
            "interval, shallow depth 1, and a 120-second timeout for clone "
            "and remote update operations. No Git executable or user Git "
            "configuration is used."
        ),
        epilog="Example: uv run sync_skills_index_dulwich.py",
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
