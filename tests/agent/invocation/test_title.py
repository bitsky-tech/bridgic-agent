from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest

from src.amphi_agent import AgentInvocation, InvocationDisposition
from src.amphi_agent.runtime._environment import AppCommandEnvironmentSnapshot, app_command_environment
from src.amphi_service.protocol import TitleEvent
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import SessionRecord, SessionRepository
from tests._support.sandbox import IsolatedPaths
from tests.service.flows._scripted_llm import ScriptedLlm


USER_ID = "local"


async def test_title_lands_before_first_turn_finishes(
    agent_store: None,
    agent_model: str,
    test_sandbox: IsolatedPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The opening title is generated and published alongside the first Agent turn."""
    class StaticLlms:
        def __init__(self, llm: ScriptedLlm) -> None:
            self._llm = llm

        async def resolve(self, _user: Any, _model: str) -> ScriptedLlm:
            return self._llm

    environment = {
        **test_sandbox.process_environment(),
        "PATH": os.environ.get("PATH", ""),
    }
    snapshot = AppCommandEnvironmentSnapshot(
        environment=MappingProxyType(environment),
        managed_environment=MappingProxyType(dict(environment)),
        uv_executable=None,
        uv_version=None,
        python_executable=Path(sys.executable),
        python_version=sys.version.split()[0],
        node_executable=None,
        node_version=None,
    )
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)

    sessions = SessionRepository()
    session = SessionRecord(
        id="title-during-first-turn",
        user_id=USER_ID,
        workspace_root=str(test_sandbox.sessions / "title-during-first-turn"),
    )
    await sessions.save(session)

    llm = ScriptedLlm(model=agent_model, title="并行生成会话标题")
    turn_gate = llm.enqueue_blocked("The Agent turn finished.")
    session_events = SessionEventBroker()
    invocation = AgentInvocation(
        StaticLlms(llm),
        session_events,
        SystemEventBroker(),
        session_repository=sessions,
    )

    async def receive_title() -> str:
        async for event in session_events.subscribe(session.id):
            if isinstance(event, TitleEvent):
                return event.title
        raise AssertionError("Session event subscription ended before the title arrived")

    title_event = asyncio.create_task(receive_title())
    try:
        turn_task = await invocation.arun(session.id, "优化会话标题生成时机")
        await turn_gate.wait_started()

        title = await asyncio.wait_for(title_event, timeout=2)
        assert title == "并行生成会话标题"
        assert turn_task.done() is False
        persisted = await sessions.load_by_id(session.id)
        assert persisted is not None
        assert persisted.title == title

        turn_gate.release()
        result = await turn_task
        assert result.outcome.disposition is InvocationDisposition.COMPLETED
        assert result.outcome.answer == "The Agent turn finished."
        llm.assert_finished()
    finally:
        turn_gate.release()
        title_event.cancel()
        await asyncio.gather(title_event, return_exceptions=True)
        await invocation.shutdown()
