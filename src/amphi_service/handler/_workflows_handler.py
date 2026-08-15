import io
import json
import mimetypes
import os
import shutil
import stat as stat_module
import tempfile
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional

from fastapi import File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse

from ...amphi_agent._workflow_run import WorkflowRun as PublishedWorkflowRun
from ...amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
from ..i18n import backend_i18n
from ..protocol import RenameWorkflowRequest, WorkflowFile, WorkflowProgram
from ...amphi_store import (
    Workflow,
    WorkflowNameConflictError,
    WorkflowRepository,
    WorkflowRun,
    WorkflowRunRepository,
)
from ._base import BaseHandler


class WorkflowDirectoryStore:
    """Materialize and read complete Workflow packages under the application root."""

    ARCHIVE_SUFFIX = ".amphi-workflow"
    ARCHIVE_MEDIA_TYPE = "application/vnd.bridgic.workflow+zip"
    ARCHIVE_MANIFEST = "manifest.json"
    SUPPORTED_ARCHIVE_FORMAT_VERSIONS = frozenset({1, 2})
    LEGACY_RUNTIME_DIR_NAME = ".runtime"
    MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
    MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024
    MAX_ARCHIVE_CONTENT_BYTES = 64 * 1024 * 1024
    MAX_ARCHIVE_FILES = 512
    DOCUMENT_NAMES = frozenset({"task.md", "explore.md", "verify.md"})
    SOURCE_DIR_NAME = "workflow"
    README_NAME = "README.md"

    @classmethod
    def root(cls) -> Path:
        return WorkflowLibrary.storage_root()

    @classmethod
    def export_archive(cls, workflow_dir: str, *, name: str, description: Optional[str], domain: Optional[str]) -> bytes:
        """Pack one Workflow as a source-only v2 archive."""

        root = Path(workflow_dir)
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Workflow directory is missing or invalid")
        package = WorkflowPackage(root)
        reason = package.validation_reason()
        if reason:
            raise ValueError(reason)
        program = cls.read_program(package.source_root, strict=True)
        documents: dict[str, str] = {}
        for document_name in cls.DOCUMENT_NAMES:
            value = cls.read_document(workflow_dir, document_name)
            if not value or not value.strip():
                raise ValueError(f"{document_name} is missing or empty")
            documents[document_name] = value

        manifest = {
            "kind": "amphi-workflow",
            "format_version": 2,
            "name": name,
            "description": description,
            "domain": domain,
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(cls.ARCHIVE_MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))
            for document_name, value in sorted(documents.items()):
                archive.writestr(document_name, value)
            for file in program.files:
                relative = PurePosixPath(file.path)
                if "__pycache__" in relative.parts or relative.suffix in {".pyc", ".pyo"}:
                    continue
                archive.writestr(f"{cls.SOURCE_DIR_NAME}/{relative.as_posix()}", file.content)
            if program.readme is not None:
                archive.writestr(f"{cls.SOURCE_DIR_NAME}/{cls.README_NAME}", program.readme)
        content = output.getvalue()
        if len(content) > cls.MAX_ARCHIVE_BYTES:
            raise ValueError("Workflow archive exceeds 32 MiB")
        return content

    @classmethod
    @contextmanager
    def extract_archive(cls, content: bytes) -> Iterator[tuple[Path, dict[str, object]]]:
        """Extract and validate one portable Workflow package."""

        def regular_file(path: Path, label: str) -> Path:
            try:
                mode = path.lstat().st_mode
            except OSError as exc:
                raise ValueError(f"{label} is missing or unreadable") from exc
            if stat_module.S_ISLNK(mode) or not stat_module.S_ISREG(mode):
                raise ValueError(f"{label} is not a regular file")
            return path

        if not content or len(content) > cls.MAX_ARCHIVE_BYTES:
            raise ValueError("Workflow archive is empty or exceeds 32 MiB")
        temporary = Path(tempfile.mkdtemp(prefix="amphi-workflow-import-"))
        try:
            try:
                archive = zipfile.ZipFile(io.BytesIO(content), mode="r")
            except zipfile.BadZipFile as exc:
                raise ValueError("The selected file is not a valid Workflow archive") from exc
            with archive:
                infos = archive.infolist()
                if len(infos) > cls.MAX_ARCHIVE_FILES:
                    raise ValueError("Workflow archive contains too many files")
                seen: set[str] = set()
                total_size = 0
                for info in infos:
                    name = info.filename
                    relative = PurePosixPath(name)
                    if (
                        not name
                        or "\\" in name
                        or name.startswith("/")
                        or any(part in {"", ".", ".."} for part in relative.parts)
                    ):
                        raise ValueError(f"Workflow archive contains invalid path: {name!r}")
                    normalized = relative.as_posix()
                    if normalized in seen:
                        raise ValueError(f"Workflow archive contains duplicate path: {normalized}")
                    seen.add(normalized)
                    mode = (info.external_attr >> 16) & 0xFFFF
                    if stat_module.S_ISLNK(mode) or info.flag_bits & 0x1:
                        raise ValueError(f"Workflow archive contains unsupported file: {normalized}")
                    ignored_legacy_runtime_entry = (
                        relative.parts[0] == cls.LEGACY_RUNTIME_DIR_NAME
                    )
                    allowed = (
                        normalized == cls.ARCHIVE_MANIFEST
                        or normalized in cls.DOCUMENT_NAMES
                        or relative.parts[0] == cls.SOURCE_DIR_NAME
                        or ignored_legacy_runtime_entry
                    )
                    if not allowed:
                        raise ValueError(f"Workflow archive contains unsupported path: {normalized}")
                    if info.is_dir():
                        continue
                    if info.file_size > cls.MAX_ARCHIVE_FILE_BYTES:
                        raise ValueError(f"Workflow archive file exceeds 16 MiB: {normalized}")
                    total_size += info.file_size
                    if total_size > cls.MAX_ARCHIVE_CONTENT_BYTES:
                        raise ValueError("Workflow archive expands beyond 64 MiB")
                    data = archive.read(info)
                    if ignored_legacy_runtime_entry:
                        continue
                    target = temporary.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)

            manifest_path = regular_file(temporary / cls.ARCHIVE_MANIFEST, cls.ARCHIVE_MANIFEST)
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError, UnicodeError) as exc:
                raise ValueError("manifest.json is invalid") from exc
            format_version = manifest.get("format_version") if isinstance(manifest, dict) else None
            if (
                not isinstance(manifest, dict)
                or manifest.get("kind") != "amphi-workflow"
                or type(format_version) is not int
                or format_version not in cls.SUPPORTED_ARCHIVE_FORMAT_VERSIONS
            ):
                raise ValueError("Workflow archive format is not supported")
            name = manifest.get("name")
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
                raise ValueError("Workflow archive has an invalid name")
            for key, limit in (("description", 500), ("domain", 100)):
                value = manifest.get(key)
                if value is not None and (not isinstance(value, str) or len(value) > limit):
                    raise ValueError(f"Workflow archive has an invalid {key}")
            manifest["name"] = name.strip()

            for document_name in cls.DOCUMENT_NAMES:
                path = regular_file(temporary / document_name, document_name)
                try:
                    if not path.read_text(encoding="utf-8").strip():
                        raise ValueError(f"{document_name} is empty")
                except (OSError, UnicodeError) as exc:
                    raise ValueError(f"{document_name} is not valid UTF-8") from exc
            reason = WorkflowPackage(temporary).validation_reason()
            if reason:
                raise ValueError(reason)
            yield temporary, manifest
        finally:
            shutil.rmtree(temporary, ignore_errors=True)

    @classmethod
    def read_document(cls, workflow_dir: str, name: str) -> Optional[str]:
        """Read one package document without following symbolic links."""
        if name not in cls.DOCUMENT_NAMES:
            raise ValueError(f"Invalid Workflow document name: {name!r}")
        path = Path(workflow_dir) / name
        try:
            mode = path.lstat().st_mode
        except OSError:
            return None
        if stat_module.S_ISLNK(mode) or not stat_module.S_ISREG(mode):
            return None
        try:
            return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    @classmethod
    def read_program(cls, directory: Path, *, strict: bool = False) -> WorkflowProgram:
        """Read source files relative to one package's ``workflow/`` directory."""
        if directory.is_symlink() or not directory.is_dir():
            if strict:
                raise ValueError("workflow directory is missing or is a symbolic link")
            return WorkflowProgram()

        resolved = directory.resolve(strict=True)
        files: list[WorkflowFile] = []
        readme: Optional[str] = None
        languages = {".py": "python", ".md": "markdown"}
        for root, dirs, names in os.walk(directory, topdown=True, followlinks=False):
            root_path = Path(root)
            for name in list(dirs):
                path = root_path / name
                if path.is_symlink():
                    if strict:
                        raise ValueError(
                            f"workflow/{path.relative_to(directory).as_posix()} is a symbolic link"
                        )
                    dirs.remove(name)
            dirs.sort()
            names.sort()
            for name in names:
                path = root_path / name
                relative = path.relative_to(directory).as_posix()
                try:
                    mode = path.lstat().st_mode
                except OSError:
                    if strict:
                        raise ValueError(f"workflow/{relative} cannot be read")
                    continue
                if stat_module.S_ISLNK(mode) or not stat_module.S_ISREG(mode):
                    if strict:
                        raise ValueError(f"workflow/{relative} is not a regular file")
                    continue
                try:
                    path.resolve(strict=True).relative_to(resolved)
                    content = path.read_text(encoding="utf-8", errors="replace")
                except (OSError, ValueError) as exc:
                    if strict:
                        raise ValueError(f"workflow/{relative} cannot be read safely") from exc
                    continue
                if relative == cls.README_NAME:
                    readme = content
                else:
                    files.append(WorkflowFile(
                        path=relative,
                        language=languages.get(path.suffix, ""),
                        content=content,
                    ))
        return WorkflowProgram(files=files, readme=readme)

