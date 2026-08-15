from dataclasses import dataclass
from typing import List, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec, ToolSpec

from ..amphi_store import MemoryRepository

# Default number of memories ``recall`` surfaces for one turn. Small on
# purpose: injected memories compete with conversation history for the window,
# so precision beats recall here.
DEFAULT_RECALL_LIMIT = 5

# Source tag stamped on memories the agent captures itself.
_AGENT_SOURCE = "agent"


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
    ``MainThink.memory_block``; ``as_tools`` hands the OTA loop ``search_memory`` /
    ``remember``.
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

    def as_tools(self) -> List[ToolSpec]:
        """The memory tools the OTA loop carries this turn (live search + capture)."""
        return [self._search_tool(), self._remember_tool()]

    def _search_tool(self) -> ToolSpec:
        user_id, repo, limit = self._user_id, self._repo, self._recall_limit

        async def search_memory(query: str) -> str:
            """Search long-term memory for facts relevant to a query.

            Use this when you need a stored detail not already in the prompt's
            memory block.

            Args:
                query: What to look for, in a few keywords.

            Returns:
                Matching memories, one per line, or a "no matches" notice.
            """
            try:
                rows = await repo.recall(user_id, query, limit=limit)
            except Exception as exc:  # noqa: BLE001 — surface to the model
                return f"Error: memory search failed: {exc}"
            if not rows:
                return "(no matching memories)"
            return "\n".join(f"- {row.content}" for row in rows)

        return FunctionToolSpec.from_raw(search_memory)

    def _remember_tool(self) -> ToolSpec:
        user_id, repo = self._user_id, self._repo

        async def remember(content: str) -> str:
            """Save a durable fact to long-term memory for future sessions.

            Use this for stable, reusable knowledge — a user preference, a
            project convention, an environment detail — NOT transient task
            state. The fact is recalled automatically when relevant later.

            Args:
                content: The fact to remember, as a self-contained sentence.

            Returns:
                A short confirmation, or an error string.
            """
            content = (content or "").strip()
            if not content:
                return "Error: remember requires non-empty content."
            try:
                await repo.create(user_id, content=content, source=_AGENT_SOURCE)
            except Exception as exc:  # noqa: BLE001 — surface to the model
                return f"Error: could not save memory: {exc}"
            return f"Remembered: {content}"

        return FunctionToolSpec.from_raw(remember)


__all__ = ["MemoryItem", "Memory", "DEFAULT_RECALL_LIMIT"]
