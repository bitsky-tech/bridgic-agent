#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "dulwich==1.2.12",
# ]
# ///
"""Synchronize GitHub-hosted skills with Dulwich, without invoking Git."""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import shutil
import stat
import sys
import tempfile
import traceback
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dulwich.client import get_transport_and_path
from dulwich.config import ConfigDict, ConfigFile
from dulwich.graph import can_fast_forward
from dulwich.index import (
    Index,
    IndexEntry,
    build_file_from_blob,
    index_entry_from_stat,
    iter_tree_contents,
)
from dulwich.objects import S_ISGITLINK, Blob, Commit
from dulwich.repo import Repo

UPDATE_THRESHOLD = timedelta(hours=6)
REMOTE_OPERATION_TIMEOUT_SECONDS = 120
DEFAULT_CATALOG_ROOT = Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "catalog"
DEFAULT_UPDATE_FILE = (
    Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "skills_update.json"
)
PARTIAL_CLONE_FILTER = "blob:none"


@dataclass(frozen=True)
class SkillSpec:
    name: str
    owner: str
    repo: str
    skill_path: str

    @property
    def key(self) -> str:
        return f"{self.name}|{self.owner}|{self.repo}|{self.skill_path}"

    @property
    def repo_key(self) -> tuple[str, str]:
        return self.owner, self.repo

    @property
    def clone_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}/"

    def repository_path(self, catalog_root: Path) -> Path:
        return catalog_root / self.owner / self.repo

    def local_path(self, catalog_root: Path) -> Path:
        repository = self.repository_path(catalog_root)
        return (
            repository.joinpath(*self.skill_path.split("/"))
            if self.skill_path
            else repository
        )

    def as_tuple(self) -> list[str]:
        return [self.name, self.owner, self.repo, self.skill_path]


@dataclass(frozen=True)
class SkillRequest:
    index: int
    spec: SkillSpec


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Synchronize GitHub skills with Dulwich without invoking a local Git "
            "executable or reading user/system Git configuration."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  uv run sync_skills_dulwich.py --skill pdf owner repo skills/pdf\n"
            "  uv run sync_skills_dulwich.py --skills-file skills.json\n"
            "  uv run sync_skills_dulwich.py --skills "
            '\'[["pdf","owner","repo","skills/pdf"]]\'\n\n'
            "The --skill option may be repeated. Input JSON may be a list of "
            "4-item arrays or objects with keys: name, owner, repo, skill_path."
        ),
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--skills", help="JSON list of skill tuples or skill objects.")
    source.add_argument(
        "--skills-file", help="Path to a JSON file containing the skill list."
    )
    source.add_argument(
        "--skill",
        dest="skill_tuples",
        action="append",
        nargs=4,
        metavar=("NAME", "OWNER", "REPO", "SKILL_PATH"),
        help=(
            "One skill tuple; may be repeated. "
            "Format: --skill NAME OWNER REPO SKILL_PATH."
        ),
    )
    parser.add_argument(
        "--catalog-root",
        default=str(DEFAULT_CATALOG_ROOT),
        help=f"Local catalog root. Default: {DEFAULT_CATALOG_ROOT}",
    )
    parser.add_argument(
        "--update-file",
        default=str(DEFAULT_UPDATE_FILE),
        help=f"Update timestamp JSON file. Default: {DEFAULT_UPDATE_FILE}",
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print JSON output."
    )
    return parser.parse_args()