class WorkflowPresenter:
    """Serialize stored workflow definitions for the HTTP API."""

    @staticmethod
    def summary(workflow: Workflow) -> dict:
        return {
            "id": workflow.id,
            "name": workflow.name,
            "workflow_dir": workflow.workflow_dir,
            "desc": workflow.description,
            "source_session_id": workflow.source_session_id,
        }

    @staticmethod
    def detail(workflow: Workflow) -> dict:
        program = WorkflowDirectoryStore.read_program(
            Path(workflow.workflow_dir) / WorkflowDirectoryStore.SOURCE_DIR_NAME
        )
        return {
            "id": workflow.id,
            "name": workflow.name,
            "info": {
                "desc": workflow.description,
                "domain": workflow.domain,
                "workflow_dir": workflow.workflow_dir,
                "created_at": workflow.created_at.isoformat(),
                "owner": workflow.user_id,
                "source_session_id": workflow.source_session_id,
            },
            "fields": {
                "task": {
                    "value": WorkflowDirectoryStore.read_document(workflow.workflow_dir, "task.md"),
                    "editable": True,
                },
                "explore": {
                    "value": WorkflowDirectoryStore.read_document(workflow.workflow_dir, "explore.md"),
                    "editable": False,
                },
                "verify": {
                    "value": WorkflowDirectoryStore.read_document(workflow.workflow_dir, "verify.md"),
                    "editable": False,
                },
                "program": program.model_dump(),
            },
        }


