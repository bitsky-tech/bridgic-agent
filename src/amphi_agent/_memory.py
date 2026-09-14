from dataclasses import dataclass
from typing import List, Optional

from ..amphi_store import MemoryRepository

# Default number of memories ``recall`` surfaces for one turn. Small on
# purpose: injected memories compete with conversation history for the window,
# so precision beats recall here.
DEFAULT_RECALL_LIMIT = 5


@dataclass(frozen=True)
class MemoryItem:
    """One recalled long-term memory — the agent's value shape, immutable."""

    content: str
    source: Optional[str] = None


class Memory:
    """The big-loop's memory view — store-backed, scoped to one user.

    Built with a ``user_id`` (the invocation passes ``user.id``); holds a
    :class:`MemoryRepository` and the turn's recalled items. ``recall`` queries
    the store once per turn; the cache is rendered for the prompt by
    ``MainThink.memory_block``.
    """

    def __init__(self, user_id: str, *, recall_limit: int = DEFAULT_RECALL_LIMIT) -> None:
        self._user_id = user_id
        self._repo = MemoryRepository()
        self._recall_limit = recall_limit
        self.recalled: List[MemoryItem] = []

    async def recall(self, query: str) -> None:
        """Populate the turn's recalled cache for ``query`` (best-effort).

        Recall is an enhancement, never a precondition: a store failure
        degrades to "no memory injected" rather than aborting the turn.
        """
        try:
            rows = await self._repo.recall(
                self._user_id, query, limit=self._recall_limit,
            )
            self.recalled = [MemoryItem(content=r.content, source=r.source) for r in rows]
        except Exception:  # noqa: BLE001 — never fail a turn over optional recall
            self.recalled = []


__all__ = ["MemoryItem", "Memory", "DEFAULT_RECALL_LIMIT"]