def load_json_text(args: argparse.Namespace) -> Any:
    if args.skills is not None:
        text = args.skills
    else:
        try:
            text = Path(args.skills_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise ValueError(f"Unable to read skills file: {exc}") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid skills JSON: {exc}") from exc


def normalize_skill(raw: Any, index: int) -> SkillSpec:
    if isinstance(raw, dict):
        missing = [field for field in ("name", "owner", "repo") if field not in raw]
        if missing:
            raise ValueError(f"Skill at index {index} is missing field: {missing[0]}")
        name, owner, repo = raw["name"], raw["owner"], raw["repo"]
        skill_path = raw.get("skill_path", "")
    elif isinstance(raw, (list, tuple)) and len(raw) == 4:
        name, owner, repo, skill_path = raw
    else:
        raise ValueError(
            f"Skill at index {index} must be a 4-item array or an object with "
            "name, owner, repo, skill_path."
        )

    values = {"name": name, "owner": owner, "repo": repo, "skill_path": skill_path}
    for field_name, value in values.items():
        if not isinstance(value, str):
            raise ValueError(
                f"Skill at index {index} has non-string field: {field_name}"
            )
    if not name or not owner or not repo:
        field = next(field for field in ("name", "owner", "repo") if not values[field])
        raise ValueError(f"Skill at index {index} has empty {field}.")
    if (
        any(character in owner or character in repo for character in ("/", "\\", "\0"))
        or owner in {".", ".."}
        or repo in {".", ".."}
    ):
        raise ValueError(f"Skill at index {index} has unsafe owner or repo.")
    if skill_path:
        parts = skill_path.split("/")
        if (
            skill_path.startswith("/")
            or skill_path.endswith("/")
            or any(part in {"", ".", ".."} for part in parts)
            or "\\" in skill_path
            or "\0" in skill_path
        ):
            raise ValueError(f"Skill at index {index} has unsafe skill_path.")
    return SkillSpec(name=name, owner=owner, repo=repo, skill_path=skill_path)


def load_skills(args: argparse.Namespace) -> list[SkillRequest]:
    raw = args.skill_tuples if args.skill_tuples is not None else load_json_text(args)
    if not isinstance(raw, list):
        raise ValueError("Skills input must be a list.")
    return [
        SkillRequest(index, normalize_skill(item, index))
        for index, item in enumerate(raw)
    ]


def group_by_repository(
    requests: Iterable[SkillRequest],
) -> dict[tuple[str, str], list[SkillRequest]]:
    groups: dict[tuple[str, str], list[SkillRequest]] = {}
    for request in requests:
        groups.setdefault(request.spec.repo_key, []).append(request)
    return groups


def load_update_data(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"Unable to read update file: {exc}") from exc
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Update file is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Update file must contain a JSON object.")
    return data


def write_update_data(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(data, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def should_update(record: Any, current_time: datetime) -> bool:
    if not isinstance(record, dict):
        return True
    last_checked_at = parse_iso_datetime(record.get("last_checked_at"))
    if last_checked_at is None:
        return True
    return current_time - last_checked_at > UPDATE_THRESHOLD


def is_lexically_under(path: Path, parent: Path) -> bool:
    try:
        absolute_path = path.absolute()
        absolute_parent = parent.absolute()
        return absolute_path != absolute_parent and absolute_path.is_relative_to(
            absolute_parent
        )
    except (OSError, ValueError):
        return False


def remove_repository(path: Path, catalog_root: Path) -> None:
    if not is_lexically_under(path, catalog_root):
        raise RuntimeError(f"Refusing to remove path outside catalog root: {path}")
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _reject_config_include(_path: str | os.PathLike[str]):
    raise OSError("External Git config includes are disabled.")


def read_config_file(config_path: Path, *, required: bool = True) -> ConfigFile:
    if not config_path.exists() and not required:
        config = ConfigFile()
        config.path = str(config_path)
        return config
    try:
        with config_path.open("rb") as config_file:
            config = ConfigFile.from_file(
                config_file,
                config_dir=str(config_path.parent),
                file_opener=_reject_config_include,
            )
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"Unable to read repository config {config_path}: {exc}"
        ) from exc
    include_sections = [
        section
        for section in config.sections()
        if section and section[0].lower() in {b"include", b"includeif"}
    ]
    if include_sections:
        raise RuntimeError(
            "Repository config contains include/includeIf directives; external Git "
            "configuration is not allowed."
        )
    config.path = str(config_path)
    return config


def read_repository_config(path: Path) -> ConfigFile:
    return read_config_file(path / ".git" / "config")


def read_repository_worktree_config(path: Path) -> ConfigFile:
    return read_config_file(path / ".git" / "config.worktree", required=False)


def uses_worktree_config(config: ConfigFile) -> bool:
    return config_boolean(config, (b"extensions",), b"worktreeConfig")


def open_valid_repository(path: Path) -> Repo:
    if not path.is_dir() or not (path / ".git").is_dir():
        raise RuntimeError(f"Local repository is not a valid Git repository: {path}")
    try:
        config = read_repository_config(path)
        if uses_worktree_config(config):
            read_repository_worktree_config(path)
        repository = Repo(str(path))
        repository.head()
        return repository
    except Exception as exc:
        raise RuntimeError(
            f"Local repository is not a valid Git repository: {path}: {exc}"
        ) from exc


def local_config(repository: Repo) -> ConfigFile:
    """Return only .git/config; never construct Dulwich's global config stack."""
    return read_repository_config(Path(repository.path))


def config_boolean(config: ConfigFile, section: tuple[bytes, ...], name: bytes) -> bool:
    try:
        return bool(config.get_boolean(section, name))
    except KeyError:
        return False


def optional_config_boolean(
    config: ConfigFile, section: tuple[bytes, ...], name: bytes
) -> bool | None:
    try:
        return config.get_boolean(section, name)
    except KeyError:
        return None


def sparse_config(repository: Repo) -> ConfigFile:
    config = local_config(repository)
    if uses_worktree_config(config):
        return read_repository_worktree_config(Path(repository.path))
    return config


def is_sparse_checkout(repository: Repo) -> bool:
    config = local_config(repository)
    if uses_worktree_config(config):
        worktree_value = optional_config_boolean(
            read_repository_worktree_config(Path(repository.path)),
            (b"core",),
            b"sparseCheckout",
        )
        if worktree_value is not None:
            return worktree_value
    return config_boolean(config, (b"core",), b"sparseCheckout")


def is_partial_clone(repository: Repo) -> bool:
    return config_boolean(local_config(repository), (b"remote", b"origin"), b"promisor")


def configure_partial_clone(repository: Repo) -> None:
    config = local_config(repository)
    config.set((b"remote", b"origin"), b"promisor", True)
    config.set(
        (b"remote", b"origin"),
        b"partialCloneFilter",
        PARTIAL_CLONE_FILTER.encode("ascii"),
    )
    config.write_to_path()


def configure_single_branch(repository: Repo, branch_ref: bytes) -> None:
    branch_prefix = b"refs/heads/"
    if not branch_ref.startswith(branch_prefix):
        raise RuntimeError(
            f"Remote default branch is not under refs/heads/: {branch_ref!r}"
        )
    short_branch = branch_ref.removeprefix(branch_prefix)
    config = local_config(repository)
    config.set(
        (b"remote", b"origin"),
        b"fetch",
        b"+" + branch_ref + b":refs/remotes/origin/" + short_branch,
    )
    config.write_to_path()


def requested_sparse_paths(requests: Iterable[SkillRequest]) -> list[str]:
    return sorted(
        {request.spec.skill_path for request in requests if request.spec.skill_path}
    )


def needs_full_checkout(requests: Iterable[SkillRequest]) -> bool:
    return any(not request.spec.skill_path for request in requests)


def read_existing_sparse_paths(repository: Repo) -> list[str]:
    patterns = repository.get_worktree().get_sparse_checkout_patterns()
    if patterns is None:
        raise RuntimeError(
            "Sparse checkout is enabled but its pattern file is missing."
        )
    negative_ancestor_patterns = {
        pattern[2:-3]
        for pattern in patterns
        if pattern.startswith("!/")
        and pattern.endswith("/*/")
        and "*" not in pattern[2:-3]
    }
    paths: set[str] = set()
    for pattern in patterns:
        if (
            pattern.startswith("/")
            and pattern.endswith("/")
            and not pattern.startswith("!/")
            and "*" not in pattern
        ):
            path = pattern.strip("/")
            if path and path not in negative_ancestor_patterns:
                paths.add(path)
    return sorted(paths)


def selected_sparse_paths(
    repository: Repo, requested: Sequence[str]
) -> list[str] | None:
    if not is_sparse_checkout(repository):
        return None
    return sorted(set(read_existing_sparse_paths(repository)).union(requested))


def _head_branch_ref(repository: Repo) -> bytes:
    chain, _sha = repository.refs.follow(b"HEAD")
    if len(chain) < 2 or not chain[-1].startswith(b"refs/heads/"):
        raise RuntimeError(
            "The repository HEAD is detached or does not name a local branch."
        )
    return bytes(chain[-1])


def _isolated_transport(
    url: str,
    *,
    operation: str = "pull",
    thin_packs: bool = True,
):
    """Build a transport with an empty config, excluding user/system Git config."""
    return get_transport_and_path(
        url,
        config=ConfigDict(),
        operation=operation,
        thin_packs=thin_packs,
    )


def _remote_default_branch(client: Any, remote_path: str) -> bytes:
    advertised = client.get_refs(
        remote_path,
        protocol_version=2,
        ref_prefix=[b"HEAD"],
    )
    branch_ref = advertised.symrefs.get(b"HEAD")
    if branch_ref is None:
        raise RuntimeError("Remote HEAD does not advertise a default branch.")
    branch_ref = bytes(branch_ref)
    if not branch_ref.startswith(b"refs/heads/"):
        raise RuntimeError(
            f"Remote HEAD does not point to a branch under refs/heads/: {branch_ref!r}"
        )
    return branch_ref


def _fetch_remote_branch(
    repository: Repo,
    url: str,
    filter_spec: str | None,
) -> tuple[bytes, bytes, bytes]:
    branch_ref = _head_branch_ref(repository)
    old_head = repository.head()
    wanted_ref: dict[str, bytes] = {}

    def determine_wants(
        remote_refs: dict[bytes, bytes], depth: int | None = None
    ) -> list[bytes]:
        del depth
        remote_head = remote_refs.get(branch_ref) or remote_refs.get(b"HEAD")
        if remote_head is None:
            raise RuntimeError(
                f"Remote does not advertise the checked-out branch {branch_ref.decode()}."
            )
        wanted_ref["sha"] = remote_head
        return [] if remote_head == old_head else [remote_head]

    class IncrementalGraphWalker:
        """Keep incremental haves without advertising the shallow boundary."""

        def __init__(self) -> None:
            self._walker = repository.get_graph_walker()
            # Dulwich 1.2.12 stops after Git protocol-v2's shallow-info
            # section instead of continuing to the following packfile. The
            # existing walker still stops at the repository's real shallow
            # boundary; only the transport-facing declaration is suppressed.
            self.shallow: set[bytes] = set()

        def __next__(self) -> bytes | None:
            return next(self._walker)

        def ack(self, sha: bytes) -> None:
            self._walker.ack(sha)

        def nak(self) -> None:
            self._walker.nak()

    # A partial repository may not contain a delta base selected for a thin
    # pack. Request a self-contained pack while retaining the normal `have`
    # negotiation so branch updates remain incremental.
    client, remote_path = _isolated_transport(url, thin_packs=False)
    pack_file, commit_pack, abort_pack = repository.object_store.add_pack()
    try:
        result = client.fetch_pack(
            remote_path,
            determine_wants,
            IncrementalGraphWalker(),
            pack_file.write,
            filter_spec=filter_spec.encode("ascii") if filter_spec else None,
            protocol_version=2,
        )
    except BaseException:
        abort_pack()
        raise
    if pack_file.tell():
        commit_pack()
    else:
        abort_pack()
    repository.update_shallow(result.new_shallow, result.new_unshallow)

    new_head = wanted_ref.get("sha")
    if new_head is None:
        new_head = result.refs.get(branch_ref) or result.refs.get(b"HEAD")
    if new_head is None:
        raise RuntimeError("Unable to determine the remote branch tip.")
    if new_head != old_head and new_head not in repository.object_store:
        raise RuntimeError(
            "Remote did not provide the advertised branch tip object: "
            f"{new_head.decode('ascii')}."
        )
    if new_head != old_head and not can_fast_forward(repository, old_head, new_head):
        raise RuntimeError("Remote update is not a fast-forward of the local branch.")
    return branch_ref, old_head, new_head


def _fetch_objects(repository: Repo, url: str, object_ids: Iterable[bytes]) -> None:
    missing = sorted(
        {
            object_id
            for object_id in object_ids
            if object_id not in repository.object_store
        }
    )
    if not missing:
        return

    def determine_wants(
        remote_refs: dict[bytes, bytes], depth: int | None = None
    ) -> list[bytes]:
        del remote_refs, depth
        return missing

    class NoHaveGraphWalker:
        """Negotiate promised objects without claiming complete HEAD contents."""

        shallow: set[bytes] = set()

        def __next__(self) -> None:
            return None

        def ack(self, sha: bytes) -> None:
            del sha

    # A normal repository graph walker advertises the branch tip as `have`.
    # That is incorrect for a promisor repository: the requested blobs are
    # reachable from HEAD but intentionally absent. Disable thin packs and
    # negotiate with no `have` lines so the server sends complete blob objects.
    client, remote_path = _isolated_transport(url, thin_packs=False)
    pack_file, commit_pack, abort_pack = repository.object_store.add_pack()
    try:
        result = client.fetch_pack(
            remote_path,
            determine_wants,
            NoHaveGraphWalker(),
            pack_file.write,
            protocol_version=2,
        )
    except BaseException:
        abort_pack()
        raise
    else:
        commit_pack()
    repository.update_shallow(result.new_shallow, result.new_unshallow)
    still_missing = [
        object_id.decode("ascii")
        for object_id in missing
        if object_id not in repository.object_store
    ]
    if still_missing:
        raise RuntimeError(
            "Remote did not provide required checkout objects: "
            + ", ".join(still_missing)
        )


def _path_is_in_sparse_cone(path: str, selected_directories: Sequence[str]) -> bool:
    if "/" not in path:
        return True
    parent = path.rsplit("/", 1)[0]
    for directory in selected_directories:
        if path == directory or path.startswith(directory + "/"):
            return True
        ancestor = directory
        while "/" in ancestor:
            ancestor = ancestor.rsplit("/", 1)[0]
            if parent == ancestor:
                return True
    return False


def _remove_tracked_path(root: Path, relative_path: bytes) -> None:
    full_path = os.path.join(os.fsencode(root), relative_path)
    try:
        mode = os.lstat(full_path).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode) and not stat.S_ISLNK(mode):
        try:
            os.rmdir(full_path)
        except OSError:
            return
    else:
        os.unlink(full_path)


def _remove_empty_parents(root: Path, relative_path: bytes) -> None:
    root_bytes = os.fsencode(root)
    parent = os.path.dirname(os.path.join(root_bytes, relative_path))
    while parent != root_bytes and parent.startswith(root_bytes + os.sep.encode()):
        try:
            os.rmdir(parent)
        except OSError:
            break
        parent = os.path.dirname(parent)


def _materialize_checkout(
    repository: Repo,
    url: str,
    selected_directories: Sequence[str] | None,
) -> None:
    commit = repository[repository.head()]
    if not isinstance(commit, Commit):
        raise RuntimeError("Repository HEAD does not point to a commit.")
    entries = list(iter_tree_contents(repository.object_store, commit.tree))
    included: dict[bytes, bool] = {}
    for entry in entries:
        assert entry.path is not None
        decoded_path = entry.path.decode("utf-8", "surrogateescape")
        included[entry.path] = (
            True
            if selected_directories is None
            else _path_is_in_sparse_cone(decoded_path, selected_directories)
        )

    required_objects = [
        entry.sha
        for entry in entries
        if entry.path is not None
        and entry.sha is not None
        and included[entry.path]
        and not S_ISGITLINK(entry.mode or 0)
    ]
    _fetch_objects(repository, url, required_objects)

    try:
        old_index = repository.open_index()
        old_paths = list(old_index)
    except Exception:
        old_paths = []
    new_paths = {entry.path for entry in entries if entry.path is not None}
    for old_path in old_paths:
        if old_path not in new_paths or not included.get(old_path, False):
            _remove_tracked_path(Path(repository.path), old_path)
            _remove_empty_parents(Path(repository.path), old_path)

    index = Index(repository.index_path(), read=False)
    root_bytes = os.fsencode(repository.path)
    for entry in entries:
        assert (
            entry.path is not None and entry.mode is not None and entry.sha is not None
        )
        if included[entry.path]:
            full_path = os.path.join(root_bytes, entry.path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            if S_ISGITLINK(entry.mode):
                os.makedirs(full_path, exist_ok=True)
                file_stat = os.lstat(full_path)
            else:
                blob = repository.object_store[entry.sha]
                if not isinstance(blob, Blob):
                    raise RuntimeError(
                        f"Checkout object for {entry.path!r} is not a blob."
                    )
                file_stat = build_file_from_blob(blob, entry.mode, full_path)
            index[entry.path] = index_entry_from_stat(
                file_stat, entry.sha, mode=entry.mode
            )
        else:
            index_entry = IndexEntry(
                ctime=0,
                mtime=0,
                dev=0,
                ino=0,
                mode=entry.mode,
                uid=0,
                gid=0,
                size=0,
                sha=entry.sha,
            )
            index_entry.set_skip_worktree(True)
            index[entry.path] = index_entry
    index.write()

    config = sparse_config(repository)
    sparse_file = Path(repository.commondir()) / "info" / "sparse-checkout"
    if selected_directories is None:
        config.set((b"core",), b"sparseCheckout", False)
        config.set((b"core",), b"sparseCheckoutCone", False)
        try:
            sparse_file.unlink()
        except FileNotFoundError:
            pass
    else:
        config.set((b"core",), b"sparseCheckout", True)
        config.set((b"core",), b"sparseCheckoutCone", True)
        repository.get_worktree().set_cone_mode_patterns(selected_directories)
    config.write_to_path()


def _clone_remote(
    url: str,
    target: str,
    selected_directories: Sequence[str] | None,
) -> None:
    client, remote_path = _isolated_transport(url, operation="clone")
    branch_ref = _remote_default_branch(client, remote_path)
    short_branch = branch_ref.removeprefix(b"refs/heads/")
    repository = client.clone(
        remote_path,
        target,
        depth=1,
        checkout=selected_directories is None,
        branch=short_branch.decode("utf-8"),
        ref_prefix=[b"HEAD", branch_ref],
        filter_spec=(
            PARTIAL_CLONE_FILTER.encode("ascii")
            if selected_directories is not None
            else None
        ),
        protocol_version=2,
        progress=sys.stderr.buffer.write,
    )
    try:
        configure_single_branch(repository, branch_ref)
        if selected_directories is not None:
            configure_partial_clone(repository)
            _materialize_checkout(repository, url, selected_directories)
        if not repository.get_shallow():
            raise RuntimeError("Dulwich did not create a shallow repository.")
    finally:
        repository.close()


def _pull_remote(
    url: str,
    target: str,
    selected_directories: Sequence[str] | None,
) -> None:
    repository = open_valid_repository(Path(target))
    try:
        partial = is_partial_clone(repository)
        branch_ref, old_head, new_head = _fetch_remote_branch(
            repository,
            url,
            PARTIAL_CLONE_FILTER if partial else None,
        )
        if new_head != old_head:
            repository.refs[branch_ref] = new_head
            short_branch = branch_ref.removeprefix(b"refs/heads/")
            repository.refs[b"refs/remotes/origin/" + short_branch] = new_head
        _materialize_checkout(repository, url, selected_directories)
    finally:
        repository.close()


def _remote_worker(
    connection: multiprocessing.connection.Connection,
    operation: str,
    url: str,
    target: str,
    selected_directories: Sequence[str] | None,
) -> None:
    try:
        if operation == "clone":
            _clone_remote(url, target, selected_directories)
        elif operation == "pull":
            _pull_remote(url, target, selected_directories)
        else:
            raise RuntimeError(f"Unsupported remote operation: {operation}")
        connection.send({"ok": True})
    except BaseException as exc:
        connection.send(
            {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            }
        )
    finally:
        connection.close()


def run_remote_operation(
    operation: str,
    url: str,
    target: Path,
    selected_directories: Sequence[str] | None,
) -> None:
    context = multiprocessing.get_context("spawn")
    parent_connection, child_connection = context.Pipe(duplex=False)
    process = context.Process(
        target=_remote_worker,
        args=(child_connection, operation, url, str(target), selected_directories),
    )
    process.start()
    child_connection.close()
    process.join(REMOTE_OPERATION_TIMEOUT_SECONDS)
    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive():
            process.kill()
            process.join()
        parent_connection.close()
        raise RuntimeError(
            f"Dulwich {operation} operation timed out after "
            f"{REMOTE_OPERATION_TIMEOUT_SECONDS} seconds."
        )
    message = parent_connection.recv() if parent_connection.poll() else None
    parent_connection.close()
    if not message:
        raise RuntimeError(
            f"Dulwich {operation} worker exited without a result "
            f"(exit code {process.exitcode})."
        )
    if not message["ok"]:
        raise RuntimeError(message["error"])


def clone_repository(
    requests: list[SkillRequest],
    repository_path: Path,
    catalog_root: Path,
) -> None:
    if not is_lexically_under(repository_path, catalog_root):
        raise RuntimeError(
            f"Local repository path is outside catalog root: {repository_path}"
        )
    repository_path.parent.mkdir(parents=True, exist_ok=True)
    selected = (
        None if needs_full_checkout(requests) else requested_sparse_paths(requests)
    )
    try:
        run_remote_operation(
            "clone", requests[0].spec.clone_url, repository_path, selected
        )
        repository = open_valid_repository(repository_path)
        repository.close()
    except Exception as exc:
        try:
            remove_repository(repository_path, catalog_root)
        except Exception as cleanup_exc:
            raise RuntimeError(f"{exc}; cleanup failed: {cleanup_exc}") from exc
        raise


def parse_front_matter_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Unable to parse a quoted front matter value.") from exc
        return parsed if isinstance(parsed, str) else str(parsed)
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    for index, character in enumerate(value):
        if character == "#" and index > 0 and value[index - 1].isspace():
            return value[:index].rstrip()
    return value


def parse_block_scalar(lines: list[str], folded: bool) -> str:
    non_empty_indents = [
        len(line) - len(line.lstrip()) for line in lines if line.strip()
    ]
    indent = min(non_empty_indents) if non_empty_indents else 0
    normalized = [line[indent:] if line.strip() else "" for line in lines]
    if not folded:
        return "\n".join(normalized)
    paragraphs: list[str] = []
    current: list[str] = []
    for line in normalized:
        if line:
            current.append(line)
        else:
            if current:
                paragraphs.append(" ".join(current))
                current = []
            paragraphs.append("")
    if current:
        paragraphs.append(" ".join(current))
    return "\n".join(paragraphs)


def read_skill_metadata(skill_file: Path) -> dict[str, str]:
    try:
        lines = skill_file.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(f"Unable to read SKILL.md: {exc}") from exc
    if not lines or lines[0].strip() != "---":
        raise RuntimeError("SKILL.md does not start with front matter.")
    try:
        end_index = next(
            index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"
        )
    except StopIteration as exc:
        raise RuntimeError("SKILL.md front matter is not closed.") from exc

    front_matter = lines[1:end_index]
    metadata: dict[str, str] = {}
    index = 0
    while index < len(front_matter):
        line = front_matter[index]
        if not line.strip() or line.lstrip().startswith("#") or line[:1].isspace():
            index += 1
            continue
        if ":" not in line:
            raise RuntimeError(
                f"Unable to parse SKILL.md front matter at line {index + 2}."
            )
        key, raw_value = line.split(":", 1)
        key = key.strip()
        if not key:
            raise RuntimeError(
                f"Unable to parse SKILL.md front matter at line {index + 2}."
            )
        if key in metadata:
            raise RuntimeError(f"SKILL.md front matter contains duplicate field: {key}")
        raw_value = raw_value.strip()
        if raw_value in {"|", "|-", "|+", ">", ">-", ">+"}:
            block_lines: list[str] = []
            index += 1
            while index < len(front_matter):
                block_line = front_matter[index]
                if block_line and not block_line[:1].isspace():
                    break
                block_lines.append(block_line)
                index += 1
            metadata[key] = parse_block_scalar(
                block_lines, folded=raw_value.startswith(">")
            )
            continue
        metadata[key] = parse_front_matter_scalar(raw_value)
        index += 1
    return metadata


def validate_skill(skill: SkillSpec, catalog_root: Path) -> dict[str, str]:
    skill_file = skill.local_path(catalog_root) / "SKILL.md"
    if not skill_file.is_file():
        raise RuntimeError(
            f"Local skill path does not contain SKILL.md: {skill.local_path(catalog_root)}"
        )
    metadata = read_skill_metadata(skill_file)
    actual_name = metadata.get("name")
    if actual_name != skill.name:
        raise RuntimeError(
            f"SKILL.md name mismatch: expected {skill.name!r}, got {actual_name!r}."
        )
    if "description" not in metadata:
        raise RuntimeError("SKILL.md front matter does not contain description.")
    return metadata


def update_record(
    update_data: dict[str, Any],
    skill: SkillSpec,
    checked_at: str,
    synced_at: str | None,
) -> None:
    existing = update_data.get(skill.key)
    previous_synced_at = (
        existing.get("last_synced_at") if isinstance(existing, dict) else ""
    )
    if not isinstance(previous_synced_at, str):
        previous_synced_at = ""
    update_data[skill.key] = {
        "last_checked_at": checked_at,
        "last_synced_at": synced_at if synced_at is not None else previous_synced_at,
    }


def success_result(
    skill: SkillSpec,
    status: str,
    metadata: dict[str, str],
    local_path: Path,
) -> dict[str, Any]:
    return {
        "skill": skill.as_tuple(),
        "status": status,
        "name": metadata["name"],
        "description": metadata["description"],
        "local_path": str(local_path),
    }


def failure_result(skill: SkillSpec, stage: str, reason: str) -> dict[str, Any]:
    return {
        "skill": skill.as_tuple(),
        "status": "failed",
        "stage": stage,
        "reason": reason,
    }


def fail_group(
    requests: Iterable[SkillRequest], stage: str, reason: str
) -> dict[int, dict[str, Any]]:
    return {
        request.index: failure_result(request.spec, stage, reason)
        for request in requests
    }


def process_repository(
    requests: list[SkillRequest],
    catalog_root: Path,
    update_data: dict[str, Any],
    current_time: datetime,
) -> tuple[dict[int, dict[str, Any]], bool]:
    repository_path = requests[0].spec.repository_path(catalog_root)
    repository_existed = repository_path.exists() or repository_path.is_symlink()
    newly_cloned = False
    remotely_synchronized = False
    status = "local-check-passed"

    if repository_existed:
        try:
            repository = open_valid_repository(repository_path)
        except Exception as exc:
            return fail_group(requests, "local-repository-validation", str(exc)), False
        try:
            sparse_enabled = is_sparse_checkout(repository)
            existing_sparse_paths = (
                read_existing_sparse_paths(repository) if sparse_enabled else []
            )
            if needs_full_checkout(requests):
                selected_directories = None
            elif sparse_enabled:
                selected_directories = sorted(
                    set(existing_sparse_paths).union(requested_sparse_paths(requests))
                )
            else:
                selected_directories = None
            checkout_adjustment_needed = sparse_enabled and (
                needs_full_checkout(requests)
                or not set(requested_sparse_paths(requests)).issubset(
                    existing_sparse_paths
                )
            )
        except Exception as exc:
            repository.close()
            return fail_group(requests, "checkout-adjustment", str(exc)), False
        repository.close()
    else:
        selected_directories = (
            None if needs_full_checkout(requests) else requested_sparse_paths(requests)
        )
        try:
            clone_repository(requests, repository_path, catalog_root)
        except Exception as exc:
            return fail_group(requests, "clone", str(exc)), False
        newly_cloned = True
        remotely_synchronized = True
        status = "newly-synchronized"

    if repository_existed:
        missing = [
            request
            for request in requests
            if not (request.spec.local_path(catalog_root) / "SKILL.md").is_file()
        ]
        update_needed = (
            checkout_adjustment_needed
            or bool(missing)
            or any(
                should_update(update_data.get(request.spec.key), current_time)
                for request in requests
            )
        )
        if update_needed:
            try:
                run_remote_operation(
                    "pull",
                    requests[0].spec.clone_url,
                    repository_path,
                    selected_directories,
                )
            except Exception as exc:
                return fail_group(requests, "update", str(exc)), False
            remotely_synchronized = True
            status = "updated"

    metadata_by_index: dict[int, dict[str, str]] = {}
    validation_errors: dict[int, str] = {}
    for request in requests:
        try:
            metadata_by_index[request.index] = validate_skill(
                request.spec, catalog_root
            )
        except Exception as exc:
            validation_errors[request.index] = str(exc)

    if validation_errors and newly_cloned and len(validation_errors) == len(requests):
        cleanup_suffix = ""
        try:
            remove_repository(repository_path, catalog_root)
        except Exception as cleanup_exc:
            cleanup_suffix = f"; cleanup failed: {cleanup_exc}"
        return {
            request.index: failure_result(
                request.spec,
                "metadata-validation",
                validation_errors[request.index] + cleanup_suffix,
            )
            for request in requests
        }, False

    checked_at = current_time.isoformat()
    results: dict[int, dict[str, Any]] = {}
    records_changed = False
    for request in requests:
        if request.index in validation_errors:
            results[request.index] = failure_result(
                request.spec,
                "metadata-validation",
                validation_errors[request.index],
            )
            continue
        metadata = metadata_by_index[request.index]
        update_record(
            update_data,
            request.spec,
            checked_at=checked_at,
            synced_at=checked_at if remotely_synchronized else None,
        )
        records_changed = True
        results[request.index] = success_result(
            request.spec,
            status,
            metadata,
            request.spec.local_path(catalog_root),
        )
    return results, records_changed


def main() -> int:
    args = parse_args()
    try:
        requests = load_skills(args)
        catalog_root = Path(args.catalog_root).expanduser()
        update_file = Path(args.update_file).expanduser()
        update_file_existed = update_file.exists()
        update_data = load_update_data(update_file)
    except ValueError as exc:
        print(
            json.dumps({"status": "failed", "reason": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    current_time = datetime.now(timezone.utc)
    results_by_index: dict[int, dict[str, Any]] = {}
    records_changed = False
    for repository_requests in group_by_repository(requests).values():
        repository_results, repository_records_changed = process_repository(
            repository_requests, catalog_root, update_data, current_time
        )
        results_by_index.update(repository_results)
        records_changed = records_changed or repository_records_changed

    if records_changed or not update_file_existed:
        try:
            write_update_data(update_file, update_data)
        except OSError as exc:
            print(
                json.dumps(
                    {
                        "status": "failed",
                        "reason": f"Unable to write update file: {exc}",
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            return 2

    results = [results_by_index[request.index] for request in requests]
    has_failure = any(result.get("status") == "failed" for result in results)
    output = {"status": "failed" if has_failure else "succeeded", "results": results}
    print(json.dumps(output, ensure_ascii=False, indent=2 if args.pretty else None))
    return 1 if has_failure else 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
