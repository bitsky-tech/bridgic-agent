from datetime import datetime
from typing import List, Optional

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel

from ._base import Repository
from ._user import _utcnow


class Skill(SQLModel, table=True):
    __tablename__ = "skills"
    # A skill's name is unique per user (the import path overwrites a same-named
    # skill rather than duplicating it); enforce that at the DB level too.
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_skills_user_name"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    name: str
    description: Optional[str] = Field(default=None)
    skill_dir: Optional[str] = Field(default=None)
    group: Optional[str] = Field(default=None, description="'self_created' | 'imported' | 'builtin'")
    source: Optional[str] = Field(default=None, description="'github' | 'skills.sh' | 'clawhub' | 'local'")
    source_uri: Optional[str] = Field(default=None)
    enabled: bool = Field(default=True, description="Skill toggle; False = disabled. Enabled by default.")
    updated_at: Optional[datetime] = Field(default=None)


class SkillRepository(Repository[Skill]):
    """Per-user skill registry; all methods ownership-scoped by user."""

    async def ensure_builtin(
        self,
        user_id: str,
        *,
        name: str,
        description: str,
        skill_dir: str,
        source: str,
        source_uri: str,
    ) -> Skill:
        """Create or refresh one product-owned Skill while preserving its switch."""
        now = _utcnow()
        async with self._session() as s:
            row = await self._get_by(s, Skill, user_id=user_id, name=name)
            if row is None:
                row = Skill(
                    user_id=user_id,
                    name=name,
                    description=description,
                    skill_dir=skill_dir,
                    group="builtin",
                    source=source,
                    source_uri=source_uri,
                    updated_at=now,
                )
            else:
                desired = (description, skill_dir, "builtin", source, source_uri)
                current = (
                    row.description, row.skill_dir, row.group, row.source, row.source_uri,
                )
                if current == desired:
                    return row
                row.description = description
                row.skill_dir = skill_dir
                row.group = "builtin"
                row.source = source
                row.source_uri = source_uri
                row.updated_at = now
            s.add(row)
            await s.commit()
            await s.refresh(row)
            return row

    async def remove_missing_builtins(self, user_id: str, names: set[str]) -> List[str]:
        """Remove product-owned Skills that are no longer shipped."""
        async with self._session() as s:
            rows = await self._list_owned(s, Skill, user_id)
            obsolete = [
                row for row in rows
                if row.group == "builtin" and row.name not in names
            ]
            for row in obsolete:
                await s.delete(row)
            if obsolete:
                await s.commit()
            return [row.name for row in obsolete]

    async def create(
        self,
        user_id: str,
        *,
        name: str,
        description: Optional[str],
        skill_dir: Optional[str],
        group: Optional[str],
        source: Optional[str],
        source_uri: Optional[str],
    ) -> Skill:
        """Insert a new skill and return it."""
        now = _utcnow()
        async with self._session() as s:
            row = Skill(
                user_id=user_id,
                name=name,
                description=description,
                skill_dir=skill_dir,
                group=group,
                source=source,
                source_uri=source_uri,
                updated_at=now,
            )
            s.add(row)
            await s.commit()
            await s.refresh(row)
            return row

    async def update(
        self,
        user_id: str,
        id: int,
        *,
        name: str,
        description: Optional[str],
        skill_dir: Optional[str],
        group: Optional[str],
        source: Optional[str],
        source_uri: Optional[str],
    ) -> Optional[Skill]:
        """Overwrite one skill's metadata in place, keeping its ``id``.

        Ownership-gated; returns the refreshed row, or ``None`` when no such
        skill exists (so the caller can fall back to :meth:`create`). Used by
        the import-overwrite path so re-importing a skill keeps a stable
        ``skill_id`` instead of churning the row.
        """
        now = _utcnow()
        async with self._session() as s:
            row = await self._get_by(s, Skill, user_id=user_id, id=id)
            if row is None:
                return None
            row.name = name
            row.description = description
            row.skill_dir = skill_dir
            row.group = group
            row.source = source
            row.source_uri = source_uri
            row.updated_at = now
            s.add(row)
            await s.commit()
            await s.refresh(row)
            return row

    async def get(self, user_id: str, id: int) -> Optional[Skill]:
        """Return one skill, ownership-gated (``None`` → 404)."""
        async with self._session() as s:
            return await self._get_by(s, Skill, user_id=user_id, id=id)

    async def get_by_name(self, user_id: str, name: str) -> Optional[Skill]:
        """Return the user's skill named ``name`` (``None`` when none match).

        Resolves a catalogue *name* to its stored row — notably its
        ``skill_dir`` — for the agent ``view_skill`` tool. Ownership-gated; the
        ``(user_id, name)`` unique key guarantees at most one match.
        """
        async with self._session() as s:
            return await self._get_by(s, Skill, user_id=user_id, name=name)

    async def list_for_user(self, user_id: str) -> List[Skill]:
        """Return every skill owned by ``user_id``, newest first."""
        async with self._session() as s:
            return await self._list_owned(
                s, Skill, user_id, order_by=Skill.updated_at.desc(),
            )

    async def set_enabled(
        self, user_id: str, id: int, enabled: bool,
    ) -> Optional[Skill]:
        """Flip one skill's ``enabled``; return the refreshed row.

        Ownership-gated; returns ``None`` when no such skill exists (so the
        handler can map it to 404).
        """
        async with self._session() as s:
            row = await self._get_by(s, Skill, user_id=user_id, id=id)
            if row is None:
                return None
            row.enabled = enabled
            await s.commit()
            await s.refresh(row)
            return row

    async def delete(self, user_id: str, id: int) -> bool:
        """Delete one non-built-in skill; ownership-gated."""
        async with self._session() as s:
            row = await self._get_by(s, Skill, user_id=user_id, id=id)
            if row is None or row.group == "builtin":
                return False
            await s.delete(row)
            await s.commit()
            return True


__all__ = ["Skill", "SkillRepository"]
