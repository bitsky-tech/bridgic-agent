from typing import Any

from bridgic.core.agentic.tool_specs import FunctionToolSpec


async def switch(mode: str = "", stage: str = "", reason: str = "") -> Any:
    """Move to another permitted stage, or leave the current task.

    Set ``stage`` to a stage permitted by the current task instructions, or set
    ``mode="normal"`` to leave the task. Follow the current task's instructions
    for when to pause, stop, or finish; this call does not verify completion.
    Sections that advance automatically after successful reports do not allow
    stage switches. Plain text alone does not switch stages or leave the task.

    Parameters
    ----------
    mode : str
        Use ``"normal"`` to leave the current task; omit when selecting a stage.
    stage : str
        Target stage permitted by the current task instructions; omit when leaving.
    reason : str
        For a stage change, provide a compact, self-contained summary
        of the stage outcome, decisive findings and user decisions, relevant
        artifacts, unresolved risks, and what the target stage should do next.
        When leaving, include the reason and any new user request or unresolved
        decision so the task can continue without relying on earlier dialogue.

    Returns
    -------
    Any
        The requested mode, stage, and handoff reason.
    """
    return {"mode": mode or None, "stage": stage or None, "reason": reason or None}


switch_tool = FunctionToolSpec.from_raw(switch)


__all__ = ["switch", "switch_tool"]
