from pathlib import Path

from bridgic.amphibious import StepToolCall, ToolArgument

from src.amphi_agent import Session
from src.amphi_agent._workspace import Workspace
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-cognitive"
WORKFLOW_ID = "workflow-cognitive"
GENERATION = "generation-cognitive"


def make_session(root: Path) -> Session:
    return Session(SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root=str(root),
    ), [])


def make_workspace(paths: IsolatedPaths, name: str) -> Workspace:
    root = paths.sessions / name
    (root / ".work").mkdir(parents=True)
    return Workspace(SESSION_ID, root)


def tool_call(tool: str, **arguments: str) -> StepToolCall:
    return StepToolCall(
        tool=tool,
        tool_arguments=[
            ToolArgument(name=name, value=value)
            for name, value in arguments.items()
        ],
    )


def write_workflow_source(root: Path) -> None:
    workflow = root / "workflow"
    workflow.mkdir(parents=True, exist_ok=True)
    (workflow / "WORKFLOW.md").write_text(
        """---
name: cognitive-report
description: Create a deterministic report
---
# Create the report
Write the requested summary to result/report.md.
""",
        encoding="utf-8",
    )
    (workflow / "VALIDATE.md").write_text(
        """# Validate the report
Confirm result/report.md contains the requested summary.
""",
        encoding="utf-8",
    )


__all__ = [
    "GENERATION",
    "SESSION_ID",
    "USER_ID",
    "WORKFLOW_ID",
    "make_session",
    "make_workspace",
    "tool_call",
    "write_workflow_source",
]
