import asyncio
import os
import shutil
import stat
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Iterable, Literal, Optional
from uuid import NAMESPACE_URL, uuid5

from ..amphi_store import (
    UserInput,
    WorkflowRun as WorkflowRunRecord,
    WorkflowRunRepository,
    WorkflowRunStatus,
)
from ._workflows import WorkflowPackage


WORKFLOW_RUNS_ROOT_ENV_VAR = "BRIDGIC_AGENT_RUNS_ROOT"
_RUN_STATE_FILE_NAME = ".state.json"


class RunWorkflow:
    """Artifacts produced inside one prepared active Workflow Run.

    Parameters
    ----------
    root : Path
        Active Run root prepared by the owning Workspace. This class owns only
        its ``source``, ``result``, and ``background`` children.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(os.path.abspath(Path(root).expanduser()))
        self.source_dir = self.root / "source"
        self.result_dir = self.root / "result"
        self.background_dir = self.root / "background"
        self.background_work_dir = self.background_dir / "work"

    @property
    def is_available(self) -> bool:
        """Whether the active Run artifact tree can be opened safely."""
        try:
            self._validate_open()
        except (FileNotFoundError, OSError):
            return False
        return True

    def prepare(self, operation: Literal["create", "resume"], *, source_root: Optional[Path] = None) -> "RunWorkflow":
        """Create or reopen the source, result, and background artifact tree."""
        if operation == "resume":
            self._validate_open()
            return self
        if operation != "create":
            raise ValueError(f"Unsupported Run Workflow prepare operation: {operation!r}")
        if source_root is None:
            raise ValueError("Run Workflow create requires source_root")
        if self.root.is_symlink() or not self.root.is_dir():
            raise FileNotFoundError(f"Run Workflow space is unavailable: {self.root}")

        source = Path(os.path.abspath(Path(source_root).expanduser()))
        if source.is_symlink() or not source.is_dir():
            raise FileNotFoundError(f"Run Workflow source is unavailable: {source_root}")
        owned_paths = (self.source_dir, self.result_dir, self.background_dir)
        if any(path.exists() or path.is_symlink() for path in owned_paths):
            raise FileExistsError("Run Workflow artifact tree already exists")

        try:
            self.source_dir.mkdir()
            for name in WorkflowPackage.ROOT_ENTRY_NAMES:
                source_path = source / name
                target_path = self.source_dir / name
                if source_path.is_symlink():
                    raise ValueError(
                        f"Run Workflow source entry cannot be a symbolic link: {name}"
                    )
                if source_path.is_dir():
                    shutil.copytree(source_path, target_path, symlinks=True)
                elif source_path.is_file():
                    shutil.copy2(source_path, target_path)
                else:
                    raise FileNotFoundError(
                        f"Run Workflow source entry is unavailable: {name}"
                    )
            self.result_dir.mkdir()
            self.background_work_dir.mkdir(parents=True)
            self._validate_open()
        except BaseException:
            for path in reversed(owned_paths):
                self._remove_tree(path)
            raise
        return self

    def record_step(
        self,
        *,
        stage: str,
        step_number: int,
        step_title: str,
        status: Literal["success", "failure"],
        summary: str,
        evidence: Iterable[str] = (),
    ) -> str:
        """Idempotently persist one active Run section report and its summary."""
        def read_regular_text(path: Path) -> str:
            if path.is_symlink() or not path.is_file():
                raise FileNotFoundError(path)
            return path.read_text(encoding="utf-8")

        def write_text_atomic(path: Path, body: str) -> None:
            temporary = path.with_name(f".{path.name}.tmp")
            if path.is_symlink() or temporary.is_symlink():
                raise RuntimeError(f"Run Workflow file cannot be a symbolic link: {path}")
            try:
                temporary.write_text(body, encoding="utf-8")
                os.replace(temporary, path)
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise

        self._validate_open()
        if stage != "execute":
            raise ValueError(f"Unsupported Workflow stage: {stage!r}")
        if status not in {"success", "failure"}:
            raise ValueError(f"Unsupported Workflow step status: {status!r}")
        if not isinstance(step_number, int) or isinstance(step_number, bool) or step_number < 1:
            raise ValueError("Workflow step number must be a positive integer")
        normalized_title = step_title.strip() if isinstance(step_title, str) else ""
        if not normalized_title:
            raise ValueError("Workflow step title must be non-empty")
        normalized_summary = summary.strip() if isinstance(summary, str) else ""
        if not normalized_summary:
            raise ValueError("Workflow step summary must be non-empty")
        if isinstance(evidence, (str, bytes)):
            raise ValueError("Workflow step evidence must be an iterable of strings")
        normalized_evidence = tuple(
            item.strip() for item in evidence if isinstance(item, str) and item.strip()
        )

        identity = f"workflow-step:{stage}:{step_number}"
        lines = [
            f"<!-- {identity}:start -->",
            f"## {step_number}. {normalized_title}",
            "",
            f"- Status: `{status}`",
            f"- Summary: {normalized_summary}",
        ]
        if normalized_evidence:
            lines.extend(["- Evidence:", *(f"  - {item}" for item in normalized_evidence)])
        lines.append(f"<!-- {identity}:end -->")
        report_block = "\n".join(lines)
        report_path = self.background_dir / "execution.md"
        failure_path = self.result_dir / "failure.md"
        failure_body = (
            "# Workflow run failure\n\n"
            f"{stage} section {step_number} (`{normalized_title}`) reported failure: "
            f"{normalized_summary}"
        )

        existing_report = None
        if report_path.exists() or report_path.is_symlink():
            body = read_regular_text(report_path)
            opening = f"<!-- {identity}:start -->"
            closing = f"<!-- {identity}:end -->"
            start = body.find(opening)
            if start >= 0:
                end = body.find(closing, start + len(opening))
                if end < 0 or body.find(opening, start + len(opening)) >= 0:
                    raise ValueError(f"Workflow {stage} report contains an invalid step marker")
                existing_report = body[start : end + len(closing)]

        if failure_path.exists() or failure_path.is_symlink():
            persisted_failure = read_regular_text(failure_path)
            prefix = (
                "# Workflow run failure\n\n"
                f"{stage} section {step_number} (`{normalized_title}`) reported failure: "
            )
            if (
                status == "failure"
                and existing_report is not None
                and "- Status: `failure`" in existing_report
                and persisted_failure.startswith(prefix)
            ):
                return persisted_failure[len(prefix):]
            raise RuntimeError("Run Workflow already has a terminal failure report")
        if existing_report is not None and existing_report != report_block:
            raise RuntimeError("Workflow step was already reported with different content")
        if existing_report is None:
            previous = read_regular_text(report_path).strip() if report_path.exists() else ""
            write_text_atomic(
                report_path,
                f"{previous}\n\n{report_block}" if previous else report_block,
            )
        if status == "failure":
            write_text_atomic(failure_path, failure_body)
        return normalized_summary

    def _validate_open(self) -> None:
        if self.root.is_symlink() or not self.root.is_dir():
            raise FileNotFoundError(f"Run Workflow space is unavailable: {self.root}")
        for path, label in (
            (self.source_dir, "source"),
            (self.result_dir, "result"),
            (self.background_dir, "background"),
            (self.background_work_dir, "background work"),
        ):
            if path.is_symlink() or not path.is_dir():
                raise FileNotFoundError(f"Run Workflow {label} directory is unavailable: {path}")

    @staticmethod
    def _remove_tree(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.exists() or path.is_symlink():
            path.unlink()


@dataclass(frozen=True)
class WorkflowRun:
    """One globally published terminal Workflow result."""

    run_id: str
    workflow_id: str
    workflow_name: str
    source_session_id: str
    root: Path
    status: WorkflowRunStatus
    created_at: datetime
    workflow_input: UserInput
    finished_at: Optional[datetime] = None

    def __post_init__(self) -> None:
        expected = self.managed_root(self.workflow_id, self.run_id).absolute()
        recorded = Path(os.path.abspath(Path(self.root).expanduser()))
        if recorded != expected:
            raise ValueError(f"Workflow result root must equal its managed path: {expected}")
        object.__setattr__(self, "root", recorded)
        object.__setattr__(self, "workflow_input", UserInput.from_runtime(self.workflow_input))

    @classmethod
    def from_record(cls, row: WorkflowRunRecord) -> "WorkflowRun":
        """Construct the domain view of one durable terminal record."""
        return cls(
            run_id=row.id,
            workflow_id=row.workflow_id,
            workflow_name=row.workflow_name,
            source_session_id=row.source_session_id,
            root=Path(row.run_dir),
            status=row.status,
            created_at=row.created_at,
            workflow_input=UserInput.from_runtime(row.workflow_input),
            finished_at=row.finished_at,
        )

    @classmethod
    def managed_root(cls, workflow_id: str, run_id: str) -> Path:
        """Return the canonical global directory for one terminal result."""
        cls._validate_identity(workflow_id, "workflow_id")
        cls._validate_identity(run_id, "run_id")
        configured = os.getenv(WORKFLOW_RUNS_ROOT_ENV_VAR)
        base = (
            Path(configured).expanduser().resolve()
            if configured
            else (Path.home() / ".bridgic" / "AmphiAgent" / "workflow-runs").resolve()
        )
        return base / workflow_id / run_id

    @property
    def result_dir(self) -> Path:
        """Return the user-visible result directory inside the published snapshot."""
        return self.root / "result"

    @property
    def background_work_dir(self) -> Path:
        """Return the published intermediate-work directory."""
        return self.root / "background" / "work"

    @property
    def is_available(self) -> bool:
        """Whether the published root and user-visible result directory are safe."""
        return self._is_available_root(self.root)

    @property
    def result_files(self) -> tuple[str, ...]:
        """Return final-result regular files relative to the published root."""
        if not self.is_available:
            return ()
        return self._visible_files_under(self.result_dir)

    @property
    def work_files(self) -> tuple[str, ...]:
        """Return intermediate-work regular files relative to the published root."""
        if not self.is_available:
            return ()
        return self._visible_files_under(self.background_work_dir)

    @property
    def files(self) -> tuple[str, ...]:
        """Return every published final-result and intermediate-work file."""
        return self.result_files + self.work_files

    def _visible_files_under(self, directory: Path) -> tuple[str, ...]:
        """List safe regular files below one explicitly published directory."""
        if directory.is_symlink() or not directory.is_dir():
            return ()
        files = []
        for path in sorted(directory.rglob("*")):
            relative = path.relative_to(self.root).as_posix()
            try:
                self.resolve_file(relative)
            except FileNotFoundError:
                continue
            files.append(relative)
        return tuple(files)

    @property
    def is_terminal(self) -> bool:
        return self.status.is_terminal

    @property
    def is_published(self) -> bool:
        return self.status.is_published

    def resolve_file(self, relative_path: str) -> Path:
        """Resolve one published regular file without following symlinks."""
        relative = PurePosixPath(relative_path.replace("\\", "/"))
        if not relative.parts or relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Workflow result path must stay inside a published directory")
        is_final_result = relative.parts[0] == "result"
        is_intermediate_work = relative.parts[:2] == ("background", "work")
        if not is_final_result and not is_intermediate_work:
            raise FileNotFoundError(relative_path)
        return self._resolve_regular_file(relative.as_posix())

    def read_file(self, relative_path: str, *, max_chars: Optional[int] = None) -> str:
        """Read one contained published UTF-8 file."""
        candidate = self.resolve_file(relative_path)
        with candidate.open("r", encoding="utf-8") as stream:
            return stream.read() if max_chars is None else stream.read(max_chars)

    def delete(self) -> None:
        """Delete this exact published root without following a symlink."""
        if not self.root.exists() and not self.root.is_symlink():
            return
        try:
            parent = self.root.parent.resolve(strict=True)
        except OSError as exc:
            raise FileNotFoundError(self.root) from exc
        if parent != self.root.parent:
            raise FileNotFoundError(self.root)
        if self.root.is_symlink() or self.root.is_file():
            self.root.unlink(missing_ok=True)
        elif self.root.is_dir():
            self._resolved_root()
            shutil.rmtree(self.root)

    @staticmethod
    def _validate_identity(value: str, label: str) -> None:
        if (
            not isinstance(value, str)
            or not value.strip()
            or value in {".", ".."}
            or "/" in value
            or "\\" in value
        ):
            raise ValueError(f"Workflow result {label} must be one non-empty path component")

    @classmethod
    def _is_available_root(cls, root: Path) -> bool:
        try:
            cls._resolved_root_path(root)
        except FileNotFoundError:
            return False
        result_dir = root / "result"
        return not result_dir.is_symlink() and result_dir.is_dir()

    def _resolve_regular_file(self, relative_path: str) -> Path:
        relative = PurePosixPath(relative_path.replace("\\", "/"))
        if not relative.parts or relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Workflow result path must stay inside a published directory")
        candidate = self.root
        try:
            root = self._resolved_root()
            for part in relative.parts:
                candidate /= part
                mode = candidate.lstat().st_mode
                if stat.S_ISLNK(mode):
                    raise FileNotFoundError(relative_path)
            if not stat.S_ISREG(mode):
                raise FileNotFoundError(relative_path)
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
        except (OSError, ValueError) as exc:
            raise FileNotFoundError(relative_path) from exc
        return resolved

    def _resolved_root(self) -> Path:
        return self._resolved_root_path(self.root)

    @staticmethod
    def _resolved_root_path(root: Path) -> Path:
        try:
            parent = root.parent.resolve(strict=True)
            resolved = root.resolve(strict=True)
        except OSError as exc:
            raise FileNotFoundError(root) from exc
        if parent != root.parent or resolved != root or root.is_symlink() or not root.is_dir():
            raise FileNotFoundError(root)
        return resolved


class WorkflowRunLibrary:
    """Agent-facing catalogue and storage adapter for global Workflow results.

    Parameters
    ----------
    user_id : str
        Owner used for every terminal Workflow Run lookup and mutation.
    """

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id
        self._repo = WorkflowRunRepository()
        self._runs: dict[str, WorkflowRun] = {}
        self.run_workflow: Optional[RunWorkflow] = None

    @staticmethod
    def terminal_result_id(source_session_id: str, generation: str) -> str:
        """Derive a stable global result id from one Session-local attempt."""
        session_id = source_session_id.strip()
        attempt = generation.strip()
        if not session_id or not attempt:
            raise ValueError("Workflow result identity requires Session and generation")
        return uuid5(
            NAMESPACE_URL,
            f"bridgic-agent:workflow-run:{session_id}:{attempt}",
        ).hex

    def populate_run_workflow(self, root: Path, source_root: Path) -> None:
        """Populate one Workspace staging root without binding its temporary path."""
        RunWorkflow(root).prepare("create", source_root=source_root)

    def open_run_workflow(self, root: Path) -> RunWorkflow:
        """Open and bind the active Workspace Run artifact tree."""
        self.run_workflow = None
        self.run_workflow = RunWorkflow(root).prepare("resume")
        return self.run_workflow

    def require_run_workflow(self, root: Optional[Path] = None) -> RunWorkflow:
        """Return the Run bound for the active cognitive mode."""
        run = self.run_workflow
        if run is None:
            raise RuntimeError("No active Workflow Run artifacts are bound.")
        expected = (
            Path(os.path.abspath(Path(root).expanduser()))
            if root is not None
            else None
        )
        if expected is not None and run.root != expected:
            raise RuntimeError("The bound Workflow Run belongs to another workspace root.")
        if not run.is_available:
            raise FileNotFoundError(f"Workflow Run artifacts are unavailable: {run.root}")
        return run

    def close_run_workflow(self) -> None:
        """Drop the active Run binding without changing its files."""
        self.run_workflow = None

    def record_step(
        self,
        *,
        stage: str,
        step_number: int,
        step_title: str,
        status: Literal["success", "failure"],
        summary: str,
        evidence: Iterable[str] = (),
    ) -> str:
        """Record one section and return its durable summary."""
        return self.require_run_workflow().record_step(
            stage=stage,
            step_number=step_number,
            step_title=step_title,
            status=status,
            summary=summary,
            evidence=evidence,
        )

    @staticmethod
    def referenced_run_ids(user_input: object) -> tuple[str, ...]:
        """Return stable result ids from structured WorkflowRun mentions."""
        blocks = user_input.get("blocks") if isinstance(user_input, dict) else getattr(user_input, "blocks", None)
        result = []
        for block in blocks or []:
            value = block.get if isinstance(block, dict) else lambda name, default=None: getattr(block, name, default)
            run_id = str(value("id") or "").strip()
            if value("type") == "mention" and value("group") == "WorkflowRun" and run_id:
                result.append(run_id)
        return tuple(dict.fromkeys(result))

    async def load(self, *user_inputs: object) -> "WorkflowRunLibrary":
        """Load recent terminal results plus results referenced by every input."""
        self.run_workflow = None
        rows = await self._repo.list_for_user(self._user_id, limit=100)
        known = {row.id for row in rows}
        referenced_ids = tuple(dict.fromkeys(
            run_id
            for user_input in user_inputs
            for run_id in self.referenced_run_ids(user_input)
        ))
        for run_id in referenced_ids:
            if run_id in known:
                continue
            row = await self._repo.get(self._user_id, run_id)
            if row is not None and row.status.is_published:
                rows.append(row)
                known.add(run_id)
        self._runs = {run.run_id: run for run in map(WorkflowRun.from_record, rows)}
        return self

    def runs(self, workflow_id: Optional[str] = None) -> tuple[WorkflowRun, ...]:
        """Return loaded published results newest first, optionally by Workflow."""
        runs = (
            run
            for run in self._runs.values()
            if run.is_published and (workflow_id is None or run.workflow_id == workflow_id)
        )
        return tuple(sorted(runs, key=lambda run: run.created_at, reverse=True))

    def get(self, run_id: str) -> Optional[WorkflowRun]:
        """Return one loaded Workflow Run by its stable id."""
        return self._runs.get(run_id)

    async def load_run(self, run_id: str) -> Optional[WorkflowRun]:
        """Load one owned result when it is outside the recent cache."""
        cached = self.get(run_id)
        if cached is not None:
            return cached
        row = await self._repo.get(self._user_id, run_id)
        if row is None:
            return None
        run = WorkflowRun.from_record(row)
        self._runs[run.run_id] = run
        return run

    async def search(self, query: str = "", workflow_id: Optional[str] = None, limit: int = 50) -> tuple[WorkflowRun, ...]:
        """Load recent or matching results directly from durable storage."""
        if query.strip():
            rows = await self._repo.search(
                self._user_id,
                query,
                workflow_id=workflow_id,
                limit=limit,
            )
        elif workflow_id:
            rows = await self._repo.list_for_workflow(
                self._user_id,
                workflow_id,
                limit=limit,
            )
        else:
            rows = await self._repo.list_for_user(self._user_id, limit=limit)
        runs = tuple(WorkflowRun.from_record(row) for row in rows)
        self._runs.update((run.run_id, run) for run in runs)
        return runs

    def referenced_runs(self, user_input: object) -> tuple[WorkflowRun, ...]:
        """Resolve loaded published Workflow result mentions from one input."""
        return tuple(
            run
            for run_id in self.referenced_run_ids(user_input)
            if (run := self.get(run_id)) is not None and run.is_published
        )

    async def load_referenced(self, user_input: object) -> tuple[WorkflowRun, ...]:
        """Load every published result referenced by one structured input."""
        runs = []
        for run_id in self.referenced_run_ids(user_input):
            run = await self.load_run(run_id)
            if run is not None and run.is_published:
                runs.append(run)
        return tuple(runs)

    async def associate_session(self, session_id: str, run_id: str) -> bool:
        """Associate one published Workflow Run with the Session using it."""
        return await self._repo.associate_session(self._user_id, session_id, run_id)

    async def require_completed_references(self, user_input: object) -> tuple[WorkflowRun, ...]:
        """Resolve referenced results and reject unavailable or failed inputs."""
        runs = []
        for run_id in self.referenced_run_ids(user_input):
            run = await self.load_run(run_id)
            if run is None or run.status is not WorkflowRunStatus.COMPLETED:
                raise ValueError(f"Workflow result `{run_id}` is unavailable or incomplete")
            runs.append(run)
        return tuple(runs)

    async def publish(
        self,
        source_root: Path,
        *,
        result_id: str,
        workflow_id: str,
        workflow_name: str,
        source_session_id: str,
        workflow_input: object,
        status: WorkflowRunStatus,
    ) -> WorkflowRun:
        """Atomically publish and idempotently persist one terminal Run result."""
        if not status.is_published:
            raise ValueError("Workflow Run publication accepts terminal results only")
        source = Path(os.path.abspath(Path(source_root).expanduser()))
        if source.is_symlink() or not source.is_dir():
            raise FileNotFoundError(f"Workflow Run publication source is unavailable: {source}")
        destination = WorkflowRun.managed_root(workflow_id, result_id).absolute()

        def publish_tree() -> None:
            def publication_ignore(_path: str, names: list[str]) -> set[str]:
                return {
                    name
                    for name in names
                    if name in {
                        f"{_RUN_STATE_FILE_NAME}.lock",
                        f"{_RUN_STATE_FILE_NAME}.tmp",
                    }
                }

            if destination.exists() or destination.is_symlink():
                if WorkflowRun._is_available_root(destination):
                    return
                raise FileExistsError(f"Workflow result directory is incomplete: {destination}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(
                prefix=f".{destination.name}.publish.",
                dir=destination.parent,
            ))
            try:
                shutil.rmtree(temporary)
                shutil.copytree(source, temporary, symlinks=True, ignore=publication_ignore)
                try:
                    os.replace(temporary, destination)
                except OSError:
                    if not destination.exists() and not destination.is_symlink():
                        raise
                    shutil.rmtree(temporary, ignore_errors=True)
                if not WorkflowRun._is_available_root(destination):
                    raise RuntimeError(f"Published Workflow result is incomplete: {destination}")
            except BaseException:
                shutil.rmtree(temporary, ignore_errors=True)
                raise

        await asyncio.to_thread(publish_tree)
        row, _created = await self._repo.create_or_confirm_terminal(
            self._user_id,
            result_id=result_id,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            source_session_id=source_session_id,
            result_dir=str(destination),
            workflow_input=UserInput.from_runtime(workflow_input),
            status=status,
        )
        run = WorkflowRun.from_record(row)
        if (
            run.run_id != result_id
            or run.workflow_id != workflow_id
            or run.root != destination
            or not run.is_available
        ):
            raise RuntimeError("Published Workflow result is inconsistent after persistence")
        self._runs[run.run_id] = run
        return run

    async def publish_run_workflow(
        self,
        *,
        result_id: str,
        workflow_id: str,
        workflow_name: str,
        source_session_id: str,
        workflow_input: object,
        status: WorkflowRunStatus,
    ) -> WorkflowRun:
        """Publish the active Run without exposing its implementation to callers."""
        run = self.require_run_workflow()
        return await self.publish(
            run.root,
            result_id=result_id,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            source_session_id=source_session_id,
            workflow_input=workflow_input,
            status=status,
        )

    def read_file(self, run_id: str, relative_path: str) -> str:
        """Read a file from one loaded published result."""
        run = self.get(run_id)
        if run is None or not run.is_published or not run.is_available:
            raise ValueError(f"Workflow result `{run_id}` is unavailable")
        return run.read_file(relative_path)

    async def delete(self, run_id: str) -> bool:
        """Delete one owned published result and its durable record."""
        run = await self.load_run(run_id)
        if run is None or not run.is_published:
            return False
        await asyncio.to_thread(run.delete)
        deleted = await self._repo.delete(self._user_id, run_id)
        if deleted:
            self._runs.pop(run_id, None)
        return deleted

__all__ = [
    "RunWorkflow",
    "WorkflowRun",
    "WorkflowRunLibrary",
]
