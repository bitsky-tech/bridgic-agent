import copy
from typing import List, Optional, Sequence

from ..amphi_store import (
    SessionRecord,
    SessionTurnRecord,
)


class Session:
    """Agent-facing in-memory view of one Session and its conversation Turns.

    Parameters
    ----------
    record : Optional[SessionRecord]
        Persisted Session metadata. Omit for an isolated reasoning run.
    turns : Optional[Sequence[SessionTurnRecord]]
        Ordered top-level Turns selected by the runtime.
    """

    def __init__(
        self,
        record: Optional[SessionRecord] = None,
        turns: Optional[Sequence[SessionTurnRecord]] = None,
    ) -> None:
        self._turns = list(turns or [])
        self.id = record.id if record else None
        self.user_id = record.user_id if record else None
        self.workspace_root = record.workspace_root if record else None
        self.title = record.title if record else None
        self.parent_session_id = record.parent_session_id if record else None
        self.subagent_mode = record.subagent_mode if record else None
        # How this run was originated; scheduled runs are gated from creating
        # more schedules (self-propagation guard, see tools/_schedule.py).
        self.kind = record.kind if record else None

    @property
    def is_child(self) -> bool:
        """Return whether this Session was created by another Agent Session."""
        return self.parent_session_id is not None

    def get_all(self) -> List[SessionTurnRecord]:
        """Return all selected Turns in conversation order."""
        return list(self._turns)

    def without_last(self) -> "Session":
        """Return a shallow Session copy without its trailing Turn."""
        scoped = copy.copy(self)
        scoped._turns = self._turns[:-1]
        return scoped

__all__ = ["Session"]
