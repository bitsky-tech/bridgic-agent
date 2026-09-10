"""State models owned by saved Workflow execution."""

from typing import Literal

from pydantic import BaseModel, Field


class WorkflowStageState(BaseModel):
    """The current execution section inside one saved Workflow run."""

    mode: Literal["run_workflow"] = "run_workflow"
    stage: Literal["execute"] = "execute"
    workflow_id: str = Field(min_length=1)
    generation: str = Field(min_length=1)
    step_index: int = Field(default=0, ge=0)


__all__ = [
    "WorkflowStageState",
]
