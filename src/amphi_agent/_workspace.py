from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import tempfile
import threading
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, Iterable, List, Literal, Mapping, Optional, Sequence
from uuid import uuid4

from dulwich import porcelain
from dulwich.objects import Blob, Tree
from dulwich.patch import parse_unified_diff
from dulwich.repo import Repo
from filelock import FileLock
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..amphi_store import SessionMountRecord, UserInput
from .runtime._environment import AppEnvironmentStatus, WorkspaceEnvironment

SESSIONS_ROOT_ENV_VAR = "BRIDGIC_AGENT_SESSIONS_ROOT"
WORK_DIR_NAME = ".work"
BUILD_DIR_NAME = ".build"
WORKFLOW_RUN_DIR_NAME = ".run"
INTERNAL_DIR_NAME = ".internal"
TOOL_RESULT_DIR_NAME = "tool_results"
PERMISSION_DIR_NAME = "permissions"
BUILD_STATE_FILE_NAME = ".state.json"
RUN_WORKFLOW_STATE_FILE_NAME = ".state.json"
WORKSPACE_INITIALIZATION_LOCK_NAME = ".workspace-init.lock"

# Shows up as the author/committer of every workspace checkpoint, i.e. it is
# visible to the user in `git log`. Only affects commits made from here on;
# checkpoints written before the 2026-08 rename keep the old author.
CHECKPOINT_AUTHOR = b"Bridgic Agent Workspace <workspace@bridgic.local>"
INITIAL_CHECKPOINT_MESSAGE = "Initial workspace"
MAX_DIFF_CHARS = 30_000
_IS_WINDOWS = os.name == "nt"

DEFAULT_GITIGNORE_LINES = (
    ".venv/",
    "node_modules/",
    ".internal/",
    WORKSPACE_INITIALIZATION_LOCK_NAME,
    "_msg_debug",
    "history.md",
    "history.md.tmp",
    f"{WORK_DIR_NAME}/{WORKFLOW_RUN_DIR_NAME}/",
    "__pycache__/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    ".DS_Store",
    "*.log",
)


class BuildState(BaseModel):
    """Durable state for the Session's single unfinished Build."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    stage: Literal["clarify", "explore", "generate", "verify"] = "clarify"
    workflow_id: Optional[str] = None
    acceptance_contract: Optional[dict[str, str]] = None
    edit_task_baseline: Optional[str] = None
    last_task_confirmation: Optional[dict[str, str]] = None

    @field_validator("acceptance_contract", mode="before")
    @classmethod
    def _validate_acceptance_contract(
        cls,
        value: object,
    ) -> Optional[dict[str, str]]:
        """Retain only the one-time review identity from old or new state."""
        if value is None:
            return None
        if not isinstance(value, Mapping):
            raise ValueError("Build acceptance contract is invalid")
        request_id = value.get("request_id")
        if not isinstance(request_id, str) or not request_id.strip():
            raise ValueError("Build acceptance contract request id is invalid")
        return {"request_id": request_id}

    @field_validator("workflow_id")
    @classmethod
    def _validate_workflow_id(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not value.strip():
            raise ValueError("Build workflow_id must be non-empty")
        return value

    @field_validator("edit_task_baseline")
    @classmethod
    def _validate_edit_task_baseline(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not value.strip():
            raise ValueError("Build edit_task_baseline must be non-empty")
        return value

    @field_validator("last_task_confirmation")
    @classmethod
    def _validate_last_task_confirmation(
        cls,
        value: Optional[dict[str, str]],
    ) -> Optional[dict[str, str]]:
        if value is None:
            return None
        request_id = value.get("request_id")
        task_markdown = value.get("task_markdown")
        if (
            not isinstance(request_id, str)
            or not request_id
            or not isinstance(task_markdown, str)
            or not task_markdown.strip()
        ):
            raise ValueError("Build last_task_confirmation is invalid")
        return {"request_id": request_id, "task_markdown": task_markdown}


class RunWorkflowState(BaseModel):
    """Durable identity, input, and cursor for one active Workflow Run."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    workflow_id: str
    generation: str
    workflow_name: str
    workflow_input: UserInput
    stage: Literal["execute", "validate"] = "execute"
    step_index: int = Field(default=0, ge=0)

    @field_validator("workflow_id", "generation", "workflow_name")
    @classmethod
    def _validate_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Run Workflow identity fields must be non-empty")
        return value

    @field_validator("step_index")
    @classmethod
    def _validate_step_index(cls, value: int) -> int:
        if isinstance(value, bool):
            raise ValueError("Run Workflow step_index must be an integer")
        return value


