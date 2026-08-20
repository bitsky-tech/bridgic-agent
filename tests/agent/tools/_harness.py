from dataclasses import dataclass
from types import SimpleNamespace

from src.amphi_agent import AmphiContext, AmphiOTAContext
from src.amphi_agent._workspace import Workspace
from tests._support.sandbox import IsolatedPaths


@dataclass(frozen=True)
class ToolHarness:
    """One real isolated Agent context bound to tool ContextVars."""

    paths: IsolatedPaths
    workspace: Workspace
    context: AmphiContext
    ota_context: AmphiOTAContext
    agent: SimpleNamespace


__all__ = ["ToolHarness"]