class WorkflowRunPresenter:
    """Serialize global Workflow results for browsing and structured mentions."""

    ARCHIVE_MEDIA_TYPE = "application/zip"
    ARCHIVE_SUFFIX = ".zip"
    TEXT_SUFFIXES = frozenset({".txt", ".md", ".json", ".csv", ".tsv", ".yaml", ".yml"})
    MAX_TEXT_CHARS = 200_000

    @staticmethod
    def _utc_isoformat(value: datetime) -> str:
        """Serialize SQLite-naive UTC values as unambiguous ISO timestamps."""
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()

    @classmethod
    def overview(cls, run: WorkflowRun) -> dict:
        return {
            "id": run.id,
            "workflow_id": run.workflow_id,
            "workflow_name": run.workflow_name,
            "source_session_id": run.source_session_id,
            "workflow_input": run.workflow_input.model_dump(),
            "status": run.status.value,
            "validation_status": run.validation_status.value,
            "created_at": cls._utc_isoformat(run.created_at),
            "finished_at": cls._utc_isoformat(run.finished_at) if run.finished_at is not None else None,
        }

    @classmethod
    def detail(cls, run: WorkflowRun) -> dict:
        published = PublishedWorkflowRun.from_record(run)
        files = []
        for relative in published.files:
            try:
                path = published.resolve_file(relative)
                size = path.stat().st_size
            except OSError:
                continue
            files.append({
                "path": relative,
                "name": path.name,
                "size": size,
            })
        return {
            **cls.overview(run),
            "run_dir": run.run_dir,
            "files": files,
        }

    @classmethod
    def archive(cls, run: WorkflowRun) -> bytes:
        """Pack published final and intermediate files into one archive.

        Final results retain their legacy layout relative to ``result/`` while
        intermediate files keep their ``background/work/`` path. Reject an
        ambiguous archive instead of emitting duplicate ZIP members.
        """
        published = PublishedWorkflowRun.from_record(run)
        if not published.is_available:
            raise FileNotFoundError(run.run_dir)
        archive_entries: list[tuple[str, str]] = []
        archive_names: set[str] = set()
        for relative in published.files:
            published_path = PurePosixPath(relative)
            archive_name = (
                published_path.relative_to("result").as_posix()
                if published_path.parts[0] == "result"
                else published_path.as_posix()
            )
            if archive_name in archive_names:
                raise ValueError(
                    f"Published files collide at archive path {archive_name!r}"
                )
            archive_names.add(archive_name)
            archive_entries.append((relative, archive_name))
        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, archive_name in archive_entries:
                source = published.resolve_file(relative)
                archive.write(source, arcname=archive_name)
        return output.getvalue()

    @staticmethod
    def file_path(run: WorkflowRun, relative_path: str) -> Path:
        """Resolve one user-visible file from the published result set."""
        return PublishedWorkflowRun.from_record(run).resolve_file(relative_path)

    @classmethod
    def file(cls, run: WorkflowRun, relative_path: str) -> dict:
        """Read one run file on demand after validating its managed path."""
        published = PublishedWorkflowRun.from_record(run)
        path = cls.file_path(run, relative_path)
        content = None
        truncated = False
        if path.suffix.lower() in cls.TEXT_SUFFIXES:
            text = published.read_file(relative_path, max_chars=cls.MAX_TEXT_CHARS + 1)
            truncated = len(text) > cls.MAX_TEXT_CHARS
            content = text[:cls.MAX_TEXT_CHARS] if truncated else text
        return {
            "path": relative_path,
            "name": path.name,
            "size": path.stat().st_size,
            "content": content,
            "truncated": truncated,
        }

    @staticmethod
    def discard(run: WorkflowRun) -> None:
        """Delete only the canonical managed directory for an owned Run."""
        PublishedWorkflowRun.from_record(run).delete()

