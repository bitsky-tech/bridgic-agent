from bridgic.core.agentic.tool_specs import FunctionToolSpec
from pydantic import BaseModel, Field


class SubagentRequest(BaseModel):
    """A focused goal to execute in an isolated Child Session."""

    goal: str = Field(min_length=1)


class BackgroundSubagentRequest(BaseModel):
    """A focused goal to start in an independent background Child Session."""

    goal: str = Field(min_length=1)


async def run_subagent(goal: str) -> SubagentRequest:
    """Run a focused Child Agent and wait for its final answer.

    The Child shares your workspace and permissions but has an independent
    reasoning history. The parent turn pauses until the Child finishes, then
    receives its final answer as this tool's result and continues. The Child may
    request human input while the parent remains paused. Calls issued together
    may run concurrently. Use ``start_subagent`` instead when the parent should
    continue without consuming the Child's result.

    Parameters
    ----------
    goal : str
        A complete, focused task for the Child Agent.

    Returns
    -------
    SubagentRequest
        Request resolved by the Agent runtime into the Child's final answer.
    """
    goal = goal.strip()
    if not goal:
        raise ValueError("subagent goal cannot be empty")
    return SubagentRequest(goal=goal)


async def start_subagent(goal: str) -> BackgroundSubagentRequest:
    """Start a durable background Child Session and continue immediately.

    The Child shares your workspace and permissions but keeps an independent
    reasoning history. It appears beneath the current Session so the user can
    inspect or continue it separately. The parent receives only the Child
    Session id; completion does not inject the Child's answer into the parent
    turn. Use ``run_subagent`` when the current task depends on that answer.

    Parameters
    ----------
    goal : str
        A complete, focused task for the Child Agent.

    Returns
    -------
    BackgroundSubagentRequest
        Request resolved by the Agent runtime into a Child Session id.
    """
    goal = goal.strip()
    if not goal:
        raise ValueError("subagent goal cannot be empty")
    return BackgroundSubagentRequest(goal=goal)


run_subagent_tool = FunctionToolSpec.from_raw(run_subagent)
start_subagent_tool = FunctionToolSpec.from_raw(start_subagent)

__all__ = [
    "BackgroundSubagentRequest",
    "SubagentRequest",
    "run_subagent",
    "run_subagent_tool",
    "start_subagent",
    "start_subagent_tool",
]
