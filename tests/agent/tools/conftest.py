from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from bridgic.amphibious.builtin_tools import current_agent

from src.amphi_agent import (
    AmphiContext,
    AmphiOTAContext,
    ScheduleLibrary,
    Session,
    SkillLibrary,
    WorkflowLibrary,
    WorkflowRunLibrary,
)
from src.amphi_agent._workspace import Workspace
from src.amphi_store import Repository, SessionRecord, SessionRepository, UserRepository
from tests.agent.tools._harness import ToolHarness
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-tools"


@pytest.fixture
async def tool_harness(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[ToolHarness]:
    """Initialize the Store, Workspace, catalogues, and active Agent tool context."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded(USER_ID)
        record = SessionRecord(
            id=SESSION_ID,
            user_id=USER_ID,
            workspace_root=str(test_sandbox.sessions / SESSION_ID),
        )
        await SessionRepository().save(record)
        workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID)
        monkeypatch.setattr(workspace.environment, "prepare", lambda: None)
        await workspace.prepare_workspace()
        schedules = await ScheduleLibrary(USER_ID).load()
        skills = await SkillLibrary(USER_ID).load()
        workflows = await WorkflowLibrary(USER_ID).load()
        workflow_runs = await WorkflowRunLibrary(USER_ID).load()
        context = AmphiContext(
            session=Session(record, []),
            schedules=schedules,
            skills=skills,
            workflows=workflows,
            workflow_runs=workflow_runs,
            workspace=workspace,
        )
        ota_context = AmphiOTAContext(user_input="Exercise Agent tools")
        agent = SimpleNamespace(
            ctx=context,
            context=context,
            ota_ctx=ota_context,
            _current_ota_context=ota_context,
            _read_tracker={},
            _llm=None,
        )
        token = current_agent.set(agent)
        try:
            yield ToolHarness(test_sandbox, workspace, context, ota_context, agent)
        finally:
            current_agent.reset(token)
    finally:
        await Repository.close()


__all__ = ["ToolHarness"]
