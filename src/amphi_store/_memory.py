import re
from datetime import datetime
from typing import List, Optional

from sqlmodel import Field, SQLModel, select

from ._base import Repository
from ._user import _utcnow  # shared helper to dodge datetime.utcnow deprecation

# Shortest query token kept when ranking. Drops noise like "a" / "is" without
# needing a full stop-word list.
_MIN_TERM_LEN = 3


class Memory(SQLModel, table=True):
    __tablename__ = "memories"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    content: str
    # 'auto_chat' | 'manual' | 'imported' | 'agent' | ... — extend as needed.
    source: str
    created_at: datetime = Field(default_factory=_utcnow)
    # Reserved for vector-retrieval; ``None`` until embeddings exist.
    embedding: Optional[bytes] = Field(default=None)


class MemoryRepository(Repository[Memory]):
    """Owner-scoped CRUD + keyword recall for the ``memories`` table.

    Arg-less (the engine is class-level on :class:`Repository`); every method
    takes the ``user_id`` it operates under. ``recall`` returns raw
    :class:`Memory` rows — the agent layer shapes them into its own value
    type, so this stays free of any agent import.
    """

    async def recall(self, user_id: str, query: str, *, limit: int) -> List[Memory]:
        """Up to ``limit`` of the user's memories matching ``query`` (keyword rank).

        Empty when the query has no usable terms or nothing overlaps — the
        agent then injects no memory block at all.
        """
        async with self._session() as session:
            result = await session.execute(
                select(Memory).where(Memory.user_id == user_id)
            )
            rows = list(result.scalars().all())
        return _rank_memories(rows, query, limit)

    async def list_for_user(self, user_id: str) -> List[Memory]:
        """Every memory owned by ``user_id``, newest first."""
        async with self._session() as s:
            return await self._list_owned(
                s, Memory, user_id, order_by=Memory.created_at.desc(),
            )

    async def create(self, user_id: str, *, content: str, source: str) -> Memory:
        """Insert a memory; return it refreshed so ``id`` is populated."""
        async with self._session() as s:
            row = Memory(user_id=user_id, content=content, source=source)
            s.add(row)
            await s.commit()
            await s.refresh(row)
            return row

    async def delete(self, memory_id: int, user_id: str) -> bool:
        """Ownership-gated delete; ``True`` iff a row was deleted (else 404)."""
        async with self._session() as s:
            deleted = await self._delete_owned(s, Memory, memory_id, user_id)
            if deleted:
                await s.commit()
            return deleted


# Module helpers — keyword/recency ranking (kept module-level for tests)
def _tokenize(text: str) -> List[str]:
    """Lowercase alphanumeric terms of length >= ``_MIN_TERM_LEN``."""
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if len(t) >= _MIN_TERM_LEN]


def _rank_memories(rows: List[Memory], query: str, limit: int) -> List[Memory]:
    """Rank ``rows`` by distinct-term overlap with ``query``, recency first.

    Only rows with at least one overlapping term are returned (precision over
    recall). Ties on overlap break by ``created_at`` descending; the row itself
    is never part of the sort key.
    """
    terms = set(_tokenize(query))
    if not terms:
        return []
    scored = []
    for row in rows:
        haystack = row.content.lower()
        overlap = sum(1 for term in terms if term in haystack)
        if overlap > 0:
            scored.append((overlap, row.created_at, row))
    scored.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return [row for _, _, row in scored[:limit]]


__all__ = ["Memory", "MemoryRepository"]
