"""State models owned by normal conversation and its mode-entry decisions."""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class NormalStageState(BaseModel):
    """The dispatchable Main position in normal chat mode."""

    mode: Literal["normal"] = "normal"
    stage: Literal["main"] = "main"


class AwaitingBuildConfirm(BaseModel):
    """Confirmation required before a Main request enters Workflow Build."""

    build_confirm: Literal[True] = True
    request_id: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    reason: Optional[str] = None


class AwaitingBuildConflict(BaseModel):
    """Build Think's semantic choice request for competing Build intents."""

    build_conflict: Literal[True] = True
    existing_stage: str = Field(min_length=1)
    existing_workflow_id: Optional[str] = None
    requested_workflow_id: Optional[str] = None
    reason: Optional[str] = None
    questions: List[dict] = Field(min_length=1)
    request_id: str = Field(min_length=1)


class AwaitingWorkflowRunChoice(BaseModel):
    """Main's semantic choice request for one unfinished private Run."""

    workflow_run_choice: Literal[True] = True
    existing_workflow_id: str = Field(min_length=1)
    requested_workflow_id: str = Field(min_length=1)
    reason: Optional[str] = None
    questions: List[dict] = Field(min_length=1)
    request_id: str = Field(min_length=1)


__all__ = [
    "NormalStageState",
    "AwaitingBuildConfirm",
    "AwaitingBuildConflict",
    "AwaitingWorkflowRunChoice",
]
