"""State models owned by saved Workflow execution."""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class WorkflowStageState(BaseModel):
    """The current execution section inside one saved Workflow run."""

    mode: Literal["run_workflow"] = "run_workflow"
    stage: Literal["execute"] = "execute"
    workflow_id: str = Field(min_length=1)
    generation: Optional[str] = Field(default=None, min_length=1)
    step_index: int = Field(default=0, ge=0)

    @model_validator(mode="before")
    @classmethod
    def _restore_retired_stage(cls, value: Any) -> Any:
        """Restore legacy identity; the pinned Run checkpoint supplies its execution cursor."""
        if isinstance(value, dict) and value.get("stage") == "validate":
            return {**value, "stage": "execute"}
        return value


__all__ = [
    "WorkflowStageState",
]
