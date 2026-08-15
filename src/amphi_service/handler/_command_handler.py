from fastapi import Response, status

from ...amphi_store import SessionRepository, SessionTurnRepository
from ._base import BaseHandler


class ResetHandler(BaseHandler):
    """Bind: ``POST /sessions/{session_id}/reset`` — clear conversation."""

    tags = ["commands"]

    async def post(self, session_id: str) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        self.require_no_running_turn(session_id)
        tree = await SessionRepository().list_tree(user.id, record.id)
        await self.invocations.reset_session(record.id)
        await self.sessions.clear_attachments(tree[1:])
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class TokensHandler(BaseHandler):
    """Bind: ``GET /sessions/{session_id}/tokens`` — accumulated token count."""

    tags = ["commands"]

    async def get(self, session_id: str) -> Response:
        user = await self.require_user()
        record = await self.require_session(session_id, user)
        summary = await SessionTurnRepository().load_summary(record)
        return self.response({"tokens": summary.tokens})


class StopHandler(BaseHandler):
    """Bind: ``POST /sessions/{session_id}/stop`` — stop the in-flight turn.

    Ungated on purpose: it exists *to* interrupt a running turn. Parked Child
    Agent turns are terminalized too, allowing a blocking parent batch to join.
    An idle terminal Session remains an idempotent ``{"stopped": false}`` no-op.

    AgentInvocation checkpoints completed rounds and marks the active Session
    Turn cancelled. Session event subscriptions remain open for later attempts.
    """

    tags = ["commands"]

    async def post(self, session_id: str) -> Response:
        user = await self.require_user()
        await self.require_session(session_id, user)
        stopped = await self.invocations.cancel(session_id)
        return self.response({"stopped": stopped, "session_id": session_id})


class ReadHandler(BaseHandler):
    """Bind: ``POST /sessions/{session_id}/read`` — clear the unread mark.

    The read receipt for the GUI's per-session unread dot. A finished turn
    leaves the session ``completed`` (unread) and broadcasts a
    ``session.completed`` system event; when the user opens the session the GUI
    posts here and the session flips back to ``finish`` so the dot clears (until
    the next turn completes). Ownership-gated; idempotent — a session that isn't
    unread is a clean no-op.
    """

    tags = ["commands"]

    async def post(self, session_id: str) -> Response:
        user = await self.require_user()
        await self.require_session(session_id, user)
        await SessionRepository().mark_read(session_id, user.id)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class InteractionHandledHandler(BaseHandler):
    """Legacy bind: ``POST /sessions/{session_id}/answered`` for older clients.

    Current clients submit one answer frame; :class:`AgentInvocation` consumes
    the parked interaction and clears its Session projection atomically with
    scheduling. This ownership-gated, idempotent endpoint remains compatible
    with clients that still send the historical second receipt.
    """

    tags = ["commands"]

    async def post(self, session_id: str) -> Response:
        user = await self.require_user()
        await self.require_session(session_id, user)
        await SessionRepository().mark_interaction_handled(session_id, user.id)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = [
    "ResetHandler",
    "TokensHandler",
    "StopHandler",
    "ReadHandler",
    "InteractionHandledHandler",
]
