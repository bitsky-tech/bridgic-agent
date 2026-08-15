from typing import TYPE_CHECKING, Any, Dict, List, Optional

from pydantic import ConfigDict, Field
from bridgic.amphibious import Context, OTAContext

from ._browser import SessionBrowser
from ._session import Session
from ._memory import Memory
from ._schedules import ScheduleLibrary
from ._skills import SkillLibrary
from ._state import AgentState
from ._workspace import Workspace
from ._workflow_run import WorkflowRunLibrary
from ._workflows import WorkflowLibrary

if TYPE_CHECKING:
    from ._state import AwaitingSubAgent, InStage, InteractionState
    from ._invocation import AgentInvocation
else:
    AgentInvocation = Any

__all__ = ["AmphiOTAContext", "AmphiContext"]


################################################################################################################
# Small loop — one arun's observe-think-act working context
################################################################################################################


class AmphiOTAContext(OTAContext):
    """
    One arun's OTA working context — input parsing, turn trace, event sink.
    """
    stream: Optional[Any] = None
    state: AgentState = Field(default_factory=AgentState)
    browser_tool_loaded: bool = False
    workspace_tools_loaded: bool = False
    skills_tool_loaded: bool = False
    selected_skill_dirs: List[str] = Field(default_factory=list, exclude=True)
    prompt_time: str = Field(default="", exclude=True)

    input_tokens: int = 0
    output_tokens: int = 0

    ############################################################################
    # Pipeline state — ``self.state`` is the authority; these are views onto it
    ############################################################################
    @property
    def think_status(self) -> "InStage":
        return self.state.think

    @property
    def interaction_status(self) -> Optional["InteractionState"]:
        return self.state.interaction

    @property
    def subagent_status(self) -> Optional["AwaitingSubAgent"]:
        return self.state.subagents

    def transition_think(self, status: "InStage") -> None:
        self.state.to_think(status)

    def transition_interaction(self, status: Optional["InteractionState"]) -> None:
        self.state.to_interaction(status)

    def transition_subagents(self, status: Optional["AwaitingSubAgent"]) -> None:
        self.state.to_subagents(status)

    def summary(self, fields: Optional[Dict[str, Any]] = None) -> str:
        """The turn's fallback answer — the last round's thought, else ``"(no answer)"``
        (the framework's empty-result backstop; the real prompt is built by the worker)."""
        for record in reversed(self.ota_record):
            content = _view(_view(record, "think_result"), "step_content")
            if content:
                return content
        return "(no answer)"

################################################################################################################
# Big loop — the agent's cross-turn knowledge + context engineering
################################################################################################################


class AmphiContext(Context):
    """The big-loop DATA vessel the framework threads through every hook — it
    aggregates the cross-turn structures (``session``, long-term ``memory``, and
    the ``schedules`` / ``skills`` / ``workflows`` catalogues) plus the workspace.
    Pure data: no rendering, no strategy. The prompt is composed from this vessel
    by the per-concern module functions the worker calls directly."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    session: Session = Field(default_factory=Session)
    memory: Optional[Memory] = None
    schedules: Optional[ScheduleLibrary] = None
    skills: Optional[SkillLibrary] = None
    workflows: Optional[WorkflowLibrary] = None
    workflow_runs: Optional[WorkflowRunLibrary] = None
    workspace: Optional[Workspace] = None
    browser: Optional[SessionBrowser] = None
    invocations: Optional[AgentInvocation] = None
    # User/trusted-Invocation base mode; the active Think may override it at admission time.
    execution_mode: str = "auto"


################################################################################################################
# Dual-shape round accessor — read a field off a live (pydantic) or resumed (dict) round
################################################################################################################


def _view(obj: Any, name: str) -> Any:
    """Read ``name`` off a framework object OR its JSON-dump dict — one accessor for the
    live (pydantic) and resumed (dict) round shapes (``None`` for a ``None`` obj)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)