class WorkflowsHandler(BaseHandler):
    """List stored Workflows or import one portable definition."""

    tags = ["workflows"]

    async def get(self, session_id: Optional[str] = None) -> Response:
        user = await self.require_user()
        repository = WorkflowRepository()
        if session_id:
            await self.require_session(session_id, user)
            workflows = await repository.list_for_session(user.id, session_id)
        else:
            workflows = await repository.list_for_user(user.id)
        return self.response([WorkflowPresenter.summary(workflow) for workflow in workflows])

    async def put(self, file: UploadFile = File(...)) -> Response:
        """Import one exported Workflow as a new library item."""
        user = await self.require_user()
        if not (file.filename or "").lower().endswith(WorkflowDirectoryStore.ARCHIVE_SUFFIX):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=backend_i18n.text(
                    "workflow.import.archive_extension",
                    suffix=WorkflowDirectoryStore.ARCHIVE_SUFFIX,
                ),
            )
        content = await file.read(WorkflowDirectoryStore.MAX_ARCHIVE_BYTES + 1)
        repository = WorkflowRepository()
        library = WorkflowLibrary(user.id)
        try:
            with WorkflowDirectoryStore.extract_archive(content) as (root, manifest):
                name = str(manifest["name"])
                try:
                    package = await library.import_workflow(
                        root,
                        name=name,
                        description=manifest.get("description") or None,
                        domain=manifest.get("domain") or None,
                    )
                except WorkflowNameConflictError as exc:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=backend_i18n.text(
                            "workflow.import.name_conflict",
                            name=name,
                        ),
                    ) from exc
                workflow = await repository.get(user.id, package.workflow_id or "")
                if workflow is None:
                    raise RuntimeError("Imported Workflow was not persisted")
        except HTTPException:
            raise
        except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=backend_i18n.text("workflow.import.failed", reason=exc),
            ) from exc
        return self.response(
            WorkflowPresenter.summary(workflow),
            status_code=status.HTTP_201_CREATED,
        )


