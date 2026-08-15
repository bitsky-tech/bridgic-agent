from __future__ import annotations

from typing import Literal

from fastapi import HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from ...amphi_agent import InvocationStateError
from ...amphi_store import SessionTurnRepository
from ._base import BaseHandler


class AgentRunRequest(BaseModel):
    """Input accepted by the daemon's local Agent RPC."""

    model_config = ConfigDict(extra="forbid")

    input: str = Field(min_length=1)
    parent_tool_call_id: str | None = None
    execution_mode: Literal["request", "auto", "full"] | None = None


class AgentStatusHandler(BaseHandler):
    """Report whether this daemon owns any active Agent Invocation task."""

    tags = ["agent"]

    async def get(self) -> Response:
        return self.response({"running": self.invocations.has_running_tasks()})


class _AgentRunHandler(BaseHandler):
    async def _run(self, session_id: str, body: AgentRunRequest, *, child: bool) -> Response:
        user = await self.require_user()
        self.require_ai(user)
        await self.require_session(session_id, user)
        try:
            task = (
                await self.invocations.arun_subagent(
                    session_id,
                    body.input,
                    parent_call_id=body.parent_tool_call_id,
                    execution_mode=body.execution_mode,
                )
                if child
                else await self.invocations.arun(session_id, body.input)
            )
        except InvocationStateError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        result = await task
        return self.response({
            "session_id": result.session_id,
            "turn_id": result.turn_id,
            "disposition": result.outcome.disposition.value,
            "answer": result.outcome.answer,
        })


class AgentRunHandler(_AgentRunHandler):
    """Run or resume an existing root Session."""

    tags = ["agent"]

    async def get(self, session_id: str) -> Response:
        user = await self.require_user()
        await self.require_session(session_id, user)
        turn = await SessionTurnRepository().latest(session_id, user.id)
        return self.response({
            "session_id": session_id,
            "status": turn.status.value if turn is not None else "pending",
            "answer": turn.final_answer if turn is not None else None,
            "error": turn.error if turn is not None else None,
        })

    async def post(self, session_id: str, body: AgentRunRequest) -> Response:
        return await self._run(session_id, body, child=False)


class SubAgentRunHandler(_AgentRunHandler):
    """Create and run a Child Session under an existing Session."""

    tags = ["agent"]

    async def post(self, session_id: str, body: AgentRunRequest) -> Response:
        return await self._run(session_id, body, child=True)


__all__ = ["AgentRunHandler", "AgentStatusHandler", "SubAgentRunHandler"]
