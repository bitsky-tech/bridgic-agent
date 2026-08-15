import secrets
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlmodel import Field, SQLModel, select

from ._base import Repository
from ._session import SessionRecord
from ._user import _utcnow


class SessionMountRecord(SQLModel, table=True):
    __tablename__ = "session_mounts"

    id: str = Field(primary_key=True, description="Mount id, e.g. 'mnt_ab12...'.")
    session_id: str = Field(foreign_key="sessions.id", index=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    name: str = Field(description="Display name (the path's basename).")
    abs_path: str = Field(description="Real absolute path on the daemon's FS.")
    kind: str = Field(description="'file' | 'folder'.")
    created_at: datetime = Field(default_factory=_utcnow)


class SessionMountRepository(Repository[SessionMountRecord]):
    """Per-session mounted local paths; ownership-scoped by user.

    A *mount* pins a real local file/folder (by absolute path) to one chat
    session so the agent can operate on it in place. Each Session also owns one
    non-removable system mount for its provisioned ``.work`` directory. External
    mounts are **pointers**: ``abs_path`` is live and deleting the mount never
    deletes the source. Session-owned uploads use the same record shape but live
    under the application's private attachment directory. Rows are keyed by
    ``session_id`` and gated by ``user_id``; at chat time the handler resolves a
    turn's referenced ids back to paths via :meth:`resolve`.
    """

    async def create(
        self, session_id: str, user_id: str, *, name: str, abs_path: str, kind: str,
    ) -> SessionMountRecord:
        """Insert one mount row; return it (with its server-minted id)."""
        async with self._session() as s:
            row = SessionMountRecord(
                id=f"mnt_{secrets.token_hex(8)}",
                session_id=session_id,
                user_id=user_id,
                name=name,
                abs_path=abs_path,
                kind=kind,
            )
            s.add(row)
            await s.commit()
            await s.refresh(row)
            return row

    async def list_for_session(
        self, session_id: str, user_id: str,
    ) -> List[SessionMountRecord]:
        """Every mount of ``session_id`` owned by ``user_id``, newest first."""
        async with self._session() as s:
            return await self._scalars(
                s,
                select(SessionMountRecord)
                .where(SessionMountRecord.session_id == session_id)
                .where(SessionMountRecord.user_id == user_id)
                .order_by(SessionMountRecord.created_at.desc()),
            )

    async def list_for_user_with_sessions(
        self, user_id: str, *, limit: Optional[int] = None, offset: int = 0,
    ) -> List[Tuple[SessionMountRecord, SessionRecord]]:
        """Return every owned mount with its owned Session, newest first.

        Both sides of the join are ownership-gated so an inconsistent or stale
        mount row can never disclose another user's Session metadata.
        """
        async with self._session() as session:
            rows = (
                await session.execute(
                    select(SessionMountRecord, SessionRecord)
                    .join(
                        SessionRecord,
                        SessionRecord.id == SessionMountRecord.session_id,
                    )
                    .where(
                        SessionMountRecord.user_id == user_id,
                        SessionRecord.user_id == user_id,
                    )
                    .order_by(SessionMountRecord.created_at.desc())
                    .limit(max(1, min(limit, 200)) if limit is not None else None)
                    .offset(max(0, offset) if limit is not None else 0),
                )
            ).all()
            return [(mount, owner) for mount, owner in rows]

    async def delete(self, mount_id: str, session_id: str, user_id: str) -> bool:
        """Drop one mount row (unmount); ownership + session gated.

        ``True`` when a row was removed, ``False`` for an unknown id /
        other-session / other-user (→ 404). Never touches the real file.
        """
        async with self._session() as s:
            row = await self._get_owned(s, SessionMountRecord, mount_id, user_id)
            if row is None or row.session_id != session_id:
                return False
            await s.delete(row)
            await s.commit()
            return True

    async def delete_for_session(self, session_id: str, user_id: str) -> int:
        """Drop ALL of one session's mount rows — cascade from session delete.

        Registry rows (pointers) only — the real files are NEVER touched.
        Returns the number of rows removed.
        """
        async with self._session() as s:
            rows = await self._scalars(
                s,
                select(SessionMountRecord)
                .where(SessionMountRecord.session_id == session_id)
                .where(SessionMountRecord.user_id == user_id),
            )
            for row in rows:
                await s.delete(row)
            if rows:
                await s.commit()
            return len(rows)

    async def resolve(
        self, session_id: str, user_id: str, mount_ids: List[str],
    ) -> Dict[str, SessionMountRecord]:
        """Map referenced ``mount_ids`` → their rows, scoped to session + user.

        Ids not found / not owned / from another session are silently dropped —
        a stale or foreign id in a message's ``mentions`` just doesn't resolve,
        rather than erroring the turn.
        """
        if not mount_ids:
            return {}
        wanted = set(mount_ids)
        rows = await self.list_for_session(session_id, user_id)
        return {row.id: row for row in rows if row.id in wanted}


__all__ = ["SessionMountRecord", "SessionMountRepository"]
