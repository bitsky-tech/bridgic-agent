import asyncio
import os
import shutil
from pathlib import Path
from typing import Awaitable, Iterable, Optional

from ...amphi_store import (
    SessionKind,
    SessionMountRecord,
    SessionMountRepository,
    SessionRecord,
    SessionRepository,
    SessionTurnRepository,
    WorkflowRepository,
    WorkflowRunRepository,
    new_session_id,
)
from ._attachments import SessionAttachmentStore

SESSIONS_ROOT_ENV_VAR = "BRIDGIC_AGENT_SESSIONS_ROOT"
WORK_DIR_NAME = ".work"


class SessionService:
    """Coordinate durable root Session lifecycle operations.

    Parameters
    ----------
    session_repository : SessionRepository, optional
        Session metadata persistence dependency.
    mount_repository : SessionMountRepository, optional
        Session mount persistence dependency.
    turn_repository : SessionTurnRepository, optional
        Conversation persistence dependency used by duplication.
    workflow_repository : WorkflowRepository, optional
        Session-to-Workflow association persistence used by duplication.
    attachment_store : SessionAttachmentStore, optional
        Application-owned uploaded-file storage.
    workflow_run_repository : WorkflowRunRepository, optional
        Session-to-Workflow Run association persistence used by duplication.
    """

    def __init__(
        self,
        session_repository: Optional[SessionRepository] = None,
        mount_repository: Optional[SessionMountRepository] = None,
        turn_repository: Optional[SessionTurnRepository] = None,
        workflow_repository: Optional[WorkflowRepository] = None,
        attachment_store: Optional[SessionAttachmentStore] = None,
        workflow_run_repository: Optional[WorkflowRunRepository] = None,
    ) -> None:
        self._sessions = session_repository or SessionRepository()
        self._mounts = mount_repository or SessionMountRepository()
        self._turns = turn_repository or SessionTurnRepository()
        self._workflows = workflow_repository or WorkflowRepository()
        self._workflow_runs = workflow_run_repository or WorkflowRunRepository()
        self._attachments = attachment_store or SessionAttachmentStore()

    async def create_root(
        self,
        user_id: str,
        *,
        model: Optional[str] = None,
        kind: SessionKind = SessionKind.USER,
        schedule_id: Optional[str] = None,
    ) -> SessionRecord:
        """Persist one root Session with its visible work directory.

        Parameters
        ----------
        user_id : str
            Owner of the new Session.
        model : str, optional
            Informational initial model projection.
        kind : SessionKind
            How the Session originated.
        schedule_id : str, optional
            Owning schedule for scheduled Sessions.

        Returns
        -------
        SessionRecord
            Newly persisted root Session.
        """
        session_id = new_session_id()
        workspace_root = self._workspace_root(session_id)
        create_task = asyncio.create_task(
            asyncio.to_thread(self._create_workspace_root, workspace_root)
        )
        try:
            await asyncio.shield(create_task)
        except BaseException:
            if not create_task.done():
                await asyncio.gather(create_task, return_exceptions=True)
            await asyncio.to_thread(self._discard_workspace_root, workspace_root)
            raise
        record = SessionRecord(
            id=session_id,
            user_id=user_id,
            workspace_root=str(workspace_root),
            last_used_model=model,
            kind=kind,
            schedule_id=schedule_id,
        )
        try:
            await self._sessions.save(record)
            await self._mounts.create(
                session_id,
                user_id,
                name=WORK_DIR_NAME,
                abs_path=str((workspace_root / WORK_DIR_NAME).resolve()),
                kind="folder",
            )
        except BaseException:
            await self._mounts.delete_for_session(session_id, user_id)
            await self._sessions.delete(session_id, user_id)
            await asyncio.to_thread(self._discard_workspace_root, workspace_root)
            raise
        return record

    async def duplicate(self, source: SessionRecord) -> SessionRecord:
        """Copy a Session's records and filesystem into a new user Session.

        Parameters
        ----------
        source : SessionRecord
            Authorized source Session.

        Returns
        -------
        SessionRecord
            New user Session carrying the source transcript and Workspace.
        """
        if source.parent_session_id is not None:
            raise ValueError("Only a root Session can be duplicated")

        source_root = Path(source.workspace_root)
        if source_root.is_symlink() or not source_root.is_dir():
            raise ValueError(f"Source Workspace root is unavailable: {source_root}")
        source_root = source_root.resolve()

        def copy_workspace_root(target_root: Path) -> None:
            if target_root.is_symlink() or not target_root.is_dir():
                raise ValueError(f"Target Workspace root is unavailable: {target_root}")
            target_root = target_root.resolve()

            def ignore_local_dependency_environments(
                directory: str,
                names: list[str],
            ) -> list[str]:
                ignored = ["node_modules"] if "node_modules" in names else []
                if Path(directory).resolve() == source_root and ".venv" in names:
                    ignored.append(".venv")
                return ignored

            shutil.copytree(
                source_root,
                target_root,
                dirs_exist_ok=True,
                symlinks=True,
                ignore=ignore_local_dependency_environments,
            )

        async def clone_mounts(
            source_record: SessionRecord,
            dest_record: SessionRecord,
        ) -> dict[str, str]:
            source_mounts = await self._mounts.list_for_session(
                source_record.id,
                source_record.user_id,
            )
            dest_mounts = await self._mounts.list_for_session(
                dest_record.id,
                dest_record.user_id,
            )
            source_work = source_root / WORK_DIR_NAME
            dest_root = Path(dest_record.workspace_root).resolve()
            dest_work = dest_root / WORK_DIR_NAME
            dest_work_mount = next(
                (
                    mount
                    for mount in dest_mounts
                    if Path(mount.abs_path).resolve() == dest_work
                ),
                None,
            )
            replacements: dict[str, str] = {}
            for mount in source_mounts:
                path = Path(mount.abs_path)
                try:
                    resolved = path.resolve()
                except OSError:
                    resolved = path
                if resolved == source_work and dest_work_mount is not None:
                    replacements[mount.id] = dest_work_mount.id
                    continue
                if self._attachments.owns(source_record.id, path):
                    copied_path = await asyncio.to_thread(
                        self._attachments.clone,
                        source_record.id,
                        dest_record.id,
                        path,
                        mount.name,
                    )
                else:
                    try:
                        relative = resolved.relative_to(source_root)
                    except ValueError:
                        copied_path = resolved
                    else:
                        copied_path = dest_root / relative
                copied = await self._mounts.create(
                    dest_record.id,
                    dest_record.user_id,
                    name=mount.name,
                    abs_path=str(copied_path),
                    kind=mount.kind,
                )
                replacements[mount.id] = copied.id
            return replacements

        async def duplicate_children(
            new_root: SessionRecord,
            root_reference_ids: dict[str, str],
        ) -> None:
            children = await self._sessions.list_children(source.user_id, source.id)
            for child in children:
                child_record = SessionRecord(
                    id=new_session_id(),
                    user_id=new_root.user_id,
                    workspace_root=new_root.workspace_root,
                    last_used_model=child.last_used_model,
                    last_answer=child.last_answer,
                    title=child.title,
                    kind=SessionKind.USER,
                    parent_session_id=new_root.id,
                    parent_call_id=child.parent_call_id,
                    subagent_mode=child.subagent_mode,
                    status=child.status,
                )
                await self._sessions.save(child_record)
                reference_ids = {
                    **root_reference_ids,
                    **await clone_mounts(child, child_record),
                }
                await self._turns.copy_to_session(
                    child.id,
                    child_record.id,
                    source.user_id,
                    reference_id_map=reference_ids,
                )
                await self._workflows.copy_session_associations(
                    child.user_id,
                    child.id,
                    child_record.id,
                )
                await self._workflow_runs.copy_session_associations(
                    child.user_id,
                    child.id,
                    child_record.id,
                )

        async def discard_created_tree(root: SessionRecord) -> None:
            failures: list[Exception] = []

            async def attempt(operation: Awaitable[object]) -> None:
                try:
                    await operation
                except Exception as error:  # noqa: BLE001
                    failures.append(error)

            try:
                records = await self._sessions.list_tree(root.user_id, root.id) or [root]
            except Exception as error:  # noqa: BLE001
                failures.append(error)
                records = [root]
            for item in reversed(records):
                await attempt(self._turns.delete_for_session(item.user_id, item.id))
                await attempt(self._mounts.delete_for_session(item.id, item.user_id))
                await attempt(asyncio.to_thread(self._attachments.clear, item.id))
                await attempt(self._sessions.delete(item.id, item.user_id))
            await attempt(
                asyncio.to_thread(
                    self._discard_workspace_root,
                    Path(root.workspace_root),
                )
            )
            if failures:
                detail = "; ".join(
                    f"{type(error).__name__}: {error}" for error in failures
                )
                raise RuntimeError(
                    f"Failed to discard the duplicated Session: {detail}"
                ) from failures[0]

        record = await self.create_root(source.user_id, model=source.last_used_model)
        copy_task = asyncio.create_task(
            asyncio.to_thread(copy_workspace_root, Path(record.workspace_root))
        )
        try:
            await asyncio.shield(copy_task)
            reference_ids = await clone_mounts(source, record)
            from ...amphi_agent._workspace import Workspace

            Workspace(
                record.id,
                session_root=Path(record.workspace_root),
            ).remap_run_workflow_references(reference_ids)
            await self._turns.copy_to_session(
                source.id,
                record.id,
                source.user_id,
                reference_id_map=reference_ids,
            )
            await self._workflows.copy_session_associations(
                source.user_id,
                source.id,
                record.id,
            )
            await self._workflow_runs.copy_session_associations(
                source.user_id,
                source.id,
                record.id,
            )
            record.title = source.title
            record.last_answer = source.last_answer
            record.status = source.status
            await self._sessions.save(record)
            # Child records preserve subagent history and share the cloned root.
            await duplicate_children(record, reference_ids)
            return record
        except BaseException as exc:
            if not copy_task.done():
                await asyncio.gather(copy_task, return_exceptions=True)
            try:
                await discard_created_tree(record)
            except Exception as cleanup_exc:
                if isinstance(exc, Exception):
                    raise RuntimeError(
                        f"Session duplication failed: {exc}; "
                        f"cleanup also failed: {cleanup_exc}"
                    ) from exc
            raise

    async def upload_mount(
        self,
        record: SessionRecord,
        *,
        filename: str,
        data: bytes,
    ) -> SessionMountRecord:
        """Materialize uploaded bytes and register them as a Session mount.

        Parameters
        ----------
        record : SessionRecord
            Authorized owning Session.
        filename : str
            Client filename used only for the mounted display name.
        data : bytes
            Complete upload payload.

        Returns
        -------
        SessionMountRecord
            The newly registered mount.
        """
        safe_name = Path(
            (filename or "").replace("\\", "/").replace("\x00", "")
        ).name
        if safe_name in {"", ".", ".."}:
            safe_name = "attachment.bin"
        path = await asyncio.to_thread(
            self._attachments.write,
            record.id,
            safe_name,
            data,
        )
        try:
            return await self._mounts.create(
                record.id,
                record.user_id,
                name=safe_name,
                abs_path=str(path),
                kind="file",
            )
        except BaseException:
            await asyncio.to_thread(self._attachments.delete, record.id, path)
            raise

    async def remove_mount(self, record: SessionRecord, mount_id: str) -> bool:
        """Remove a mount and delete its file only when Bridgic Agent owns it."""
        rows = await self._mounts.resolve(record.id, record.user_id, [mount_id])
        row = rows.get(mount_id)
        if row is None:
            return False
        removed = await self._mounts.delete(mount_id, record.id, record.user_id)
        if removed:
            await asyncio.to_thread(
                self._attachments.delete,
                record.id,
                Path(row.abs_path),
            )
        return removed

    async def clear_attachments(self, records: Iterable[SessionRecord]) -> None:
        """Delete application-owned uploads for the supplied Sessions."""
        session_ids = [record.id for record in records]
        await asyncio.to_thread(self._attachments.clear_many, session_ids)

    @staticmethod
    def _workspace_root(session_id: str) -> Path:
        configured = os.getenv(SESSIONS_ROOT_ENV_VAR)
        root = (
            Path(configured).expanduser().resolve()
            if configured
            else (Path.home() / ".bridgic" / "AmphiAgent" / "sessions").resolve()
        )
        return (root / session_id).resolve()

    @staticmethod
    def _create_workspace_root(workspace_root: Path) -> None:
        """Create the stable visible shell without initializing Agent runtime."""
        if workspace_root.exists() or workspace_root.is_symlink():
            raise FileExistsError(f"Workspace root already exists: {workspace_root}")
        created_root = False
        try:
            workspace_root.mkdir(parents=True)
            created_root = True
            (workspace_root / WORK_DIR_NAME).mkdir()
        except BaseException:
            if created_root:
                shutil.rmtree(workspace_root, ignore_errors=True)
            raise

    @staticmethod
    def _discard_workspace_root(workspace_root: Path) -> None:
        """Remove the workspace root when Session creation fails."""
        if workspace_root.is_dir() and not workspace_root.is_symlink():
            shutil.rmtree(workspace_root)

__all__ = ["SessionService"]
