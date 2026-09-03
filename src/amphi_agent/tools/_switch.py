from typing import Any

from bridgic.core.agentic.tool_specs import FunctionToolSpec


async def switch(mode: str = "", stage: str = "", reason: str = "") -> Any:
    """Move the active thinking pipeline.

    Set ``stage`` to hand off inside a model-controlled pipeline such as Build,
    or set ``mode="normal"`` to return control to Main. Workflow Run stages
    advance automatically after successful section reports and reject stage
    switches. Plain text never changes a cognitive mode or stage.

    Parameters
    ----------
    mode : str
        Use ``"normal"`` to return to Main; omit it for a handoff inside the
        current cognitive mode.
    stage : str
        Target stage in a model-controlled mode; omit for Workflow Runs and
        when only changing mode.
    reason : str
        For a Build stage handoff, provide a compact, self-contained summary
        of the stage outcome, decisive findings and user decisions, relevant
        artifacts, unresolved risks, and what the target stage should do next.
        For an exit to Main, provide a brief exit reason. The reason is kept in
        the turn trace and shown to the next Think.

    Returns
    -------
    Any
        A switch signal consumed by the framework.
    """
    return {"mode": mode or None, "stage": stage or None, "reason": reason or None}


switch_tool = FunctionToolSpec.from_raw(switch)


__all__ = ["switch", "switch_tool"]
