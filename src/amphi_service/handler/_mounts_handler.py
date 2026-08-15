import os
from datetime import datetime
from typing import Optional

from fastapi import File, HTTPException, Response, UploadFile, status

from ..i18n import backend_i18n
from ..protocol import CreateMountRequest
from ...amphi_store import (
    SessionMountRecord,
    SessionMountRepository,
    SessionRecord,
    SessionTurnRepository,
)
from ._base import BaseHandler

_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024


def mount_summary(row: SessionMountRecord, *, removable: bool = True) -> dict:
    """Map a mount row to its wire shape, best-effort stat-ing the path.

    A mount can outlive the file it points at (the user moved/deleted it
    out-of-band); we still list it (so the user can remove it) with zeroed
    size/count rather than failing the whole listing.

    Folders are stat'd but never *read*: ``item_count`` stays ``None``.
    Listing a directory is what trips macOS TCC — merely rendering the asset
    page raised a permission prompt for anyone who had mounted ``~/Downloads``
    — and it walked the whole directory to do it. The renderer re-reads the
    real tree over ``fs.listDir`` on expand anyway, so the count this used to
    produce only ever survived until the user clicked the row.
    """
    size_bytes: Optional[int] = None
    exists = os.path.exists(row.abs_path)
    if exists and row.kind != "folder":
        try:
            size_bytes = os.path.getsize(row.abs_path)
        except OSError:
            exists = False
    return {
        "id": row.id,
        "name": row.name,
        "path": row.abs_path,
        "kind": row.kind,
        "size_bytes": size_bytes,
        "item_count": None,
        "exists": exists,
        "removable": removable,
        "created_at": row.created_at.isoformat()
        if isinstance(row.created_at, datetime)
        else row.created_at,
    }


class SessionMountsHandler(BaseHandler):
    """Bind: ``GET/POST/DELETE /sessions/{session_id}/mounts``.

    A *mount* pins a real local file/folder (by absolute path) to one chat
    session so the agent can operate on it in place. Every client ``path`` is
    validated on the **daemon** side at mount time (absolute → 400,
    exists → 404), failing closed if the daemon is ever non-co-located with
    the client. Deleting an external mount drops only the pointer; deleting a
    Session-owned uploaded mount also removes its managed attachment.
    """

    tags = ["mounts"]

    async def get(self, session_id: str) -> Response:
        user = await self.require_user()
        session = await self.require_session(session_id, user)
        rows = await SessionMountRepository().list_for_session(session_id, user.id)
        return self.response([
            mount_summary(
                row,
                removable=not self._is_system_work_mount(row, session),
            )
            for row in rows
        ])

    async def post(self, session_id: str, body: CreateMountRequest) -> Response:
        user = await self.require_user()
        await self.require_session(session_id, user)
        path = body.path
        if not os.path.isabs(path):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=backend_i18n.text("mount.path_must_be_absolute", path=path),
            )
        if not os.path.exists(path):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=backend_i18n.text("mount.path_not_found", path=path),
            )
        kind = "folder" if os.path.isdir(path) else "file"
        name = os.path.basename(os.path.normpath(path)) or path
        row = await SessionMountRepository().create(
            session_id, user.id, name=name, abs_path=path, kind=kind,
        )
        return self.response(mount_summary(row), status_code=status.HTTP_201_CREATED)

    async def delete(self, session_id: str, id: str = "") -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        rows = await SessionMountRepository().resolve(
            session_id,
            user.id,
            [id],
        )
        row = rows.get(id)
        if row is not None and self._is_system_work_mount(row, record):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=backend_i18n.text("mount.workspace_not_removable"),
            )
        removed = await self.sessions.remove_mount(record, id)
        if not removed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=backend_i18n.text("mount.not_found", id=id),
            )
        return self.response(status_code=status.HTTP_204_NO_CONTENT)

    @staticmethod
    def _is_system_work_mount(mount: SessionMountRecord, session: SessionRecord) -> bool:
        """Whether ``mount`` is the Session's non-removable system ``.work``."""
        if not session.workspace_root:
            return False
        work_path = os.path.realpath(os.path.join(session.workspace_root, ".work"))
        return os.path.realpath(mount.abs_path) == work_path


class SessionMountUploadHandler(BaseHandler):
    """Bind: ``POST /sessions/{session_id}/mounts/upload``."""

    tags = ["mounts"]

    async def post(
        self,
        session_id: str,
        file: UploadFile = File(...),
    ) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        data = await file.read(_MAX_ATTACHMENT_BYTES + 1)
        if len(data) > _MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=backend_i18n.text("mount.upload_too_large"),
            )
        row = await self.sessions.upload_mount(
            record,
            filename=file.filename or "attachment.bin",
            data=data,
        )
        return self.response(mount_summary(row), status_code=status.HTTP_201_CREATED)


class SessionMountListHandler(BaseHandler):
    """Bind: ``GET /mounts`` — aggregate the user's visible Session mounts."""

    tags = ["mounts"]

    async def get(self, limit: Optional[int] = None, offset: int = 0) -> Response:
        user = await self.require_user()
        # Pagination is optional. Fetch everything, filter out the system .work
        # mounts first, then slice the page — paginating at the SQL layer would count
        # .work rows against the page capacity, so filtering would return a short page,
        # and the client's "short page = end of data" rule would stop early, silently
        # dropping rows.
        associations = await SessionMountRepository().list_for_user_with_sessions(user.id)
        associations = [
            (mount, session) for mount, session in associations
            if not SessionMountsHandler._is_system_work_mount(mount, session)
        ]
        start = max(0, offset)
        if limit is not None:
            associations = associations[start:start + max(1, min(limit, 200))]
        elif start:
            associations = associations[start:]
        sessions = list({session.id: session for _, session in associations}.values())
        summaries = await SessionTurnRepository().load_summaries(sessions)
        rows = []
        for mount, session in associations:
            if SessionMountsHandler._is_system_work_mount(mount, session):
                continue
            first_input = summaries[session.id].first_user_input or ""
            rows.append({
                **mount_summary(mount),
                "session_id": session.id,
                "session_title": (
                    session.title
                    or first_input[:80]
                    or backend_i18n.text("mount.default_session_title")
                ),
            })
        return self.response(rows)


__all__ = [
    "SessionMountListHandler",
    "SessionMountUploadHandler",
    "SessionMountsHandler",
    "mount_summary",
]
