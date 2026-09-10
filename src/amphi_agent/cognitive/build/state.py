"""State models owned by the staged Workflow Build mode."""

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, model_serializer


class BuildStageState(BaseModel):
    """The current cognitive stage inside the Session's unfinished Build."""

    mode: Literal["build"] = "build"
    stage: str = Field(min_length=1)
    workflow_id: Optional[str] = Field(default=None, min_length=1)

    @model_serializer(mode="wrap")
    def _serialize(self, handler: Any) -> Dict[str, Any]:
        payload = handler(self)
        if self.workflow_id is None:
            payload.pop("workflow_id", None)
        return payload


class AwaitingTaskConfirm(BaseModel):
    task_confirm: Dict[str, Any] = Field(default_factory=dict)


class AwaitingWorkflowConfirm(BaseModel):
    workflow_confirm: Dict[str, Any] = Field(default_factory=dict)


__all__ = [
    "BuildStageState",
    "AwaitingTaskConfirm",
    "AwaitingWorkflowConfirm",
]
