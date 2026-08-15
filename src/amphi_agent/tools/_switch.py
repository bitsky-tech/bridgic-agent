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
        Brief handoff or exit reason kept in the turn trace and shown to the
        next Think.

    Returns
    -------
    Any
        A switch signal consumed by the framework.
    """
    return {"mode": mode or None, "stage": stage or None, "reason": reason or None}


switch_tool = FunctionToolSpec.from_raw(switch)


__all__ = ["switch", "switch_tool"]