class WorkflowItemHandler(BaseHandler):
    """Read, rename, or delete one stored workflow definition."""

    tags = ["workflows"]

    async def get(self, workflow_id: str, archive: bool = False) -> Response:
        user = await self.require_user()
        repository = WorkflowRepository()
        workflow = await repository.get(user.id, workflow_id)
        if workflow is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow {workflow_id!r} not found.",
            )
        if archive:
            try:
                content = WorkflowDirectoryStore.export_archive(
                    workflow.workflow_dir,
                    name=workflow.name,
                    description=workflow.description,
                    domain=workflow.domain,
                )
            except (OSError, ValueError) as exc:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=backend_i18n.text("workflow.export.failed", reason=exc),
                ) from exc
            return Response(
                content=content,
                media_type=WorkflowDirectoryStore.ARCHIVE_MEDIA_TYPE,
                headers={
                    "Content-Disposition": (
                        f'attachment; filename="{workflow.id}'
                        f'{WorkflowDirectoryStore.ARCHIVE_SUFFIX}"'
                    ),
                },
            )
        return self.response(WorkflowPresenter.detail(workflow))

    async def patch(self, workflow_id: str, body: RenameWorkflowRequest) -> Response:
        """Rename the saved Workflow while preserving every id-based reference."""
        user = await self.require_user()
        try:
            workflow = await WorkflowRepository().rename(user.id, workflow_id, body.name)
        except WorkflowNameConflictError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=backend_i18n.text(
                    "workflow.rename.name_conflict",
                    name=exc.name,
                ),
            ) from exc
        if workflow is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow {workflow_id!r} not found.",
            )
        return self.response(WorkflowPresenter.summary(workflow))

    async def delete(self, workflow_id: str) -> Response:
        user = await self.require_user()
        if not await WorkflowLibrary(user.id).delete(workflow_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow {workflow_id!r} not found.",
            )
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class WorkflowRunsHandler(BaseHandler):
    """List global Workflow results for browsing and mention search."""

    tags = ["workflow-runs"]

    async def get(
        self,
        workflow_id: Optional[str] = None,
        source_session_id: Optional[str] = None,
        session_id: Optional[str] = None,
        q: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> Response:
        user = await self.require_user()
        if source_session_id and session_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Use either source_session_id or session_id, not both.",
            )
        if session_id:
            await self.require_session(session_id, user)
        repository = WorkflowRunRepository()
        query = q.strip()
        if query:
            runs = await repository.search(
                user.id,
                query,
                workflow_id=workflow_id,
                source_session_id=source_session_id,
                session_id=session_id,
                limit=limit,
                offset=offset,
            )
        elif session_id:
            runs = await repository.list_for_session(
                user.id,
                session_id,
                workflow_id=workflow_id,
                limit=limit,
                offset=offset,
            )
        elif source_session_id:
            runs = await repository.list_for_source_session(
                user.id,
                source_session_id,
                workflow_id=workflow_id,
                limit=limit,
                offset=offset,
            )
        elif workflow_id:
            runs = await repository.list_for_workflow(
                user.id, workflow_id, limit=limit, offset=offset,
            )
        else:
            runs = await repository.list_for_user(user.id, limit=limit, offset=offset)
        return self.response([WorkflowRunPresenter.overview(run) for run in runs])


class WorkflowRunItemHandler(BaseHandler):
    """Read or delete one global Workflow result and its output files."""

    tags = ["workflow-runs"]

    async def get(self, run_id: str, archive: bool = False) -> Response:
        user = await self.require_user()
        repository = WorkflowRunRepository()
        run = await repository.get(user.id, run_id)
        if run is None or not run.status.is_published:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow run {run_id!r} not found.",
            )
        if archive:
            try:
                content = WorkflowRunPresenter.archive(run)
            except (OSError, ValueError) as exc:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Cannot export Workflow run files: {exc}",
                ) from exc
            return Response(
                content=content,
                media_type=WorkflowRunPresenter.ARCHIVE_MEDIA_TYPE,
                headers={
                    "Content-Disposition": (
                        f'attachment; filename="{run.id}'
                        f'{WorkflowRunPresenter.ARCHIVE_SUFFIX}"'
                    ),
                },
            )
        try:
            return self.response(WorkflowRunPresenter.detail(run))
        except (OSError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Workflow run files are unavailable: {exc}",
            ) from exc

    async def delete(self, run_id: str) -> Response:
        user = await self.require_user()
        repository = WorkflowRunRepository()
        run = await repository.get(user.id, run_id)
        if run is None or not run.status.is_published:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow run {run_id!r} not found.",
            )
        try:
            WorkflowRunPresenter.discard(run)
        except (OSError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Cannot safely delete Workflow run files: {exc}",
            ) from exc
        if not await repository.delete(user.id, run_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow run {run_id!r} not found.",
            )
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class WorkflowRunFileHandler(BaseHandler):
    """Read one file from an owned global Workflow result."""

    tags = ["workflow-runs"]

    async def get(self, run_id: str, path: str, raw: bool = False) -> Response:
        user = await self.require_user()
        run = await WorkflowRunRepository().get(user.id, run_id)
        if run is None or not run.status.is_published:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow run {run_id!r} not found.",
            )
        try:
            if raw:
                file_path = WorkflowRunPresenter.file_path(run, path)
                media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                return FileResponse(file_path, media_type=media_type, filename=file_path.name)
            return self.response(WorkflowRunPresenter.file(run, path))
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Workflow run file {path!r} not found.",
            ) from exc
        except (OSError, UnicodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot read Workflow run file: {exc}",
            ) from exc


__all__ = [
    "WorkflowItemHandler",
    "WorkflowRunFileHandler",
    "WorkflowRunItemHandler",
    "WorkflowRunsHandler",
    "WorkflowsHandler",
]