class WorkspaceCheckpoints:
    """Private Git checkpoint, restore, and history behind the Workspace.

    Changes and checkpoints are returned as plain dictionaries. The active
    Workflow Run is never restored by ordinary Workspace versioning.
    """

    def __init__(self, session_root: Path) -> None:
        self.session_root = Path(session_root)
        self.work_dir = self.session_root / WORK_DIR_NAME

    ############################################################################
    # Core Method
    ############################################################################

    def init_repo(self) -> None:
        """Prepare the Git repository and create its initial checkpoint once.

        Returns
        -------
        None
        """
        def ensure_gitignore() -> None:
            path = self.session_root / ".gitignore"
            existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
            wanted = existing + [line for line in DEFAULT_GITIGNORE_LINES if line not in existing]
            if wanted != existing:
                path.write_text("\n".join(wanted) + "\n", encoding="utf-8")

        def head() -> Optional[bytes]:
            with Repo(str(self.session_root)) as repo:
                try:
                    return repo.head()
                except KeyError:
                    return None

        if not (self.session_root / ".git").is_dir():
            porcelain.init(self.session_root)
        ensure_gitignore()
        if head() is None:
            self.checkpoint(INITIAL_CHECKPOINT_MESSAGE)

    def current_changes(self) -> list[dict[str, object]]:
        """Read the current staged, unstaged, and untracked Workspace changes.

        Returns
        -------
        list[dict[str, object]]
            ::

                []

                [
                    {
                        "label": "New File",
                        "path": "report.md",
                        "added_lines": 12,
                        "deleted_lines": 0,
                    },
                    {
                        "label": "Modified",
                        "path": "notes.txt",
                        "added_lines": 3,
                        "deleted_lines": 1,
                    },
                ]
        """
        def dedupe(values: Iterable[str]) -> list[str]:
            return list(dict.fromkeys(values))

        def count_file_lines(path: str) -> int:
            for candidate in (self.work_dir / path, self.session_root / path):
                try:
                    if not candidate.is_file():
                        continue
                    data = candidate.read_bytes()
                except OSError:
                    continue
                return data.count(b"\n") + (0 if not data or data.endswith(b"\n") else 1)
            return 0

        def current_diff_stats() -> dict[str, tuple[int, int]]:
            result: dict[str, tuple[int, int]] = {}
            for staged in (False, True):
                output = BytesIO()
                porcelain.diff(self.session_root, staged=staged, outstream=output)
                for change in self._parse_diff_changes(
                    output.getvalue().decode("utf-8", errors="replace"),
                ):
                    path = str(change["path"])
                    old_added, old_deleted = result.get(path, (0, 0))
                    result[path] = (
                        old_added + int(change["added_lines"]),
                        old_deleted + int(change["deleted_lines"]),
                    )
            return result

        status = self._status()
        if not status["changed"]:
            return []

        line_stats = current_diff_stats()
        new_files = dedupe([*status["staged_added"], *status["untracked"]])
        modified = dedupe([
            *status["staged_modified"],
            *status["staged_deleted"],
            *status["modified"],
        ])

        changes: list[dict[str, object]] = []
        new_file_set = set(new_files)
        for path in new_files:
            added, deleted = line_stats.get(path, (0, 0))
            if added == 0 and deleted == 0:
                added = count_file_lines(path)
            changes.append(self._change("New File", path, added, deleted))
        for path in modified:
            if path in new_file_set:
                continue
            added, deleted = line_stats.get(path, (0, 0))
            changes.append(self._change("Modified", path, added, deleted))
        return changes

    def checkpoint_changes(self, checkpoint_id: str) -> list[dict[str, object]]:
        """Read the files and line counts introduced by one checkpoint.

        Returns
        -------
        list[dict[str, object]]
            ::

                []

                [
                    {
                        "label": "New File",
                        "path": "report.md",
                        "added_lines": 12,
                        "deleted_lines": 0,
                    },
                    {
                        "label": "Modified",
                        "path": "notes.txt",
                        "added_lines": 3,
                        "deleted_lines": 1,
                    },
                ]
        """
        return self._parse_diff_changes(self._checkpoint_diff_text(checkpoint_id))

    def history(self, *, max_count: int = 20) -> list[dict[str, object]]:
        """Read recent checkpoints newest first.

        Returns
        -------
        list[dict[str, object]]
            ::

                []

                [
                    {
                        "checkpoint_id": "0123456789abcdef0123456789abcdef01234567",
                        "message": "Agent turn: Created report",
                        "created_at": datetime(
                            2026, 8, 1, 12, 34, 56, tzinfo=timezone.utc
                        ),
                        "changed_files": 2,
                    },
                ]
        """
        checkpoints: list[dict[str, object]] = []
        with Repo(str(self.session_root)) as repo:
            for entry in repo.get_walker(max_entries=max_count):
                commit = entry.commit
                checkpoints.append({
                    "checkpoint_id": self._decode(commit.id),
                    "message": self._decode(commit.message).splitlines()[0],
                    "created_at": datetime.fromtimestamp(commit.commit_time, tz=timezone.utc),
                    "changed_files": len(entry.changes()),
                })
        return checkpoints

    def checkpoint(self, message: str) -> Optional[str]:
        """Stage the managed Workspace paths and create one Git commit.

        Returns
        -------
        Optional[str]
            ::

                "0123456789abcdef0123456789abcdef01234567"

                None
        """
        def stage_workspace() -> None:
            paths = [str(self.session_root / ".gitignore")]
            if self.work_dir.is_dir():
                paths.append(str(self.work_dir))
            porcelain.add(self.session_root, paths=paths)

        stage_workspace()
        status = self._status()
        if not any(status[name] for name in ("staged_added", "staged_modified", "staged_deleted")):
            return None
        # sign=False, explicitly. Dulwich's default is `sign=None`, which means
        # "do whatever the user's git config says" — and it reads the real
        # ~/.gitconfig, because this is the user's machine.
        #
        # That default is wrong for this commit in both directions. When the
        # user has `commit.gpgsign = true`, a checkpoint that is deliberately
        # authored as CHECKPOINT_AUTHOR (a synthetic identity, not a person)
        # would be cryptographically signed with that person's key — a signed
        # commit they never wrote. And when the configured signer cannot run,
        # dulwich raises: a machine with `gpg.format = ssh` but no `ssh-keygen`
        # on PATH turns `ValueError: ssh-keygen command not available for SSH
        # signatures` into a failed Agent turn, because this call sits on the
        # workspace-preparation path that every turn goes through.
        #
        # Nothing reads a signature off these commits. They are a private,
        # machine-generated undo history inside the Session's own repository,
        # never pushed anywhere and never verified by anyone.
        commit_id = porcelain.commit(
            self.session_root,
            message=message.strip().encode("utf-8"),
            author=CHECKPOINT_AUTHOR,
            committer=CHECKPOINT_AUTHOR,
            sign=False,
        )
        return self._decode(commit_id)

    def diff(self, *, file_path: str = "", staged: bool = False) -> str:
        """Read the current tracked Git diff, optionally scoped to one file.

        Returns
        -------
        str
            ::

                diff --git a/.work/report.md b/.work/report.md
                index 5626abf..f719efd 100644
                --- a/.work/report.md
                +++ b/.work/report.md
                @@ -1 +1 @@
                -old
                +new

                (No diff.)

                <first 30000 characters>
                ... [truncated, 1250 more chars]
        """
        paths = None
        if file_path.strip():
            paths = [self._repo_path_for_work_file(file_path).encode("utf-8")]
        out = BytesIO()
        porcelain.diff(self.session_root, staged=staged, paths=paths, outstream=out)
        text = out.getvalue().decode("utf-8", errors="replace")
        return self._truncate(text) if text else "(No diff.)"

    def checkpoint_diff(self, checkpoint_id: str, *, file_path: str = "") -> str:
        """Read the Git diff introduced by one checkpoint.

        Returns
        -------
        str
            ::

                diff --git a/.work/report.md b/.work/report.md
                new file mode 100644
                index 0000000..f719efd
                --- /dev/null
                +++ b/.work/report.md
                @@ -0,0 +1 @@
                +new

                (No diff.)

                <first 30000 characters>
                ... [truncated, 1250 more chars]
        """
        text = self._checkpoint_diff_text(checkpoint_id, file_path=file_path)
        return self._truncate(text) if text else "(No diff.)"

    def restore_file(self, checkpoint_id: str, file_path: str) -> str:
        """Restore one Workspace file and checkpoint dirty changes first.

        Returns
        -------
        str
            ::

                "report.md"
                "reports/summary.md"
        """
        commit_id = self._resolve_checkpoint(checkpoint_id)
        repo_path = self._repo_path_for_work_file(file_path)
        parts = PurePosixPath(repo_path).parts
        if len(parts) >= 2 and parts[:2] == (WORK_DIR_NAME, WORKFLOW_RUN_DIR_NAME):
            raise ValueError("The active Workflow Run is not a restorable workspace file")
        self._protect_dirty_workspace()
        self._restore_repo_path_from_checkpoint(commit_id, repo_path)
        return self._display_path(repo_path.encode("utf-8"))

    def restore(self, checkpoint_id: str) -> str:
        """Restore ``.work`` while preserving ``.work/.run``.

        Returns
        -------
        str
            ::

                "0123456789abcdef0123456789abcdef01234567"
        """
        commit_id = self._resolve_checkpoint(checkpoint_id)
        self._protect_dirty_workspace()
        self._restore_repo_path_from_checkpoint(
            commit_id,
            WORK_DIR_NAME,
            preserve_run=True,
        )
        return self._decode(commit_id)

    def changed_files_context_lines(self, *, max_files: int = 20) -> list[str]:
        """Render current changes for the dynamic Workspace prompt.

        Returns
        -------
        list[str]
            ::

                ["- Changed files: none"]

                [
                    "- Changed files:",
                    "  - New File: report.md (+12 lines, -0 lines)",
                    "  - Modified: notes.txt (+3 lines, -1 lines)",
                ]
        """
        changes = self.current_changes()
        if not changes:
            return ["- Changed files: none"]
        lines = ["- Changed files:"]
        lines.extend(f"  - {self.format_change(change)}" for change in changes[:max_files])
        omitted = len(changes) - max_files
        if omitted > 0:
            lines.append(f"  - ... and {omitted} more files")
        return lines

    def checkpoint_context_lines(self, *, max_count: int = 3) -> list[str]:
        """Render recent checkpoints and restore guidance for the prompt.

        Returns
        -------
        list[str]
            ::

                [
                    "- Latest checkpoint: none",
                    "- Recent checkpoints: none",
                    "- Restore hint: use workspace_history to find a checkpoint_id; "
                    "restore tools are available in the basic workspace tools.",
                ]

                [
                    "- Latest checkpoint: 0123456789ab 2026-08-01 20:00 "
                    "Created report (2 files)",
                    "- Recent checkpoints:",
                    "  - 0123456789ab 2026-08-01 20:00 Created report (2 files)",
                    "- Restore hint: use a checkpoint_id above with "
                    "workspace_restore_file/workspace_restore.",
                ]
        """
        checkpoints = self.history(max_count=max_count)
        if not checkpoints:
            return [
                "- Latest checkpoint: none",
                "- Recent checkpoints: none",
                "- Restore hint: use workspace_history to find a checkpoint_id; "
                "restore tools are available in the basic workspace tools.",
            ]
        lines = [
            f"- Latest checkpoint: {self.format_checkpoint(checkpoints[0])}",
            "- Recent checkpoints:",
        ]
        lines.extend(f"  - {self.format_checkpoint(item)}" for item in checkpoints)
        lines.append(
            "- Restore hint: use a checkpoint_id above with "
            "workspace_restore_file/workspace_restore."
        )
        return lines

    ############################################################################
    # Helper Method
    ############################################################################

    @staticmethod
    def format_checkpoint(item: Mapping[str, object]) -> str:
        when = item["created_at"].astimezone().strftime("%Y-%m-%d %H:%M")
        count = item["changed_files"]
        files = "file" if count == 1 else "files"
        return f"{str(item['checkpoint_id'])[:12]} {when} {item['message']} ({count} {files})"

    @staticmethod
    def format_change(item: Mapping[str, object]) -> str:
        return (
            f"{item['label']}: {item['path']} "
            f"(+{item['added_lines']} lines, -{item['deleted_lines']} lines)"
        )

    @staticmethod
    def _change(label: str, path: str, added: int, deleted: int) -> dict[str, object]:
        return {"label": label, "path": path, "added_lines": added, "deleted_lines": deleted}

    def _checkpoint_diff_text(self, checkpoint_id: str, *, file_path: str = "") -> str:
        commit_id = self._resolve_checkpoint(checkpoint_id)
        with Repo(str(self.session_root)) as repo:
            commit = repo[commit_id]
            parent_id = commit.parents[0] if commit.parents else None
        paths = None
        if file_path.strip():
            paths = [self._repo_path_for_work_file(file_path).encode("utf-8")]
        out = BytesIO()
        porcelain.diff(
            self.session_root,
            commit=parent_id,
            commit2=commit_id,
            paths=paths,
            outstream=out,
        )
        return out.getvalue().decode("utf-8", errors="replace")

    @classmethod
    def _parse_diff_changes(cls, text: str) -> list[dict[str, object]]:
        changes: list[dict[str, object]] = []
        for patch in parse_unified_diff(text.encode("utf-8")):
            raw_path = patch.new_path or patch.rename_to or patch.old_path or patch.rename_from
            if raw_path is None:
                continue
            if raw_path.startswith((b"a/", b"b/")):
                raw_path = raw_path[2:]
            added = sum(line.startswith(b"+") for hunk in patch.hunks for line in hunk.lines)
            deleted = sum(line.startswith(b"-") for hunk in patch.hunks for line in hunk.lines)
            is_new = patch.old_path is None and patch.rename_from is None
            changes.append(cls._change(
                "New File" if is_new else "Modified",
                cls._display_path(raw_path),
                added,
                deleted,
            ))
        return changes

    def _protect_dirty_workspace(self) -> None:
        if self._status()["changed"]:
            self.checkpoint("Protection checkpoint before restore")

    def _restore_repo_path_from_checkpoint(
        self,
        commit_id: bytes,
        repo_path: str,
        *,
        preserve_run: bool = False,
    ) -> None:
        def remove_path(path: Path) -> None:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            elif path.exists() or path.is_symlink():
                path.unlink()

        def remove_work_children(target: Path) -> None:
            for child in target.iterdir():
                if child.name != WORKFLOW_RUN_DIR_NAME:
                    remove_path(child)

        def restore_object(repo: Repo, mode: int, object_id: bytes, target: Path) -> None:
            obj = repo[object_id]
            remove_path(target)
            if stat.S_ISDIR(mode):
                assert isinstance(obj, Tree)
                target.mkdir(parents=True, exist_ok=True)
                for entry in obj.iteritems(name_order=True):
                    restore_object(
                        repo,
                        entry.mode,
                        entry.sha,
                        target / os.fsdecode(entry.path),
                    )
                return
            assert isinstance(obj, Blob)
            target.parent.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(mode):
                try:
                    os.symlink(os.fsdecode(obj.data), target)
                except (NotImplementedError, OSError):
                    target.write_bytes(obj.data)
                return
            target.write_bytes(obj.data)
            if stat.S_ISREG(mode):
                os.chmod(target, mode & 0o777)

        def restore_work_tree(repo: Repo, object_id: bytes, target: Path) -> None:
            tree = repo[object_id]
            assert isinstance(tree, Tree)
            remove_work_children(target)
            target.mkdir(parents=True, exist_ok=True)
            for entry in tree.iteritems(name_order=True):
                name = os.fsdecode(entry.path)
                if name != WORKFLOW_RUN_DIR_NAME:
                    restore_object(repo, entry.mode, entry.sha, target / name)

        with Repo(str(self.session_root)) as repo:
            commit = repo[commit_id]
            tree = repo[commit.tree]
            assert isinstance(tree, Tree)
            target = self.session_root / repo_path
            try:
                mode, object_id = tree.lookup_path(
                    repo.object_store.__getitem__,
                    repo_path.encode("utf-8"),
                )
            except KeyError:
                if preserve_run:
                    remove_work_children(target)
                else:
                    remove_path(target)
                return
            if preserve_run and stat.S_ISDIR(mode):
                restore_work_tree(repo, object_id, target)
            else:
                restore_object(repo, mode, object_id, target)

    def _resolve_checkpoint(self, checkpoint_id: str) -> bytes:
        def resolve_prefix(prefix: str) -> Optional[bytes]:
            matches: list[bytes] = []
            with Repo(str(self.session_root)) as repo:
                for entry in repo.get_walker():
                    commit_id = entry.commit.id
                    if self._decode(commit_id).startswith(prefix):
                        matches.append(commit_id)
                        if len(matches) > 1:
                            return None
            return matches[0] if matches else None

        raw = (checkpoint_id or "").strip()
        if not raw:
            raise ValueError("checkpoint_id is required")
        resolved = resolve_prefix(raw.lower())
        if resolved is None:
            raise ValueError(f"Unknown checkpoint: {checkpoint_id}")
        return resolved

    def _repo_path_for_work_file(self, file_path: str) -> str:
        raw = (file_path or "").strip()
        if not raw:
            raise ValueError("file_path is required")
        candidate = Path(raw)
        resolved = candidate.resolve() if candidate.is_absolute() else (self.work_dir / candidate).resolve()
        try:
            relative = resolved.relative_to(self.work_dir.resolve())
        except ValueError as exc:
            raise ValueError("file_path must stay inside the workspace") from exc
        return f"{WORK_DIR_NAME}/{relative.as_posix()}"

    def _status(self) -> dict[str, object]:
        """Return the raw staged, unstaged, and untracked path groups.

        Returns
        -------
        dict[str, object]
            ::

                {
                    "staged_added": ["report.md"],
                    "staged_modified": ["notes.txt"],
                    "staged_deleted": ["old.txt"],
                    "modified": ["draft.md"],
                    "untracked": ["new.txt"],
                    "changed": True,
                }
        """
        status = porcelain.status(self.session_root, untracked_files="all")
        staged = status.staged
        result: dict[str, object] = {
            "staged_added": [self._display_path(path) for path in staged["add"]],
            "staged_modified": [self._display_path(path) for path in staged["modify"]],
            "staged_deleted": [self._display_path(path) for path in staged["delete"]],
            "modified": [self._display_path(path) for path in status.unstaged],
            "untracked": [self._display_path(path) for path in status.untracked],
        }
        result["changed"] = any(result.values())
        return result

    @staticmethod
    def _display_path(value: bytes | str) -> str:
        # Dulwich reports repository paths with native separators on Windows.
        # Only normalize them on Windows: on POSIX a backslash is a valid
        # filename character and must not be reinterpreted as a separator.
        text = WorkspaceCheckpoints._decode(value)
        if _IS_WINDOWS:
            text = text.replace("\\", "/")
        prefix = f"{WORK_DIR_NAME}/"
        if text == WORK_DIR_NAME:
            return "."
        return text[len(prefix):] if text.startswith(prefix) else text

    @staticmethod
    def _decode(value: bytes | str) -> str:
        return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)

    @staticmethod
    def _truncate(text: str) -> str:
        if len(text) <= MAX_DIFF_CHARS:
            return text
        omitted = len(text) - MAX_DIFF_CHARS
        return f"{text[:MAX_DIFF_CHARS]}\n... [truncated, {omitted} more chars]"


