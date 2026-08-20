import pytest

from src.amphi_agent._workspace import Workspace
from tests._support.sandbox import IsolatedPaths


@pytest.fixture
async def agent_workspace(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> Workspace:
    """Prepare one isolated Session Workspace without the shared app runtime."""
    workspace = Workspace("session-workspace", test_sandbox.sessions / "session-workspace")
    monkeypatch.setattr(workspace.environment, "prepare", lambda: None)
    await workspace.prepare_workspace()
    return workspace