class BuildSpace:
    """The Session's single unfinished Build tree at ``.work/.build``.

    Owns the hidden ``.state.json`` that lets a paused Build reopen at the right
    cognitive stage. Files inside the tree belong to the domain component that
    writes them.
    """

    def __init__(self, work_dir: Path) -> None:
        self.root = Path(work_dir).resolve() / BUILD_DIR_NAME
        self._state_path = self.root / BUILD_STATE_FILE_NAME

    ############################################################################
    # Core Method
    ############################################################################

    def checkpoint(self) -> Optional[BuildState]:
        """Return one validated snapshot of the resumable Build state."""
        state = self._state
        return state.model_copy(deep=True) if state is not None else None

    @property
    def is_available(self) -> bool:
        """Whether the Build root and checkpoint can be resumed."""
        return self.checkpoint() is not None

    @property
    def stage(self) -> str:
        """The last active cognitive stage, defaulting safely to clarify."""
        state = self.checkpoint()
        return state.stage if state is not None else "clarify"

    @property
    def workflow_id(self) -> Optional[str]:
        """The saved Workflow being edited, or ``None`` for a new Build."""
        state = self.checkpoint()
        return state.workflow_id if state is not None else None

    @property
    def acceptance_contract(self) -> Optional[dict[str, str]]:
        """The one-time acceptance-review receipt for this Build."""
        state = self.checkpoint()
        if state is None or state.acceptance_contract is None:
            return None
        return dict(state.acceptance_contract)

    @property
    def acceptance_review_request_id(self) -> Optional[str]:
        """Identity of this Build's already-presented one-time AC review."""
        contract = self.acceptance_contract
        return contract["request_id"] if contract is not None else None

    @property
    def acceptance_review_presented(self) -> bool:
        """Whether this Build has already presented its one-time AC review."""
        return self.acceptance_review_request_id is not None

    @property
    def last_task_confirmation(self) -> Optional[dict[str, str]]:
        """The exact ``task.md`` snapshot reviewed in the previous card."""
        state = self.checkpoint()
        if state is None or state.last_task_confirmation is None:
            return None
        return dict(state.last_task_confirmation)

    @property
    def edit_task_baseline(self) -> Optional[str]:
        """The saved ``task.md`` version restored when this edit Build began."""
        state = self.checkpoint()
        return state.edit_task_baseline if state is not None else None

    async def prepare(
        self,
        operation: Literal["create", "resume"],
        *,
        workflow_id: Optional[str] = None,
        stage: str = "clarify",
    ) -> "BuildSpace":
        """Create or resume this Build space off the event loop."""
        def prepare() -> None:
            if operation == "resume":
                state = self.checkpoint()
                if state is None:
                    raise FileNotFoundError(f"Build directory is missing or invalid: {self.root}")
                # Rewriting the parsed checkpoint physically removes legacy
                # acceptance-contract fields other than its request identity.
                self._write_state(state)
                return
            if operation != "create":
                raise ValueError(f"Unsupported Build prepare operation: {operation!r}")

            self.root.parent.mkdir(parents=True, exist_ok=True)
            self._remove_tree(self.root)
            try:
                self.root.mkdir()
                self.set_stage(stage, workflow_id)
            except BaseException:
                self._remove_tree(self.root)
                raise

        await asyncio.to_thread(prepare)
        return self

    async def discard(self) -> None:
        """Delete the entire ``.build`` tree after it is saved or abandoned."""
        await asyncio.to_thread(self._remove_tree, self.root)

    def set_stage(self, stage: str, workflow_id: Optional[str] = None) -> None:
        """Persist the last active stage so a paused Build reopens accurately."""
        workflow_id = workflow_id or self.workflow_id
        current = self._state or BuildState()
        self._write_state(
            current.model_copy(update={"stage": stage, "workflow_id": workflow_id})
        )

    def record_task_confirmation(self, request_id: str, task_markdown: str) -> None:
        """Remember the ``task.md`` snapshot reviewed by the user."""
        snapshot = {"request_id": request_id, "task_markdown": task_markdown}
        existing = self.last_task_confirmation
        if existing == snapshot:
            return
        if existing is not None and existing["request_id"] == request_id:
            raise RuntimeError("Task confirmation snapshot changed for the same request")
        current = self._state or BuildState()
        self._write_state(
            current.model_copy(update={"last_task_confirmation": snapshot})
        )

    def record_edit_task_baseline(self, task_markdown: str) -> None:
        """Freeze the saved task definition restored for this edit Build."""
        existing = self.edit_task_baseline
        if existing == task_markdown:
            return
        if existing is not None:
            raise RuntimeError("Edit task baseline was already recorded with different content")
        current = self._state or BuildState()
        self._write_state(
            current.model_copy(update={"edit_task_baseline": task_markdown})
        )

    def start_acceptance_review(self, request_id: str) -> str:
        """Record only that the one-time AC review has been presented.

        Candidate and selected rules deliberately stay out of ``.state.json``.
        They travel in the interaction/tool result, while ``task.md`` remains
        the Build's sole durable acceptance-criteria source of truth.
        """
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("acceptance review requires a request id")
        existing = self.acceptance_review_request_id
        if existing is not None:
            if existing != request_id:
                raise ValueError("This Build already has an acceptance review")
            return existing
        current = self._state or BuildState()
        self._write_state(
            current.model_copy(update={
                "acceptance_contract": {"request_id": request_id},
            })
        )
        return request_id

    ############################################################################
    # Helper Method
    ############################################################################
    @staticmethod
    def _remove_tree(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.exists() or path.is_symlink():
            path.unlink()

    @property
    def _state(self) -> Optional[BuildState]:
        if (
            not self._root_available
            or self._state_path.is_symlink()
            or not self._state_path.is_file()
        ):
            return None
        try:
            return BuildState.model_validate_json(
                self._state_path.read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, ValueError):
            return None

    @property
    def _root_available(self) -> bool:
        return (
            not self.root.parent.is_symlink()
            and not self.root.is_symlink()
            and self.root.is_dir()
        )

    def _write_state(self, state: BuildState) -> None:
        """Atomically replace the hidden Build state document."""
        if not self._root_available:
            raise FileNotFoundError(f"Build directory is missing or invalid: {self.root}")
        validated = BuildState.model_validate(state.model_dump(mode="python"))
        temporary = self._state_path.with_name(f"{BUILD_STATE_FILE_NAME}.tmp")
        if self._state_path.is_symlink() or temporary.is_symlink():
            raise RuntimeError("Build state file cannot be a symbolic link")
        temporary.write_text(validated.model_dump_json(), encoding="utf-8")
        os.replace(temporary, self._state_path)


class RunWorkflowSpace:
    """The durable cursor and artifact root for one unfinished Workflow Run.

    The Run root is always ``.work/.run`` and cannot be rebound elsewhere. Its
    ``.state.json`` is the authority for the Run's identity and cursor — the
    cognitive projection in ``AgentState`` is derived from it, never the reverse
    — while files produced inside the Run belong to its domain component.

    Only the owning Session's main loop advances the cursor, so no lock is
    needed: sibling Sessions and child Agents never write here.
    """

    def __init__(self, work_dir: Path) -> None:
        self.root = Path(work_dir).expanduser().resolve() / WORKFLOW_RUN_DIR_NAME
        self._state_path = self.root / RUN_WORKFLOW_STATE_FILE_NAME

    ############################################################################
    # Core Method
    ############################################################################

    def checkpoint(self) -> Optional[RunWorkflowState]:
        """Return one validated snapshot without mutating Run installation files."""
        try:
            return self._validate_open()
        except (FileNotFoundError, OSError, RuntimeError, UnicodeError, ValueError):
            pass

        if self.root.exists() or self.root.is_symlink() or not self.root.parent.is_dir():
            return None
        backups = list(self.root.parent.glob(f"{WORKFLOW_RUN_DIR_NAME}.backup.*"))
        if len(backups) != 1:
            return None
        try:
            return self._validate_root(backups[0])
        except (FileNotFoundError, OSError, RuntimeError, UnicodeError, ValueError):
            return None

    @property
    def is_available(self) -> bool:
        """Whether the complete active Run can be opened safely."""
        return self.checkpoint() is not None

    @property
    def workflow_id(self) -> str:
        """The saved Workflow identity pinned by this Run."""
        return self._state.workflow_id

    @property
    def generation(self) -> str:
        """The stable identity of this Session-local attempt."""
        return self._state.generation

    @property
    def workflow_name(self) -> str:
        """The pinned user-visible Workflow name."""
        return self._state.workflow_name

    @property
    def workflow_input(self) -> UserInput:
        """The original structured input preserved across restart and resume."""
        return self._state.workflow_input.model_copy(deep=True)

    @property
    def stage(self) -> str:
        """The active execute or validate stage."""
        return self._state.stage

    @property
    def step_index(self) -> int:
        """The zero-based source section cursor in the active stage."""
        return self._state.step_index

    async def prepare(
        self,
        operation: Literal["create", "resume"],
        *,
        initial_state: Optional[RunWorkflowState | Mapping[str, object]] = None,
        populate: Optional[Callable[[Path], None]] = None,
    ) -> "RunWorkflowSpace":
        """Create or resume the Run artifacts and checkpoint off the loop.

        ``create`` stages the state and any domain-owned contents populated by
        ``populate`` before replacing the active ``.run``. ``resume`` validates
        only the root and checkpoint state.
        """
        def prepare() -> None:
            if operation == "resume":
                self._recover_interrupted_install()
                self._validate_open()
                return
            if operation != "create":
                raise ValueError(f"Unsupported Run prepare operation: {operation!r}")
            if initial_state is None:
                raise ValueError("Run create requires initial_state")
            self._recover_interrupted_install()

            self.root.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(
                prefix=f"{WORKFLOW_RUN_DIR_NAME}.stage.",
                dir=self.root.parent,
            ))
            try:
                self._write_state_path(
                    temporary / RUN_WORKFLOW_STATE_FILE_NAME,
                    initial_state,
                )
                if populate is not None:
                    populate(temporary)
                self._validate_root(temporary)
                backup = self.root.with_name(
                    f"{WORKFLOW_RUN_DIR_NAME}.backup.{uuid4().hex}"
                )
                had_active_run = self.root.exists() or self.root.is_symlink()
                if had_active_run:
                    self.root.replace(backup)
                try:
                    temporary.replace(self.root)
                except BaseException:
                    if had_active_run:
                        self._remove_tree(self.root)
                        backup.replace(self.root)
                    raise
                else:
                    self._remove_tree(backup)
            except BaseException:
                shutil.rmtree(temporary, ignore_errors=True)
                raise

        task = asyncio.create_task(asyncio.to_thread(prepare))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        return self

    async def discard(self) -> None:
        """Delete the entire active ``.run`` tree."""
        await asyncio.to_thread(self._remove_tree, self.root)

    def checkpoint_cursor(
        self,
        *,
        expected_workflow_id: str,
        expected_generation: str,
        expected_stage: str,
        expected_step_index: int,
        stage: str,
        step_index: int,
    ) -> "RunWorkflowSpace":
        """Atomically replace the cursor when its expected state still matches."""
        self._validate_open()
        state = self._state
        if (
            state.workflow_id == expected_workflow_id
            and state.generation == expected_generation
            and state.stage == stage
            and state.step_index == step_index
        ):
            return self
        self._require_cursor(
            state,
            expected_workflow_id,
            expected_generation,
            expected_stage,
            expected_step_index,
        )
        self._write_state(RunWorkflowState.model_validate(
            {
                **state.model_dump(mode="python"),
                "stage": stage,
                "step_index": step_index,
            }
        ))
        return self

    def remap_references(self, reference_ids: Mapping[str, str]) -> bool:
        """Rewrite copied structured input to use destination Session references."""
        if (
            not reference_ids
            or not self._state_path.is_file()
            or self._state_path.is_symlink()
        ):
            return False
        state = self._read_state_path(self._state_path)
        workflow_input = state.workflow_input.remap_references(reference_ids)
        if workflow_input == state.workflow_input:
            return False
        self._write_state(RunWorkflowState.model_validate(
            {
                **state.model_dump(mode="python"),
                "workflow_input": workflow_input,
            }
        ))
        return True

    ############################################################################
    # Helper Method
    ############################################################################

    @property
    def _state(self) -> RunWorkflowState:
        """The validated durable cursor; the authority for this Run."""
        return self._read_state_path(self._state_path)

    @classmethod
    def _read_state_path(cls, path: Path) -> RunWorkflowState:
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(f"Run state is unavailable: {path}")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("Run state is invalid JSON") from exc
        return cls._validated_state(payload)

    @staticmethod
    def _validated_state(payload: object) -> RunWorkflowState:
        if not isinstance(payload, dict):
            raise ValueError("Run Workflow state format is invalid")
        normalized = dict(payload)
        normalized.pop("source_session_id", None)
        return RunWorkflowState.model_validate(normalized)

    def _require_cursor(
        self,
        state: RunWorkflowState,
        workflow_id: str,
        generation: str,
        stage: str,
        step_index: int,
    ) -> None:
        if (
            state.workflow_id != workflow_id
            or state.generation != generation
            or state.stage != stage
            or state.step_index != step_index
        ):
            raise RuntimeError(
                "Run Workflow cursor mismatch: "
                f"state at {state.workflow_id}:{state.generation}:"
                f"{state.stage}[{state.step_index}], reported "
                f"{workflow_id}:{generation}:{stage}[{step_index}]"
            )

    def _write_state(self, state: RunWorkflowState) -> None:
        if self.root.is_symlink() or not self.root.is_dir():
            raise FileNotFoundError(f"Run Workflow directory is unavailable: {self.root}")
        self._write_state_path(self._state_path, state)

    @classmethod
    def _write_state_path(
        cls,
        path: Path,
        state: RunWorkflowState | Mapping[str, object],
    ) -> None:
        validated = cls._validated_state(
            state.model_dump(mode="python") if isinstance(state, RunWorkflowState) else dict(state)
        )
        temporary = path.with_name(f"{RUN_WORKFLOW_STATE_FILE_NAME}.tmp")
        if path.is_symlink() or temporary.is_symlink():
            raise RuntimeError("Run Workflow state file cannot be a symbolic link")
        temporary.write_text(validated.model_dump_json(), encoding="utf-8")
        os.replace(temporary, path)

    def _validate_open(self) -> RunWorkflowState:
        return self._validate_root(self.root)

    @classmethod
    def _validate_root(cls, root: Path) -> RunWorkflowState:
        if root.parent.is_symlink() or root.is_symlink() or not root.is_dir():
            raise FileNotFoundError(f"Run Workflow directory is unavailable: {root}")
        return cls._read_state_path(root / RUN_WORKFLOW_STATE_FILE_NAME)

    def _recover_interrupted_install(self) -> None:
        if not self.root.parent.is_dir():
            return
        backups = list(self.root.parent.glob(f"{WORKFLOW_RUN_DIR_NAME}.backup.*"))
        if len(backups) > 1:
            raise RuntimeError("Run Workflow has multiple interrupted backups")
        if backups:
            backup = backups[0]
            if self.root.exists() or self.root.is_symlink():
                self._remove_tree(backup)
            else:
                backup.replace(self.root)
        for staged in self.root.parent.glob(f"{WORKFLOW_RUN_DIR_NAME}.stage.*"):
            self._remove_tree(staged)

    @staticmethod
    def _remove_tree(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.exists() or path.is_symlink():
            path.unlink()


class Workspace:
    """The Agent-facing Session workspace.

    Holds the Session paths and composes the environment, the Git checkpoints,
    and the two cognitive workspaces. ``prepare_*`` is how a Build or Run is
    entered — ``create`` starts (or replaces) one and ``resume`` reopens the
    existing one — while ``close_*`` only drops this turn's binding and
    ``discard_*`` deletes the files. Construction only binds paths;
    ``prepare_workspace`` owns all Session filesystem initialization.
    """

    def __init__(
        self,
        session_id: str,
        session_root: Optional[Path] = None,
        mounts: Optional[Sequence[SessionMountRecord]] = None,
    ) -> None:
        # Session workspace root
        self.session_root = self._initialize_session_root(session_id, session_root)
        self.work_dir = self.session_root / WORK_DIR_NAME
        self._mounts = {mount.id: mount for mount in mounts or ()}
        self.environment = WorkspaceEnvironment(self.session_root)
        self.checkpoints = WorkspaceCheckpoints(self.session_root)

        # Session source
        internal_dir = self.session_root / INTERNAL_DIR_NAME
        self.tool_result_dir = internal_dir / TOOL_RESULT_DIR_NAME
        self.permission_dir = internal_dir / PERMISSION_DIR_NAME

        # Session build and run workflow spaces
        self._build_space = BuildSpace(self.work_dir)
        self._run_workflow_space = RunWorkflowSpace(self.work_dir)
        self.build: Optional[BuildSpace] = None
        self.run_workflow: Optional[RunWorkflowSpace] = None

    def _initialize_session_root(self, session_id: str, session_root: Optional[Path]) -> Path:
        def validate_session_id(value: str) -> str:
            raw = str(value or "").strip()
            path = Path(raw)
            if not raw or path.is_absolute() or path.name != raw or raw in {".", ".."}:
                raise ValueError("session_id must be a plain session identifier")
            return raw

        def default_session_root() -> Path:
            configured = os.getenv(SESSIONS_ROOT_ENV_VAR)
            root = (
                Path(configured).expanduser()
                if configured
                else Path.home() / ".bridgic" / "AmphiAgent" / "sessions"
            )
            return root.resolve()

        self.session_id = validate_session_id(session_id)
        requested_root = (
            Path(session_root).expanduser()
            if session_root is not None
            else default_session_root() / self.session_id
        )
        if requested_root.is_symlink():
            raise ValueError("workspace session_root cannot be a symlink")
        return requested_root.resolve()

    @property
    def env(self) -> dict[str, str]:
        """Return the app-injected child-process environment."""
        return self.environment.subprocess_env()

    ############################################################################
    # Workspace Environment Methods
    ############################################################################
    @staticmethod
    async def prepare_environment() -> None:
        """Prepare the process-wide Agent environment during App startup.

        Runs on a daemon thread rather than ``asyncio.to_thread``: interpreter
        exit joins the default executor's threads, so a venv build that is
        mid-flight when the daemon shuts down would hold the process open past
        the CLI's stop timeout and escalate a clean shutdown into taskkill.
        Daemon threads are abandoned at exit instead; an interrupted build's
        staging directory is reclaimed by the next start.
        """
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()

        def deliver(apply: Callable[[], None]) -> None:
            try:
                loop.call_soon_threadsafe(apply)
            except RuntimeError:
                # The loop is already closed; nobody is left to hear the result.
                pass

        def worker() -> None:
            try:
                WorkspaceEnvironment.prepare_app_environment()
            except BaseException as exc:  # noqa: BLE001 - delivered to the awaiter
                deliver(lambda: None if future.done() else future.set_exception(exc))
            else:
                deliver(lambda: None if future.done() else future.set_result(None))

        threading.Thread(target=worker, name="agent-env-prepare", daemon=True).start()
        await future

    @staticmethod
    def environment_status() -> AppEnvironmentStatus:
        """Return the readiness of the process-wide Agent environment."""
        return WorkspaceEnvironment.app_environment_status()

    async def prepare_workspace(self) -> None:
        """Bind the shared runtime and prepare Session directories and private Git."""
        def prepare() -> None:
            self.environment.prepare()
            root = self.session_root
            created_root = False
            try:
                try:
                    root.mkdir(parents=True)
                    created_root = True
                except FileExistsError:
                    pass
                with FileLock(root / WORKSPACE_INITIALIZATION_LOCK_NAME):
                    self.work_dir.mkdir(parents=True, exist_ok=True)
                    internal_dir = self.session_root / INTERNAL_DIR_NAME
                    internal_dir.mkdir(parents=True, exist_ok=True)
                    self.checkpoints.init_repo()
            except BaseException:
                if created_root:
                    shutil.rmtree(root, ignore_errors=True)
                raise

        await asyncio.to_thread(prepare)

    def reference_map(self, mention_ids: Iterable[str]) -> Dict[str, str]:
        """Resolve Invocation-hydrated mount ids to absolute paths."""
        return {
            mount_id: self._mounts[mount_id].abs_path
            for mount_id in mention_ids
            if mount_id in self._mounts
        }

    def mount_roots(self) -> List[str]:
        """Return all Invocation-hydrated absolute mount roots."""
        return [mount.abs_path for mount in self._mounts.values()]

    ############################################################################
    # Workspace Build Space Methods
    ############################################################################
    @property
    def has_build(self) -> bool:
        """Whether a complete and resumable Build space exists."""
        return self.build_checkpoint() is not None

    def build_checkpoint(self) -> Optional[BuildState]:
        """Return the retained Build checkpoint without binding its Space."""
        return self._build_space.checkpoint()

    async def prepare_build_space(
        self,
        operation: Literal["create", "resume"],
        *,
        workflow_id: Optional[str] = None,
        stage: str = "clarify",
    ) -> BuildSpace:
        """Create or resume the Session's single Build and bind it to this turn."""
        self.build = await self._build_space.prepare(
            operation,
            workflow_id=workflow_id,
            stage=stage,
        )
        return self.build

    def close_build_space(self) -> None:
        """Clear this turn's Build projection without deleting its files."""
        self.build = None

    async def discard_build(self) -> None:
        """Delete the unfinished Build tree and unbind it."""
        await self._build_space.discard()
        self.build = None

    ############################################################################
    # Workspace Run Workflow Space Methods
    ############################################################################
    @property
    def has_run_workflow(self) -> bool:
        """Whether a complete and resumable Workflow Run space exists."""
        return self.run_workflow_checkpoint() is not None

    def run_workflow_checkpoint(self) -> Optional[RunWorkflowState]:
        """Return the retained Run checkpoint without binding its Space."""
        return self._run_workflow_space.checkpoint()

    @property
    def run_workflow_root(self) -> Path:
        """Return the fixed active Run root without binding or recovering it."""
        return self._run_workflow_space.root

    async def prepare_run_workflow_space(
        self,
        operation: Literal["create", "resume"],
        *,
        initial_state: Optional[RunWorkflowState | Mapping[str, object]] = None,
        populate: Optional[Callable[[Path], None]] = None,
    ) -> RunWorkflowSpace:
        """Create or resume the Workspace's sole Run space and bind it."""
        self.run_workflow = await self._run_workflow_space.prepare(
            operation,
            initial_state=initial_state,
            populate=populate,
        )
        return self.run_workflow

    def close_run_workflow_space(self) -> None:
        """Clear this turn's Run projection without deleting its files."""
        self.run_workflow = None

    def remap_run_workflow_references(self, reference_ids: Mapping[str, str]) -> bool:
        """Rewrite a copied active Run without binding or recovering its Space."""
        return self._run_workflow_space.remap_references(reference_ids)

    async def discard_run_workflow(self, *, expected_generation: Optional[str] = None) -> bool:
        """Delete the unfinished Run when its generation still matches."""
        run = self._run_workflow_space
        if expected_generation is not None:
            checkpoint = await asyncio.to_thread(run.checkpoint)
            if checkpoint is None or checkpoint.generation != expected_generation:
                return False
        await run.discard()
        self.run_workflow = None
        return True


__all__ = [
    "BUILD_DIR_NAME",
    "INTERNAL_DIR_NAME",
    "RUN_WORKFLOW_STATE_FILE_NAME",
    "WORKFLOW_RUN_DIR_NAME",
    "WORK_DIR_NAME",
    "BuildState",
    "BuildSpace",
    "RunWorkflowState",
    "RunWorkflowSpace",
    "Workspace",
    "WorkspaceCheckpoints",
]
