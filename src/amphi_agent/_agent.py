import asyncio
import json
import logging
import re
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from uuid import uuid4

from bridgic.amphibious import (
    ActionResult,
    ActionStepResult,
    AmphibiousAutoma,
    RETURN,
    StepToolCall,
    ThinkUnit,
    think_unit,
    OTARecord,
)
from bridgic.amphibious._amphibious_automa import _decision_to_matched_calls
from bridgic.amphibious._type import ThinkResult  # the worker's decision (step_content + tool_calls)
from bridgic.core.agentic import ConcurrentAutoma
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.automa.args import ArgsMappingRule, InOrder
from bridgic.core.model.types import Message, Role, ToolCall

from ._cognitive import (
    MainThink,
    SubAgentThink,
    render_input,
)
from .cognitive import (
    PRESENTATION_STAGE_ARTIFACTS,
    PRESENTATION_STAGE_ORDER,
    PRESENTATION_STAGE_STEPS,
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    PresentationBriefThink,
    PresentationComposeThink,
    PresentationPlanThink,
    PresentationReviewThink,
    VerifyThink,
    WorkflowThink,
)
from ._context import AmphiContext, AmphiOTAContext, ContextUsageSnapshot
from ._describe import describe_commands
from ._error import AgentEmptyAnswerError
from ._prompt import TITLE_PROMPT
from ._state import (
    AgentResult,
    AwaitingPermission,
    AwaitingFeedback,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingPresentationOutlineConfirm,
    AwaitingWorkflowRunChoice,
    BuildStageState,
    AwaitingSubAgent,
    ContextCompactionState,
    NormalStageState,
    PresentationStageState,
    PresentationStepRecord,
    RoundPermission,
    CallVerdict,
    SubAgentCall,
    SubAgentsCompleted,
    WorkflowStageState,
)
from ._workspace import RunWorkflowState
from .security import ExecutionMode, LlmSafetyClassifier, Permission, PermissionEngine
from .security._audit import append_decisions, write_approval_record
from .security._routing import append_user_decisions, read_user_decisions
from .security._classifier import MAX_USER_MESSAGES as _CLASSIFIER_MAX_USER_MESSAGES
from .security._classify import label_text
from .security._engine import model_facing_reason
from .tools._request_human import (
    RequestBuild,
    RequestPresentation,
    RequestRunWorkflow,
    RequestHumanChoice,
    RequestHumanTaskConfirm,
    RequestHumanWorkflowConfirm,
)
from .tools._bash import current_execution_mode, current_tool_call_id
from .tools._presentation import PresentationStepReport
from .tools._subagent import BackgroundSubagentRequest, SubagentRequest
from .tools._workflow import EditWorkflow, WorkflowStepReport
from ..amphi_store import (
    SessionTurnRecord,
    TurnStatus,
    UserInput,
    WorkflowRunStatus,
)
from ..amphi_service.i18n import activate_locale, backend_i18n, detect_locale
from ..amphi_service.protocol._ws_messages import (
    WsChatMessage,
    WsMentionBlock,
    WsSlashBlock,
    WsTextBlock,
)

logger = logging.getLogger(__name__)

# Constants
DEFAULT_MAX_ROUNDS = 200
MAX_THINK_UNITS_PER_TURN = 50
MAX_EMPTY_ANSWER_RECOVERY_ATTEMPTS = 3
TITLE_MAX_LEN = 40
TOOL_RESULT_INLINE_CHAR_LIMIT = 16 * 1024

EMPTY_SUCCESS_TOOL_RESULT = "(tool completed successfully with no output)"

__all__ = ["AmphiAgent", "DEFAULT_MAX_ROUNDS"]

# Context-injection boundary for the safety classifier (see AmphiAgent._recent_user_messages
# / _current_reasoning / _session_approvals).
# The cap on user requests comes from _classifier — do not write another literal here. The
# prompt-assembly side must truncate to the same number, and having a 5 in each place makes
# "raising the injection-side cap" completely ineffective (a debugging trap hit in practice).
_MAX_CLASSIFIER_USER_MESSAGES = _CLASSIFIER_MAX_USER_MESSAGES  # cap on multi-round user requests fed to the classifier (trusted authorization evidence)
_MAX_CLASSIFIER_REASONING_CHARS = 2000   # cap on the Agent reasoning slice to be verified (bounds prompt size + injection surface)
_MAX_CLASSIFIER_APPROVALS = 8            # cap on this session's already-made decisions fed to the classifier (trusted, equivalent to the user naming them)
_MAX_CLASSIFIER_NAMED_PATHS = 8          # cap on local paths the user named in the conversation (does not slide out with the message window)

# **Absolute local paths** appearing in user messages. The policy's ALLOW entry 'project
# directory named by the user' only recognises paths the user actually named, while the message
# window keeps only the last 5 — once the naming message slides out, that exception silently
# stops applying. So paths are extracted separately and accumulated.
# The key is **the character before it**: a slash directly following a word character / ``.`` /
# ``:`` / ``/`` is not the start of a path, which rules out slash-separated phrases like
# CJK compounds joined by a slash (CJK counts as ``\w``), English "and/or", relative paths
# "./x" and URLs "https://host/path"; the path itself may contain Unicode
# (non-ASCII directory names are common). Windows drive paths accept
# both ``\`` and ``/``; when a path contains spaces it must be delimited by markdown backticks
# or ordinary quotes, so trailing prose is not swallowed into the path.
_NAMED_PATH_RE = re.compile(
    r"""(?x)
    (?:
        (?P<quote>[`'"])
        (?P<quoted_windows>[A-Za-z]:[\\/][^`'"\r\n]+)
        (?P=quote)
      |
        (?<![\w.:/])
        (?P<plain>
            ~?/[\w._~/@+-]{3,}
          |
            [A-Za-z]:[\\/][^\s<>:"|?*`'"]+
        )
    )
    """
)

################################################################################################################
# AmphiAgent
################################################################################################################
class AmphiAgent(AmphibiousAutoma[AmphiOTAContext, AmphiContext]):
    """A general-purpose agent on the Amphibious framework.

    Parameters
    ----------
    max_rounds : int
        Hard cap on the observe-think-act rounds per stage for one turn
        (applied as each stage's ThinkUnit ``max_attempts`` in on_agent).
    verbose : bool
        When True, the framework prints its internal run summary.
    """

    # Autonomous agent loop.
    main = think_unit(MainThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    subagent = think_unit(SubAgentThink(), max_attempts=DEFAULT_MAX_ROUNDS)

    # Build pipeline — one think unit per stage, dispatched by on_agent.
    clarify = think_unit(ClarifyThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    explore = think_unit(ExploreThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    generate = think_unit(GenerateThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    verify = think_unit(VerifyThink(), max_attempts=DEFAULT_MAX_ROUNDS)

    # Presentation pipeline — brief, plan, compose, and review the live deck.
    ppt_brief = think_unit(PresentationBriefThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    ppt_plan = think_unit(PresentationPlanThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    ppt_compose = think_unit(PresentationComposeThink(), max_attempts=DEFAULT_MAX_ROUNDS)
    ppt_review = think_unit(PresentationReviewThink(), max_attempts=DEFAULT_MAX_ROUNDS)

    # Saved Workflow runtime.
    execute = think_unit(WorkflowThink(), max_attempts=DEFAULT_MAX_ROUNDS)

    def __init__(self, max_rounds: int = DEFAULT_MAX_ROUNDS, verbose: bool = False) -> None:
        super().__init__(verbose=verbose)
        self._max_rounds = max_rounds
        self._agent_result: Optional[AgentResult] = None
        self.no_display_tools = set([
            "switch",
            "help",
            "edit_workflow",
            "request_build",
            "request_presentation",
            "request_run_workflow",
            "request_human_choice",
            "request_human_task_confirm",
            "request_human_workflow_confirm",
            "report_presentation_step",
            "report_workflow_step",
            "run_subagent",
            "start_subagent",
        ])
        self.exclusive_control_tools = {
            "switch",
            "edit_workflow",
            "request_build",
            "request_presentation",
            "request_run_workflow",
            "request_human_choice",
            "request_human_task_confirm",
            "request_human_workflow_confirm",
            "report_presentation_step",
            "report_workflow_step",
        }

        self.thinking_modes = {
            "build": ("clarify", "explore", "generate", "verify"),
            "presentation": ("ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"),
            "run_workflow": ("execute",),
        }


    ############################################################################
    # Core Method
    ############################################################################
    async def arun(self, *, llm: Any = None, context: AmphiContext, ota_context: Optional[AmphiOTAContext] = None, **kwargs: Any) -> AgentResult:
        """Run one Agent turn while preserving structured control outcomes.

        Parameters
        ----------
        llm : Any, optional
            Model client used by the cognitive workers.
        context : AmphiContext
            Hydrated cross-turn Agent context.
        ota_context : AmphiOTAContext, optional
            Small-loop context for this attempt.
        **kwargs : Any
            Remaining framework run options.

        Returns
        -------
        AgentResult
            Final text or one structured runtime control outcome.

        Notes
        -----
        Bridgic currently stringifies top-level ``RETURN`` values in AGENT mode,
        so this boundary retains the typed value emitted by :meth:`on_agent`.
        """
        self._agent_result = None
        await super().arun(llm=llm, context=context, ota_context=ota_context, **kwargs)
        if self._agent_result is None:
            raise RuntimeError("Agent run completed without a structured result")
        return self._agent_result

    async def on_agent(self, ota_context: AmphiOTAContext, context: AmphiContext):
        # 1. Open the turn - Init agent loop status
        await self.init_state(ota_context, context)
        current_status = ota_context.think_status
        current_stage = self._current_think_unit_name(ota_context, context)
        self._publish_stage(ota_context, current_status)
        if isinstance(current_status, WorkflowStageState):
            self._publish_workflow_progress(ota_context, context, current_status, "running")

        # 2. Walk the agent loop.
        answer: Optional[AgentResult] = None
        budget = MAX_THINK_UNITS_PER_TURN
        empty_answer_recovery_attempts = 0
        while budget > 0:
            # Stop before another think unit when the turn is already parked.
            if ota_context.interaction_status is not None:
                answer = ota_context.interaction_status
                break

            answer = yield ThinkUnit(
                current_stage,
                max_attempts=self._max_rounds,
                until=lambda c, s=current_status: (
                    c.think_status != s
                    or c.interaction_status is not None
                    or getattr(c, "subagent_status", None) is not None
                ),
            )
            budget -= 1

            # 1. Interaction Status to control flow
            if ota_context.interaction_status is not None:
                answer = ota_context.interaction_status
                break

            # 2. Subagent Status to control flow
            if isinstance(ota_context.subagent_status, AwaitingSubAgent):
                answer = ota_context.subagent_status
                break

            # 3. Think-stage control flow (only reached when NOT parked).
            next_status = ota_context.think_status
            if isinstance(next_status, NormalStageState):
                if next_status != current_status:
                    current_status = next_status
                    current_stage = self._current_think_unit_name(ota_context, context)
                    self._publish_stage(ota_context, next_status)
                    budget = max(budget, 1)
                    continue
                if not answer:
                    if empty_answer_recovery_attempts >= MAX_EMPTY_ANSWER_RECOVERY_ATTEMPTS:
                        raise AgentEmptyAnswerError(empty_answer_recovery_attempts)
                    empty_answer_recovery_attempts += 1
                    self._stamp_continue(ota_context)
                    budget = max(budget, 1)
                    continue
                break
            elif isinstance(next_status, BuildStageState):
                if next_status != current_status:
                    current_status = next_status
                    current_stage = self._current_think_unit_name(ota_context, context)
                    self._publish_stage(ota_context, next_status)
                else:
                    self._stamp_build_continue(ota_context)
                continue
            elif isinstance(next_status, PresentationStageState):
                if next_status != current_status:
                    current_status = next_status
                    current_stage = self._current_think_unit_name(ota_context, context)
                    self._publish_stage(ota_context, next_status)
                else:
                    self._stamp_presentation_continue(ota_context)
                continue
            elif isinstance(next_status, WorkflowStageState):
                if next_status != current_status:
                    entering_workflow = not isinstance(current_status, WorkflowStageState)
                    current_status = next_status
                    current_stage = self._current_think_unit_name(ota_context, context)
                    self._publish_stage(ota_context, next_status)
                    self._publish_workflow_progress(ota_context, context, next_status, "running")
                    if entering_workflow:
                        budget = max(
                            budget,
                            self._workflow_remaining_units(next_status, context) + 1,
                        )
                else:
                    self._stamp_workflow_continue(ota_context)
                continue
            raise RuntimeError(f"Unsupported think state: {type(next_status).__name__}")

        if not answer:
            raise RuntimeError("Agent think-unit budget exhausted before producing an answer")
        self._agent_result = answer
        yield RETURN(answer)

    async def before_action(self, ota_context: AmphiOTAContext, context: AmphiContext):
        decision = ota_context.think_result
        calls = getattr(decision, "tool_calls", None) or []
        current_ota_permission_status: RoundPermission = self._get_current_ota_permission_status(ota_context)
        effective_execution_mode = (
            current_ota_permission_status.execution_mode
            or self._effective_execution_mode(ota_context, context)
        )

        duplicate_verdicts = self._duplicate_tool_call_verdicts(calls)
        if duplicate_verdicts is not None:
            ota_context.ota_record[-1].permission = RoundPermission(
                execution_mode=effective_execution_mode,
                reviewed=current_ota_permission_status.reviewed,
                verdicts=duplicate_verdicts,
            )
            yield RETURN(decision.model_copy(update={"tool_calls": []}))
            return

        ########################
        # Tool Permission Check
        ########################
        if not current_ota_permission_status.reviewed:  # if not reviewed, using permission_check to check the permission
            verdicts = await self.permission_check(
                ota_context,
                context,
                execution_mode=effective_execution_mode,
            )
            if any(v.verdict == Permission.ASK.value for v in verdicts):  # If any ask, interaction with the user to get the approval
                ask = [
                    (i, c, v)
                    for i, (c, v) in enumerate(zip(calls, verdicts))
                    if v.verdict == Permission.ASK.value
                ]
                questions = [
                    {
                        "question": "Approve {}({})?".format(
                            c.tool,
                            ", ".join(f"{name}={value}" for name, value in self._tool_args(c).items()),
                        ),
                        "options": [{"label": "allow"}, {"label": "deny"}],
                    }
                    for _, c, v in ask
                ]
                # Plain-language summary: independent of the safety classifier, generated for every
                # ASK command (present in every execution mode, so the approval card's
                # plain-language/command toggle always works); on failure it falls back to an empty
                # string and the frontend shows the raw command.
                summaries = await describe_commands(
                    self.llm,
                    [{"tool": c.tool, "arguments": self._tool_args(c)} for _, c, _ in ask],
                )
                items = [
                    {
                        "call_index": i,
                        "tool": c.tool,
                        "arguments": self._tool_args(c),
                        "capability": v.capability,
                        "boundary": v.boundary,
                        "label": v.reason or "",
                        "label_id": v.label_id,
                        "summary": summaries[k] if k < len(summaries) else "",
                        # Objective decision flags: the approval card derives the risk level and
                        # high-risk stripping from them. The frontend must not parse the label — on
                        # the auto path that is free text generated by the classifier.
                        "sensitive": v.sensitive,
                        "deletion": v.deletion,
                        "regenerable": v.regenerable,
                        "uncertain_destruction": v.uncertain_destruction,
                        "touches_risk_surface": v.touches_risk_surface,
                    }
                    for k, (i, c, v) in enumerate(ask)
                ]
                permission = {
                    "calls": [c.model_dump() for c in calls],
                    "verdicts": [v.verdict for v in verdicts],
                    "questions": questions,
                    "items": items,
                    "execution_mode": effective_execution_mode,
                }
                request_id = uuid4().hex
                # Approval record: the full command + judgement + explanation are written to the
                # session's permissions directory (under a readable filename) for later auditing.
                workspace = context.workspace
                audit_path = write_approval_record(
                    workspace.permission_dir if workspace is not None else None,
                    request_id,
                    effective_execution_mode,
                    [
                        {
                            "tool": c.tool,
                            "arguments": self._tool_args(c),
                            "capability": v.capability,
                            "boundary": v.boundary,
                            "reason": model_facing_reason(v),
                            "summary": summaries[k] if k < len(summaries) else "",
                        }
                        for k, (i, c, v) in enumerate(ask)
                    ],
                )
                if audit_path is not None:
                    permission["audit_file"] = str(audit_path)

                # Transition to AwaitingPermission
                ota_context.transition_interaction(AwaitingPermission(permission=permission, request_id=request_id))
                logger.warning(
                    "[permission] approval parked request_id=%s asks=%d denies=%d tools=%s audit=%s",
                    request_id,
                    len(ask),
                    sum(1 for v in verdicts if v.verdict == Permission.DENY.value),
                    [c.tool for _, c, _ in ask],
                    audit_path.name if audit_path is not None else "-",
                )
                yield RETURN(decision.model_copy(update={"tool_calls": []}))
                return
        else:  # if reviewed, using the reviewed verdicts verbatim
            verdicts = self._reviewed_verdicts(current_ota_permission_status.verdicts)

        ########################
        # Tool Legality Check
        ########################
        verdicts = await self.legality_check(ota_context, context, calls, verdicts)

        ########################
        # Run Action Tool Call
        ########################
        ota_context.ota_record[-1].permission = RoundPermission(
            execution_mode=effective_execution_mode,
            reviewed=current_ota_permission_status.reviewed,
            verdicts=verdicts,
            items=current_ota_permission_status.items,
        )
        executable_calls = [
            call for call, verdict in zip(calls, verdicts)
            if verdict.verdict == Permission.ALLOW.value
        ]
        yield RETURN(decision.model_copy(update={"tool_calls": executable_calls}))

    async def action_tool_call(self, ota_context: AmphiOTAContext, context: AmphiContext) -> ActionResult:
        decision = ota_context.think_result
        stream = ota_context.stream

        # Push tool_calls to stream except internal control-flow tools.
        if stream is not None and decision is not None:
            for call in decision.tool_calls:
                if getattr(call, "tool", None) in self.no_display_tools:
                    continue
                stream.publish(
                    "tool",
                    tool_id=call.call_id,
                    tool_name=call.tool,
                    arguments=self._tool_args(call),
                )

        # Run Action
        start = time.monotonic()
        result = await self._execute_tool_calls(ota_context, context)
        gate = self._get_current_ota_permission_status(ota_context)
        for cv in gate.verdicts:
            if cv.verdict == Permission.DENY.value:
                result.results.append(self._denied_step(cv))
        self._save_large_tool_results(result, context)
        duration_ms = int((time.monotonic() - start) * 1000)
        ota_context._current_record().act_duration_ms = duration_ms

        # Push tool result to stream except internal control-flow tools
        if stream is not None and result is not None:
            for step in getattr(result, "results", None) or []:
                if step.tool_name in self.no_display_tools:
                    continue
                stream.publish(
                    "tool_result",
                    tool_id=step.tool_id,
                    success=bool(step.success),
                    error=step.error,
                    output=str(step.tool_result if step.tool_result is not None else ""),
                    duration_ms=duration_ms,
                )

        return result

    async def _execute_tool_calls(
        self,
        ota_context: AmphiOTAContext,
        context: Optional[AmphiContext] = None,
    ) -> ActionResult:
        """Execute admitted calls and fail every unmatched call explicitly."""
        decision = ota_context.think_result
        calls = list(getattr(decision, "tool_calls", None) or [])
        duplicate_verdicts = self._duplicate_tool_call_verdicts(calls)
        if duplicate_verdicts is not None:
            return ActionResult(results=[
                self._denied_step(verdict) for verdict in duplicate_verdicts
            ])
        visible_names = {spec.tool_name for spec in ota_context.tools}
        executable = [
            call for call in calls
            if getattr(call, "call_id", None) and getattr(call, "tool", None) in visible_names
        ]
        executable_decision = decision.model_copy(update={"tool_calls": executable})
        matched = _decision_to_matched_calls(executable_decision, ota_context.tools)
        gate = self._get_current_ota_permission_status(ota_context)
        effective_execution_mode = (
            gate.execution_mode
            or (
                self._effective_execution_mode(ota_context, context)
                if context is not None
                else None
            )
        )

        async def run_one(tool_call: ToolCall, tool_spec: ToolSpec) -> ActionStepResult:
            call_token = current_tool_call_id.set(tool_call.id)
            mode_token = current_execution_mode.set(effective_execution_mode)
            try:
                sandbox = ConcurrentAutoma()
                sandbox.add_worker(
                    key=f"tool_{tool_call.name}_{tool_call.id}",
                    worker=tool_spec.create_worker(),
                    args_mapping_rule=ArgsMappingRule.UNPACK,
                )
                try:
                    results = await sandbox.arun(InOrder([tool_call.arguments]))
                    return ActionStepResult(
                        tool_id=tool_call.id,
                        tool_name=tool_call.name,
                        tool_arguments=tool_call.arguments,
                        tool_result=results[0] if results else None,
                        success=True,
                    )
                except Exception as exc:  # noqa: BLE001 - tool failures are action results
                    return ActionStepResult(
                        tool_id=tool_call.id,
                        tool_name=tool_call.name,
                        tool_arguments=tool_call.arguments,
                        tool_result=None,
                        success=False,
                        error=str(exc),
                    )
            finally:
                current_execution_mode.reset(mode_token)
                current_tool_call_id.reset(call_token)

        executed = await asyncio.gather(*(run_one(call, spec) for call, spec in matched))
        executed_by_id = {step.tool_id: step for step in executed}
        results: List[ActionStepResult] = []
        for index, call in enumerate(calls):
            call_id = str(getattr(call, "call_id", None) or f"unavailable_{index}")
            completed = executed_by_id.get(call_id)
            if completed is not None:
                results.append(completed)
                continue
            tool_name = str(getattr(call, "tool", None) or "(unknown)")
            reason = (
                f"tool `{tool_name}` is not available in this Session's current ToolSurface."
                if tool_name not in visible_names
                else f"tool `{tool_name}` was not executed because its call id is missing."
            )
            results.append(ActionStepResult(
                tool_id=call_id,
                tool_name=tool_name,
                tool_arguments=self._tool_args(call),
                tool_result=None,
                success=False,
                error=reason,
            ))
        return ActionResult(results=results)

    async def after_action(self, ota_context: AmphiOTAContext, context: AmphiContext) -> None:
        """Apply this round's control-flow tools and fold denied calls.

        switch: re-aim the think dimension (mode + stage).
        request_human_choice: end the turn awaiting the user.
        request_build: enter Build or ask how to resolve Build intent.
        request_presentation: enter the dedicated presentation pipeline.
        report_presentation_step: retain one production result and advance its cursor.
        request_run_workflow: start or resolve one Session-owned Run.
        edit_workflow: restore one saved Workflow into Build for modification.
        report_workflow_step: persist one section result and advance or stop.
        request_human_task_confirm: park Clarify for task-definition review.
        run_subagent: collect every allowed delegation into one runtime batch.
        start_subagent: create a background Child Session and continue.

        Also surfaces an ALL-denied round: when before_action drops every call, the
        framework skips action_tool_call (empty tool_calls) and the blocked calls are
        never folded — do it here (always runs) onto a fresh action_result, or the
        model re-loops the stage blind to why a call was vetoed. (The permission PARK
        records no round permission, so it is untouched by this fold.)
        """
        gate = self._get_current_ota_permission_status(ota_context)
        effective_execution_mode = (
            gate.execution_mode or self._effective_execution_mode(ota_context, context)
        )
        denied = [cv for cv in gate.verdicts if cv.verdict == Permission.DENY.value]
        if denied and ota_context.action_result is None:
            ota_context.action_result = ActionResult(results=[self._denied_step(cv) for cv in denied])

        subagent_calls: List[SubAgentCall] = []
        for step in getattr(ota_context.action_result, "results", None) or []:
            if not step.success:
                continue

            # Switch
            if step.tool_name == "switch":
                sig = step.tool_result
                current_status = ota_context.think_status
                target_mode = sig.get("mode") or current_status.mode
                if (
                    isinstance(current_status, WorkflowStageState)
                    and target_mode != "normal"
                ):
                    raise ValueError(
                        "Workflow stages advance automatically; switch only exits to normal mode."
                    )
                else:
                    next_status = self._switch_status(
                        current_status,
                        target_mode,
                        sig.get("stage"),
                    )
                if isinstance(current_status, PresentationStageState) and isinstance(next_status, PresentationStageState):
                    current_index = PRESENTATION_STAGE_ORDER.index(current_status.stage)
                    target_index = PRESENTATION_STAGE_ORDER.index(next_status.stage)
                    if target_index <= current_index:
                        self._invalidate_presentation_artifacts(
                            context,
                            PRESENTATION_STAGE_ORDER[target_index:],
                        )
                ota_context.transition_think(next_status)
                if sig.get("reason") and not isinstance(next_status, NormalStageState):
                    self._stamp_stage_handoff(ota_context, current_status, next_status, sig["reason"])
                if isinstance(next_status, BuildStageState):
                    await self._sync_build_space(ota_context, context)
                elif isinstance(next_status, NormalStageState):
                    self._stamp_mode_exit(ota_context, current_status, sig.get("reason"))
                    if isinstance(current_status, BuildStageState):
                        self._close_build_bindings(context)
                    elif isinstance(current_status, WorkflowStageState):
                        self._close_run_workflow_bindings(context)

            # Request Presentation
            elif step.tool_name == "request_presentation":
                result = step.tool_result
                if isinstance(result, RequestPresentation):
                    self._invalidate_presentation_artifacts(context, PRESENTATION_STAGE_ORDER)
                    ota_context.transition_think(PresentationStageState(goal=result.goal))
                    step.tool_result = {
                        "mode": "presentation",
                        "stage": "ppt_brief",
                        "goal": result.goal,
                        "message": "The presentation request entered the dedicated pipeline.",
                    }

            # Complete current Presentation production step
            elif step.tool_name == "report_presentation_step":
                result = step.tool_result
                current_status = ota_context.think_status
                if isinstance(result, PresentationStepReport) and isinstance(current_status, PresentationStageState):
                    stage_steps = PRESENTATION_STAGE_STEPS.get(current_status.stage, ())
                    if current_status.step_index >= len(stage_steps):
                        raise RuntimeError("Cannot report a completed Presentation stage.")
                    current_step = stage_steps[current_status.step_index]
                    report = PresentationStepRecord(
                        stage=current_status.stage,
                        step_id=current_step.step_id,
                        summary=result.summary,
                        evidence=result.evidence,
                    )
                    reports = [
                        item
                        for item in current_status.reports
                        if (item.stage, item.step_id) != (report.stage, report.step_id)
                    ]
                    reports.append(report)
                    next_status = current_status.apply_plan_step_data(
                        current_step.step_id,
                        result.data,
                    ).model_copy(update={
                        "step_index": current_status.step_index + 1,
                        "reports": reports,
                    })
                    if current_status.stage == "ppt_plan" and current_step.step_id == "map_slides":
                        request_id = f"presentation_outline_{uuid4().hex}"
                        next_status = next_status.model_copy(update={
                            "outline_confirmed": False,
                            "outline_confirmation_id": request_id,
                        })
                        ota_context.transition_interaction(AwaitingPresentationOutlineConfirm(
                            request_id=request_id,
                        ))
                    ota_context.transition_think(next_status)
                    step.tool_result = {
                        "mode": "presentation",
                        "stage": current_status.stage,
                        "step_index": current_status.step_index,
                        "step_count": len(stage_steps),
                        "step_id": current_step.step_id,
                        "summary": result.summary,
                        "evidence": result.evidence,
                        "data": result.data,
                        "next_step_index": next_status.step_index,
                    }
                    if current_status.stage == "ppt_plan" and current_step.step_id == "map_slides":
                        step.tool_result.update({
                            "outline_confirmation_id": next_status.outline_confirmation_id,
                            "status": "awaiting_outline_confirmation",
                        })
                        if ota_context.stream is not None:
                            self._publish_stage(ota_context, next_status)

            # Request Build
            elif step.tool_name == "request_build":
                result = step.tool_result
                if isinstance(result, RequestBuild):
                    if result.mode == "start":
                        workflow_id = self._requested_edit_workflow_id(ota_context)
                        ota_context.transition_think(BuildStageState(
                            stage="clarify",
                            workflow_id=workflow_id,
                        ))
                        await self._sync_build_space(ota_context, context, create=True)
                        step.tool_result = {
                            "mode": "start",
                            "goal": result.goal,
                            **({"workflow_id": workflow_id} if workflow_id else {}),
                            "message": "The user's explicit Workflow request entered a new Build.",
                        }
                    else:
                        workspace = context.workspace
                        retained = workspace.build_checkpoint() if workspace is not None else None
                        if retained is None:
                            step.tool_result = {
                                "mode": "ask",
                                "request_id": result.request_id,
                                "goal": result.goal,
                                "reason": result.reason,
                                "status": "pending",
                            }
                            ota_context.transition_interaction(AwaitingBuildConfirm(
                                request_id=result.request_id,
                                goal=result.goal,
                                reason=result.reason,
                            ))
                        else:
                            conflict = self._build_request_interaction(
                                context,
                                result,
                                requested_workflow_id=self._requested_edit_workflow_id(ota_context),
                            )
                            ota_context.transition_interaction(conflict)
                            step.tool_result = {
                                "mode": "ask",
                                "goal": result.goal,
                                **conflict.model_dump(mode="json"),
                                "status": "pending",
                            }

            # Edit Workflow
            elif step.tool_name == "edit_workflow":
                result = step.tool_result
                if isinstance(result, EditWorkflow):
                    workflows = context.workflows
                    session_id = context.session.id
                    workflow = workflows.get(result.workflow_id) if workflows is not None else None
                    if workflows is not None and session_id:
                        await workflows.associate_session(session_id, result.workflow_id)
                    existing = await self._enter_or_resume_build(
                        ota_context,
                        context,
                        result.workflow_id,
                    )
                    competing = existing is not None and existing.workflow_id != result.workflow_id
                    step.tool_result = {
                        "workflow_id": result.workflow_id,
                        "workflow_name": workflow.name if workflow is not None else result.workflow_id,
                        "message": (
                            "A different unfinished Build remains active, so the selected "
                            "Workflow has not been restored yet. Compare the two intents and "
                            "call request_build with mode `ask` if the user must choose between them."
                            if competing
                            else (
                                "The requested Workflow is already the active editable Build."
                                if existing is not None
                                else "The saved Workflow was restored as an editable Build baseline."
                            )
                        ),
                    }

            # Complete current Workflow section
            elif step.tool_name == "report_workflow_step":
                result = step.tool_result
                current_status = ota_context.think_status
                if isinstance(result, WorkflowStepReport) and isinstance(current_status, WorkflowStageState):
                    source = self._workflow_source(current_status, context)
                    stage_steps = source.steps(current_status.stage)
                    current_step = stage_steps[current_status.step_index]
                    workspace = context.workspace
                    if workspace is None:
                        raise RuntimeError("Cannot report Workflow progress without an active Run.")
                    state = workspace.run_workflow
                    if state is None:
                        raise RuntimeError("Workflow Run space is not bound.")
                    state.checkpoint_cursor(
                        expected_workflow_id=current_status.workflow_id,
                        expected_generation=current_status.generation,
                        expected_stage=current_status.stage,
                        expected_step_index=current_status.step_index,
                        stage=current_status.stage,
                        step_index=current_status.step_index,
                    )
                    workflow_runs = context.workflow_runs
                    if workflow_runs is None:
                        raise RuntimeError("Cannot record Workflow progress without its result library.")
                    workflow_runs.require_run_workflow(state.root)
                    durable_summary = workflow_runs.record_step(
                        stage=current_status.stage,
                        step_number=current_step.index,
                        step_title=current_step.title,
                        status=result.status,
                        summary=result.summary,
                        evidence=result.evidence,
                    )
                    reported_summary = (
                        durable_summary if result.status == "failure" else result.summary
                    )
                    if result.status == "success":
                        next_step_index = current_status.step_index + 1
                        state.checkpoint_cursor(
                            expected_workflow_id=current_status.workflow_id,
                            expected_generation=current_status.generation,
                            expected_stage=current_status.stage,
                            expected_step_index=current_status.step_index,
                            stage=current_status.stage,
                            step_index=next_step_index,
                        )
                    step.tool_result = {
                        "workflow_id": source.workflow_id,
                        "generation": current_status.generation,
                        "workflow_name": source.name,
                        "phase": current_status.stage,
                        "step_index": current_status.step_index,
                        "step_number": current_step.index,
                        "step_count": len(stage_steps),
                        "title": current_step.title,
                        **self._workflow_sections(source),
                        "status": result.status,
                        "summary": reported_summary,
                        "evidence": result.evidence,
                    }
                    self._publish_workflow_progress(
                        ota_context,
                        context,
                        current_status,
                        result.status,
                        reported_summary,
                        source=source,
                    )
                    if result.status == "failure":
                        terminal_summary = (
                            f"Workflow `{source.name}` stopped during "
                            f"{current_status.stage} section {current_step.index} "
                            f"(`{current_step.title}`): {reported_summary}"
                        )
                        try:
                            published = await self._publish_workflow_run(
                                context,
                                current_status,
                                status=WorkflowRunStatus.FAILED,
                            )
                        except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
                            step.success = False
                            step.error = (
                                "The Workflow failure was recorded, but its terminal "
                                f"result could not be saved: {exc}. Retry the failure report."
                            )
                            step.tool_result = {
                                **step.tool_result,
                                "status": "save_failed",
                            }
                            continue
                        step.tool_result = {
                            **step.tool_result,
                            "run_id": published.run_id,
                            "run_status": published.status.value,
                            "created_at": published.created_at.isoformat(),
                            "published_result_dir": str(published.result_dir.resolve()),
                        }
                        await self._finish_workflow_run(
                            ota_context,
                            context,
                            current_status,
                            generation=current_status.generation,
                            summary=terminal_summary,
                            published=published,
                        )
                    else:
                        next_status = WorkflowStageState(
                            workflow_id=state.workflow_id,
                            generation=state.generation,
                            stage=state.stage,
                            step_index=state.step_index,
                        )
                        ota_context.transition_think(next_status)
                        published = await self._settle_workflow_boundary(ota_context, context)
                        if published is not None:
                            step.tool_result = {
                                **step.tool_result,
                                "run_id": published.run_id,
                                "run_status": published.status.value,
                                "created_at": published.created_at.isoformat(),
                                "published_result_dir": str(published.result_dir.resolve()),
                            }

            # Request_human_choice
            elif step.tool_name == "request_human_choice":
                result = step.tool_result
                if isinstance(result, RequestHumanChoice) and result.questions:
                    ota_context.transition_interaction(AwaitingFeedback(
                        questions=result.questions,
                        prompt=result.prompt,
                        request_id=f"human_{uuid4().hex}",
                    ))
                    step.tool_result = result.questions

            # Enter or resolve a Session-owned Workflow Run
            elif step.tool_name == "request_run_workflow":
                result = step.tool_result
                if isinstance(result, RequestRunWorkflow):
                    step.tool_result = {
                        "workflow_id": result.workflow_id,
                        "action": result.action,
                        "reason": result.reason,
                    }
                    if result.action == "ask":
                        choice = self._workflow_run_request_interaction(
                            context,
                            result.workflow_id,
                            result.reason,
                        )
                        ota_context.transition_interaction(choice)
                        step.tool_result = {
                            **choice.model_dump(mode="json"),
                            "status": "pending",
                        }
                    else:
                        source, resolved_action = await self._enter_or_resume_run_workflow(
                            ota_context,
                            context,
                            result.workflow_id,
                            result.action,
                        )
                        step.tool_result = {
                            "workflow_id": source.workflow_id,
                            "workflow_name": source.name,
                            **self._workflow_sections(source),
                            "status": resolved_action,
                            "reason": result.reason,
                        }

            # Task_confirm
            elif step.tool_name == "request_human_task_confirm":
                result = step.tool_result
                if isinstance(result, RequestHumanTaskConfirm):
                    workspace = context.workspace
                    build = workspace.build if workspace is not None else None
                    think = ota_context.think_status
                    workflow_id = think.workflow_id if isinstance(think, BuildStageState) else None
                    workflows = context.workflows
                    task_markdown = (
                        workflows.require_package(build.root).read_document("task.md")
                        if workflows is not None and build is not None
                        else ""
                    )
                    previous_confirmation = (
                        build.last_task_confirmation if build is not None else None
                    )
                    previous_task_markdown = (
                        previous_confirmation["task_markdown"]
                        if previous_confirmation is not None
                        else None
                    )
                    if previous_task_markdown is None:
                        previous_task_markdown = (
                            build.edit_task_baseline
                            if build is not None and workflow_id is not None
                            else ""
                        )
                    payload = {
                        "request_id": result.request_id,
                        "task_markdown": task_markdown,
                        "previous_task_markdown": previous_task_markdown,
                        "operation": "edit" if workflow_id else "create",
                        "workflow_id": workflow_id,
                        "original_task_markdown": (
                            build.edit_task_baseline
                            if build is not None and workflow_id is not None
                            else None
                        ),
                        "status": "pending",
                    }
                    ota_context.transition_interaction(AwaitingTaskConfirm(task_confirm=payload))
                    step.tool_result = payload

            # Workflow_confirm
            elif step.tool_name == "request_human_workflow_confirm":
                result = step.tool_result
                if isinstance(result, RequestHumanWorkflowConfirm):
                    think = ota_context.think_status
                    workflow_id = think.workflow_id if isinstance(think, BuildStageState) else None
                    workflows = context.workflows
                    workflow = workflows.get(workflow_id) if workflows is not None and workflow_id else None
                    payload = {
                        "request_id": result.request_id,
                        "default_name": workflow.name if workflow is not None else result.default_name,
                        "summary": result.summary,
                        "operation": "edit" if workflow_id else "create",
                        "workflow_id": workflow_id,
                        "status": "pending",
                    }
                    ota_context.transition_interaction(AwaitingWorkflowConfirm(workflow_confirm=payload))
                    step.tool_result = payload

            # Child Agent
            elif step.tool_name == "run_subagent":
                request = step.tool_result
                if isinstance(request, SubagentRequest):
                    tool_call_id = str(getattr(step, "tool_id", None) or "")
                    subagent_calls.append(SubAgentCall.create(
                        tool_call_id,
                        request.goal,
                        execution_mode=effective_execution_mode,
                    ))
                    step.tool_result = (
                        "Sub-agent dispatch accepted. The parent Agent will pause "
                        "until every requested sub-agent finishes."
                    )

            elif step.tool_name == "start_subagent":
                request = step.tool_result
                if isinstance(request, BackgroundSubagentRequest):
                    invocation = context.invocations
                    parent_session_id = context.session.id
                    tool_call_id = str(getattr(step, "tool_id", None) or "")
                    call = SubAgentCall.create(
                        tool_call_id,
                        request.goal,
                        execution_mode=effective_execution_mode,
                    )
                    child_session_id = await invocation.start_subagent(parent_session_id, call)
                    step.tool_result = (
                        f"Background sub-agent session `{child_session_id}` started. "
                        "It will continue independently; do not wait for its result."
                    )

            # Ordinary tools may succeed without stdout/result text, e.g. shell
            # install commands. Make that explicit before persistence/replay so
            # renderers do not confuse empty output with a pending HITL answer.
            if step.tool_result in (None, ""):
                step.tool_result = EMPTY_SUCCESS_TOOL_RESULT

        if subagent_calls:
            ota_context.transition_subagents(AwaitingSubAgent(calls=subagent_calls))

        if False:  # the framework's template validator requires async-gen shape
            yield

    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext) -> None:
        """
        Initialize a new Agent Turn or resume the Session's awaiting tail.

        ``context.session.get_all()`` returns top-level Session Turns in
        conversation order. A terminal tail remains conversation history for a
        new Turn; only an ``AWAITING_*`` tail is restored and replaced in place.
        Each Turn carries its structured ``user_input`` and exposes a normalized
        ``ota_context_dump()`` for Agent resume.

        ``SessionTurnRecord.status`` selects the resume path. ``dump`` is the
        trailing Turn's ``AmphiOTAContext.model_dump`` (JSON, minus the live-only
        stream/tools). Keys that matter for an awaiting Turn are::

            state          dict   the parked dimensions (AgentState.model_dump):
                                     think:       {"mode": "normal", "stage": "main"}
                                                | {"mode": "build", "stage": "clarify"}
                                                | {"mode": "run_workflow", "stage": "execute",
                                                   "workflow_id": "...", "step_index": 0}
                                     interaction: null
                                                | {"questions": [...]}              (awaiting choice)
                                                | {"permission": {...}}             (awaiting permission)
                                                | {"task_confirm": {...}}           (awaiting task confirmation)
                                                | {"workflow_confirm": {...}}       (awaiting workflow confirm)
                                                | {"build_confirm": true, ...}       (awaiting Build proposal)
                                     subagents:  null
                                                | {"calls": [{"tool_call_id", "goal",
                                                               "session_id"}, ...]}
            ota_record     list   the rounds (each: think_result / action_result /
                                   observation_result + any extra per-round fields)
            input_tokens   int
            output_tokens  int

        An existing special-mode state always re-enters the same cognitive loop.
        A structured Build or Workflow slash block is rendered as explicit Main
        intent; only the dedicated request control for Build, presentation, or
        Workflow Run may enter its corresponding cognitive mode.
        """
        ########################
        # Initialize the agent turn context
        ########################
        # Display language: the connection's stated language is only the fallback. What the
        # model writes already follows the user's input language (see _prompt.py's CRITICAL
        # language rule), so the backend's own display text has to key off the same signal —
        # otherwise one approval card carries an English classifier reason beside a Chinese
        # security label. Resume frames and signal-less inputs keep the connection's value.
        detected = detect_locale(*self._recent_user_messages(ota_context, context))
        if detected is not None:
            activate_locale(detected)

        # Parse the user input
        completing_subagents = isinstance(ota_context.user_input, SubAgentsCompleted)
        build_slash = self._has_slash_command(ota_context.user_input, "build")
        input_type = (ota_context.user_input.get("type") if isinstance(ota_context.user_input, dict) else getattr(ota_context.user_input, "type", None))
        is_child = context.session.is_child
        if is_child and build_slash:
            ota_context.ota_record.append(OTARecord(
                observation_result=(
                    "[child capability] Build slash commands are available only in root "
                    "Sessions; continue this task in normal mode."
                ),
            ))

        # Get the latest Session Turn
        turns = context.session.get_all()
        latest_turn = turns[-1] if turns else None
        if latest_turn is not None:
            previous_usage = ContextUsageSnapshot.model_validate(latest_turn.context_usage)
            if latest_turn.status.is_terminal:
                previous_usage = previous_usage.model_copy(update={
                    "input_tokens": 0,
                    "output_tokens": 0,
                })
            ota_context.context_usage = previous_usage
            raw_compaction = (latest_turn.agent_state or {}).get("context_compaction")
            if raw_compaction:
                compaction = ContextCompactionState.model_validate(raw_compaction)
                if latest_turn.status.is_terminal:
                    compaction = compaction.model_copy(update={
                        "turn": {},
                    })
                ota_context.state.context_compaction = compaction

        ########################
        # Initialize a new Agent Turn
        ########################
        if latest_turn is None or latest_turn.status.is_terminal:
            if completing_subagents:
                raise RuntimeError("This Session has no pending Child Agent state to resume.")
            if input_type == "task_confirm":
                raise RuntimeError("This Session has no pending task confirmation.")
            if input_type == "workflow_confirm":
                raise RuntimeError("This Session has no pending workflow confirmation.")
            if input_type == "build_confirm":
                raise RuntimeError("This Session has no pending Build confirmation.")
            if input_type == "presentation_outline_confirm":
                raise RuntimeError("This Session has no pending presentation outline confirmation.")

            # Resume durable cognitive cursors after completion, cancellation, or infrastructure failure.
            if latest_turn is not None:
                think = (latest_turn.agent_state or {}).get("think") or {}
                resumable = latest_turn.status in {
                    TurnStatus.COMPLETED,
                    TurnStatus.CANCELLED,
                    TurnStatus.FAILED,
                }
                if (
                    resumable
                    and think.get("mode") in self.thinking_modes
                    and not is_child
                ):
                    self._resume_think_stage(ota_context, think)

            if isinstance(ota_context.think_status, (BuildStageState, PresentationStageState, WorkflowStageState)):
                if isinstance(ota_context.think_status, BuildStageState):
                    await self._sync_build_space(ota_context, context)
                elif isinstance(ota_context.think_status, WorkflowStageState):
                    projected = await self._hydrate_run_workflow(
                        ota_context.think_status,
                        context,
                    )
                    if projected is None:
                        ota_context.transition_think(NormalStageState())
                    else:
                        ota_context.transition_think(projected)
                        await self._settle_workflow_boundary(ota_context, context)
                return

            return

        ########################
        # Resume the awaiting Agent Turn
        ########################
        original_user_input = self._renderable_user_input(latest_turn.user_input)
        dump = latest_turn.ota_context_dump()
        state = dump.get("state") or {}
        rounds = dump.get("ota_record") or []
        interaction = state.get("interaction") or {}
        subagent_state = state.get("subagents") or {}
        think = state.get("think") or {}
        workflow_action = (
            ota_context.user_input.get("action")
            if isinstance(ota_context.user_input, dict)
            else getattr(ota_context.user_input, "action", None)
        )
        workflow_action = str(workflow_action or "").strip().lower()
        confirming_workflow = (
            isinstance(interaction, dict)
            and "workflow_confirm" in interaction
            and input_type == "workflow_confirm"
            and workflow_action in {"confirm", "save_as_new"}
        )

        # Resume the tool loaded status
        ota_context.browser_tool_loaded = bool(dump.get("browser_tool_loaded"))
        ota_context.workspace_tools_loaded = bool(dump.get("workspace_tools_loaded"))
        ota_context.skills_tool_loaded = bool(dump.get("skills_tool_loaded"))

        # Resume the think status
        if (
            think.get("mode") in self.thinking_modes
            and not is_child
        ):
            self._resume_think_stage(ota_context, think)
            if isinstance(ota_context.think_status, BuildStageState) and not confirming_workflow:
                await self._sync_build_space(ota_context, context)
            elif isinstance(ota_context.think_status, WorkflowStageState):
                projected = await self._hydrate_run_workflow(
                    ota_context.think_status,
                    context,
                )
                if projected is None:
                    ota_context.transition_think(NormalStageState())
                else:
                    ota_context.transition_think(projected)
                    await self._settle_workflow_boundary(ota_context, context)

        # Resume the parked state selected by the durable Turn status
        if latest_turn.status is TurnStatus.AWAITING_SUBAGENTS:
            if not completing_subagents:
                raise RuntimeError("This Session is waiting for its Child Agents to finish.")
            if not isinstance(subagent_state, dict) or not subagent_state:
                raise RuntimeError("The pending Child Agent Turn has no Child Agent state.")
            if not rounds:
                raise RuntimeError("The pending Child Agent Turn has no resumable trace.")
            self._resume_subagents(
                ota_context,
                context,
                subagent_state,
                rounds,
                original_user_input,
            )
        elif latest_turn.status is TurnStatus.AWAITING_PERMISSION:
            if not isinstance(interaction, dict) or "permission" not in interaction:
                raise RuntimeError("The pending permission Turn has no permission state.")
            if input_type != "permission_answer":
                raise RuntimeError("This Session is waiting for a permission answer.")
            if not rounds:
                raise RuntimeError("The pending permission Turn has no resumable trace.")
            await self._resume_permission(
                ota_context,
                context,
                interaction.get("permission") or {},
                rounds,
                original_user_input,
            )
        elif latest_turn.status is TurnStatus.AWAITING_HUMAN:
            if interaction.get("build_confirm") is True:
                await self._resume_build_confirm(ota_context, context, latest_turn, original_user_input)
            elif interaction.get("build_conflict") is True:
                conflict = AwaitingBuildConflict.model_validate(interaction)
                await self._resume_build_conflict(ota_context, context, conflict, rounds, original_user_input)
            elif interaction.get("workflow_run_choice") is True:
                choice = AwaitingWorkflowRunChoice.model_validate(interaction)
                await self._resume_workflow_run_choice(
                    ota_context,
                    context,
                    choice,
                    rounds,
                    original_user_input,
                )
            elif "task_confirm" in interaction:
                await self._resume_task_confirm(ota_context, context, latest_turn, original_user_input)
            elif "workflow_confirm" in interaction:
                await self._resume_workflow_confirm(ota_context, context, latest_turn, original_user_input)
            elif interaction.get("presentation_outline_confirm") is True:
                await self._resume_presentation_outline_confirm(
                    ota_context,
                    context,
                    latest_turn,
                    original_user_input,
                )
            else:
                self._resume_human_choice(ota_context, context, interaction, rounds, original_user_input)

        return

    @staticmethod
    def _resume_think_stage(ota_context: AmphiOTAContext, think: Dict[str, Any]) -> None:
        if think.get("mode") == "build":
            ota_context.transition_think(BuildStageState.model_validate(think))
        elif think.get("mode") == "presentation":
            ota_context.transition_think(PresentationStageState.model_validate(think))
        elif think.get("mode") == "run_workflow":
            ota_context.transition_think(WorkflowStageState.model_validate(think))

    async def _enter_or_resume_build(self, ota_context: AmphiOTAContext, context: AmphiContext, workflow_id: Optional[str] = None) -> Optional[BuildStageState]:
        """Enter a new Build or reopen the unfinished Build for semantic routing.

        Returns
        -------
        BuildStageState, optional
            The reopened unfinished Build state. ``None`` means a new Build was
            created for the requested operation.
        """
        workspace = context.workspace
        if workspace is None:
            ota_context.transition_think(BuildStageState(stage="clarify", workflow_id=workflow_id))
            return None
        if not workspace.has_build:
            ota_context.transition_think(BuildStageState(stage="clarify", workflow_id=workflow_id))
            await self._sync_build_space(ota_context, context, create=True)
            return None

        build = await workspace.prepare_build_space("resume")
        existing = BuildStageState(stage=build.stage, workflow_id=build.workflow_id)
        ota_context.transition_think(existing)
        await self._sync_build_space(ota_context, context)
        return existing

    @staticmethod
    def _card_option(prefix: str, option_id: str) -> dict:
        """One choice-card option. Id, label and description all derive from the catalog
        by naming convention (``{prefix}.option_{id}`` / ``{prefix}.desc_{id}``), so the
        id ↔ copy coupling is structural — pairing an id with another option's label
        can no longer happen by hand-copied dict drift."""
        return {
            "id": option_id,
            "label": backend_i18n.text(f"{prefix}.option_{option_id}"),
            "description": backend_i18n.text(f"{prefix}.desc_{option_id}"),
        }

    def _build_request_interaction(self, context: AmphiContext,  request: RequestBuild, *, requested_workflow_id: Optional[str] = None) -> AwaitingBuildConflict:
        """Create the unfinished-Build interaction requested through ``request_build``."""
        workspace = context.workspace
        checkpoint = workspace.build_checkpoint() if workspace is not None else None
        if checkpoint is None:
            raise RuntimeError("Cannot ask about an unfinished Build when none is retained.")
        reason = (request.reason or "").strip()
        if not reason:
            raise ValueError("request_build mode `ask` requires a conflict reason for an unfinished Build.")
        existing_stage = checkpoint.stage
        existing_workflow_id = checkpoint.workflow_id
        if requested_workflow_id:
            question = backend_i18n.text("agent.build_conflict.question_replace", reason=reason)
            options = [
                self._card_option("agent.build_conflict", "keep"),
                self._card_option("agent.build_conflict", "replace_edit"),
            ]
        else:
            question = backend_i18n.text("agent.build_conflict.question_new", reason=reason)
            options = [
                self._card_option("agent.build_conflict", "keep"),
                self._card_option("agent.build_conflict", "merge"),
                self._card_option("agent.build_conflict", "replace_new"),
            ]
        conflict = AwaitingBuildConflict(
            existing_stage=existing_stage,
            existing_workflow_id=existing_workflow_id,
            requested_workflow_id=requested_workflow_id,
            reason=reason,
            request_id=request.request_id or f"build_conflict_{uuid4().hex}",
            questions=[{
                "question": question,
                "header": backend_i18n.text("agent.build_conflict.header"),
                "options": options,
                "multiSelect": False,
            }],
        )
        self._close_build_bindings(context)
        return conflict

    def _workflow_run_request_interaction(self, context: AmphiContext, requested_workflow_id: str, reason: Optional[str]) -> AwaitingWorkflowRunChoice:
        """Create the unfinished-Run interaction requested through ``request_run_workflow``."""
        if context.session.is_child:
            raise RuntimeError("Child Sessions cannot control Workflow Runs.")
        workflows = context.workflows
        workspace = context.workspace
        if workflows is None or workspace is None or not context.session.id:
            raise RuntimeError("Cannot request a Workflow Run choice without a Session.")
        existing_state = workspace.run_workflow_checkpoint()
        if existing_state is None:
            raise RuntimeError("Cannot request a Workflow Run choice without an unfinished Run.")
        requested = workflows.get(requested_workflow_id)
        if requested is None:
            raise RuntimeError(
                f"Workflow `{requested_workflow_id}` is unavailable for restart."
            )
        same_workflow = existing_state.workflow_id == requested_workflow_id
        target_text = (
            backend_i18n.text(
                "agent.workflow_run_choice.target_same",
                name=existing_state.workflow_name,
            )
            if same_workflow
            else backend_i18n.text(
                "agent.workflow_run_choice.target_other",
                name=requested.name,
            )
        )
        question = backend_i18n.text(
            "agent.workflow_run_choice.question",
            reason=reason or backend_i18n.text("agent.workflow_run_choice.default_reason"),
            target=target_text,
        )
        return AwaitingWorkflowRunChoice(
            existing_workflow_id=existing_state.workflow_id,
            requested_workflow_id=requested_workflow_id,
            reason=reason,
            request_id=f"workflow_run_choice_{uuid4().hex}",
            questions=[{
                "question": question,
                "header": backend_i18n.text("agent.workflow_run_choice.header"),
                "options": [
                    self._card_option("agent.workflow_run_choice", "resume"),
                    self._card_option("agent.workflow_run_choice", "restart"),
                ],
                "multiSelect": False,
            }],
        )

    @staticmethod
    def _requested_edit_workflow_id(ota_context: AmphiOTAContext) -> Optional[str]:
        """Return the most recent successful edit target from this Agent turn."""
        def value(item: Any, name: str) -> Any:
            return item.get(name) if isinstance(item, dict) else getattr(item, name, None)

        for record in reversed(ota_context.ota_record):
            steps = value(value(record, "action_result"), "results") or []
            for step in reversed(steps):
                if value(step, "tool_name") != "edit_workflow" or not value(step, "success"):
                    continue
                result = value(step, "tool_result")
                workflow_id = result.get("workflow_id") if isinstance(result, dict) else None
                return str(workflow_id or "").strip() or None
        return None

    @staticmethod
    def _input_value(user_input: Any, name: str) -> Any:
        """Read one field from a dict or typed runtime input."""
        if isinstance(user_input, dict):
            return user_input.get(name)
        return getattr(user_input, name, None)

    @staticmethod
    def _option_label(questions: List[dict], option_id: str) -> str:
        """Return the persisted card's display label for ``option_id`` (or the id)."""
        for question in questions:
            if not isinstance(question, dict):
                continue
            for option in question.get("options") or []:
                if isinstance(option, dict) and str(option.get("id") or "") == option_id:
                    return str(option.get("label") or "") or option_id
        return option_id

    @classmethod
    def _choice_selection(
        cls,
        user_input: Any,
        *,
        request_id: str,
        questions: List[dict],
        allowed: set[str],
    ) -> Optional[str]:
        """Return a structured ``choice_answer``'s stable option id, or ``None``.

        Ids are the only channel that resolves to an action: a chat reply — even
        one that quotes an option label or echoes the card question — always
        returns ``None`` so the caller folds it back to the model instead of
        guessing. Free-typed "other" text on the card (an answer without an
        ``option_id``) is free-form too. A stale ``request_id`` or an option the
        card never offered is a client bug and raises.
        """
        if cls._input_value(user_input, "type") != "choice_answer":
            return None
        if cls._input_value(user_input, "request_id") != request_id:
            raise RuntimeError("This choice answer does not match the pending request.")
        option_id = ""
        for answer in cls._input_value(user_input, "answers") or []:
            option_id = str(cls._input_value(answer, "option_id") or "")
            if option_id:
                break
        if not option_id:
            return None
        offered = {
            str(option.get("id") or "")
            for question in questions
            if isinstance(question, dict)
            for option in question.get("options") or []
            if isinstance(option, dict)
        }
        if option_id not in offered or option_id not in allowed:
            raise RuntimeError(f"Option {option_id!r} is not offered by the pending card.")
        return option_id

    @classmethod
    def _choice_reply_text(cls, user_input: Any, questions: List[dict]) -> str:
        """Render a free-form card reply for fold-back to the model.

        A chat reply renders as-is; a structured answer without option ids
        renders its typed text, prefixed with the question for multi-question
        asks so the question → answer mapping stays readable for the model.
        """
        if cls._input_value(user_input, "type") != "choice_answer":
            return render_input(user_input).strip()
        lines: List[str] = []
        for answer in cls._input_value(user_input, "answers") or []:
            option_id = str(cls._input_value(answer, "option_id") or "")
            if option_id:
                text = cls._option_label(questions, option_id)
            else:
                text = str(cls._input_value(answer, "text") or "").strip()
            if not text:
                continue
            index = cls._input_value(answer, "index")
            question = questions[index] if isinstance(index, int) and 0 <= index < len(questions) else None
            prompt = str(question.get("question") or "").strip() if isinstance(question, dict) else ""
            lines.append(f"{prompt}: {text}" if prompt else text)
        return "\n".join(lines)

    async def _resume_build_confirm(self, ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
        """Resume Main after the user accepts or declines a Build proposal."""
        def field(name: str) -> Any:
            if isinstance(ota_context.user_input, dict):
                return ota_context.user_input.get(name)
            return getattr(ota_context.user_input, name, None)

        pending = AwaitingBuildConfirm.model_validate(pending_turn.agent_state.get("interaction") or {})
        ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]
        request = ota_context.ota_record[-1].action_result["results"][0]
        input_type = field("type")
        if input_type not in {None, "chat", "build_confirm"}:
            raise RuntimeError("This Session is waiting for a Build confirmation.")
        if input_type != "build_confirm":
            user_message = render_input(ota_context.user_input).strip()
            payload = request.get("tool_result")
            payload = dict(payload) if isinstance(payload, dict) else pending.model_dump()
            payload.update({
                "status": "not_answered",
                "user_message": user_message,
                "message": (
                    "The user replied to the entire Build confirmation card instead "
                    f"of choosing an action: {user_message}"
                ),
            })
            request["tool_result"] = payload
            ota_context.transition_interaction(None)
            context.session = context.session.without_last()
            ota_context.user_input = original_user_input
            return
        if field("request_id") != pending.request_id:
            raise RuntimeError("This Build confirmation does not match the pending request.")

        confirmed = field("action") == "confirm"
        message = (
            "The user chose to keep this as a one-off task. Continue the original request in Main."
        )
        if confirmed:
            ota_context.transition_think(BuildStageState(stage="clarify"))
            await self._sync_build_space(ota_context, context, create=True)
            message = (
                "The user confirmed that this task should become a reusable Workflow. "
                "A new Build was created; clarify the Workflow definition."
            )
        request["tool_result"].update({
            "status": "confirmed" if confirmed else "cancelled",
            "message": message,
        })

        ota_context.transition_interaction(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    async def _resume_build_conflict(self, ota_context: AmphiOTAContext, context: AmphiContext, conflict: AwaitingBuildConflict, rounds: List[Any], original_user_input: Any) -> None:
        """Apply a Build-domain choice or fold a free-form reply into Build Think."""
        workspace = context.workspace
        if workspace is None:
            raise RuntimeError("Cannot resolve a Build conflict without a Workspace.")
        ota_context.ota_record = [OTARecord.model_validate(record) for record in rounds]

        selected_action = self._choice_selection(
            ota_context.user_input,
            request_id=conflict.request_id,
            questions=conflict.questions,
            allowed={"keep", "merge", "replace_edit", "replace_new"},
        )
        user_message = (
            self._option_label(conflict.questions, selected_action)
            if selected_action is not None
            else self._choice_reply_text(ota_context.user_input, conflict.questions)
        )
        if selected_action == "keep":
            ota_context.transition_think(BuildStageState(
                stage=conflict.existing_stage,
                workflow_id=conflict.existing_workflow_id,
            ))
            await self._sync_build_space(ota_context, context)
            action = "keep"
            message = (
                "The user chose to continue the existing unfinished Build. Ignore the "
                "competing Build request that triggered this choice."
            )
        elif selected_action == "merge":
            ota_context.transition_think(BuildStageState(
                stage="clarify",
                workflow_id=conflict.existing_workflow_id,
            ))
            await self._sync_build_space(ota_context, context)
            action = "merge"
            message = (
                "The user chose to merge the latest requirements into the unfinished "
                "Build. Clarify the combined task while preserving the existing Build files as context."
            )
        elif selected_action == "replace_edit":
            await workspace.discard_build()
            ota_context.transition_think(BuildStageState(
                stage="clarify",
                workflow_id=conflict.requested_workflow_id,
            ))
            await self._sync_build_space(ota_context, context, create=True)
            action = "replace"
            message = (
                "The user chose to discard the unfinished Build and restore the selected "
                "Workflow as the new editable Build."
            )
        elif selected_action == "replace_new":
            ota_context.transition_think(BuildStageState(stage="clarify"))
            await self._sync_build_space(ota_context, context, create=True)
            action = "replace"
            message = (
                "The user chose to discard the unfinished Build and start a clean Build "
                "from the latest request."
            )
        else:
            ota_context.transition_think(BuildStageState(
                stage=conflict.existing_stage,
                workflow_id=conflict.existing_workflow_id,
            ))
            await self._sync_build_space(ota_context, context)
            action = "not_answered"
            message = (
                "The user replied to the entire unfinished-Build choice instead of "
                f"selecting an action: {user_message}"
            )

        request = None
        for record in reversed(ota_context.ota_record):
            steps = (record.action_result or {}).get("results") or []
            request = next(
                (
                    step
                    for step in reversed(steps)
                    if step.get("tool_name") == "request_build"
                ),
                None,
            )
            if request is not None:
                break
        if request is not None:
            payload = request.get("tool_result")
            payload = dict(payload) if isinstance(payload, dict) else conflict.model_dump(mode="json")
            payload.update({
                "status": "resolved" if action != "not_answered" else "not_answered",
                "action": action,
                "message": message,
                "response": user_message,
                **({"user_message": user_message} if action == "not_answered" else {}),
            })
            request["tool_result"] = payload
        else:
            ota_context.ota_record.append(OTARecord(observation_result=f"[build] {message}"))

        ota_context.transition_interaction(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    async def _resume_workflow_run_choice(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        choice: AwaitingWorkflowRunChoice,
        rounds: List[Any],
        original_user_input: Any,
    ) -> None:
        """Apply the user's Run choice or fold a free-form reply back into Main."""
        answer_input = ota_context.user_input
        ota_context.ota_record = [OTARecord.model_validate(record) for record in rounds]
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

        selected_action = self._choice_selection(
            answer_input,
            request_id=choice.request_id,
            questions=choice.questions,
            allowed={"resume", "restart"},
        )
        user_message = (
            self._option_label(choice.questions, selected_action)
            if selected_action is not None
            else self._choice_reply_text(answer_input, choice.questions)
        )
        action = "not_answered"
        message = (
            "The user replied to the unfinished-Run choice without selecting an "
            f"action: {user_message}"
        )
        result_fields: Dict[str, Any] = {}
        selected_workflow_id = (
            choice.existing_workflow_id
            if selected_action == "resume"
            else choice.requested_workflow_id
        )

        if selected_action is not None:
            try:
                source, resolved_action = await self._enter_or_resume_run_workflow(
                    ota_context,
                    context,
                    selected_workflow_id,
                    selected_action,
                )
                action = selected_action
                message = (
                    "The user chose to resume the existing pinned Workflow Run."
                    if selected_action == "resume"
                    else (
                        "The user chose to discard the unfinished Run and start a "
                        "fresh Run from the currently saved Workflow."
                    )
                )
                result_fields = {
                    "workflow_id": source.workflow_id,
                    "workflow_name": source.name,
                    **self._workflow_sections(source),
                    "resolved_action": resolved_action,
                }
            except (RuntimeError, ValueError) as exc:
                action = "failed"
                message = (
                    f"The selected Workflow Run action could not be applied: {exc}. "
                    "The original unfinished Run was preserved."
                )
                ota_context.transition_think(NormalStageState())
                self._close_run_workflow_bindings(context)

        request = None
        for record in reversed(ota_context.ota_record):
            steps = (record.action_result or {}).get("results") or []
            request = next(
                (
                    step
                    for step in reversed(steps)
                    if step.get("tool_name") == "request_run_workflow"
                ),
                None,
            )
            if request is not None:
                break
        if request is not None:
            payload = request.get("tool_result")
            payload = dict(payload) if isinstance(payload, dict) else choice.model_dump(mode="json")
            payload.update({
                "status": "resolved" if action in {"resume", "restart"} else action,
                "action": action,
                "message": message,
                "response": user_message,
                **result_fields,
                **({"user_message": user_message} if action == "not_answered" else {}),
            })
            request["tool_result"] = payload
        else:
            ota_context.ota_record.append(OTARecord(
                observation_result=f"[workflow re-entry] {message}",
            ))

        ota_context.transition_interaction(None)

    @staticmethod
    def _has_slash_command(user_input: Any, command: str) -> bool:
        """Return whether the first meaningful input block is this Slash Command."""
        blocks = user_input.get("blocks") if isinstance(user_input, dict) else getattr(user_input, "blocks", None)
        for block in blocks or []:
            kind = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
            if kind == "text":
                value = block.get("value") if isinstance(block, dict) else getattr(block, "value", "")
                if not str(value or "").strip():
                    continue
                return False
            block_id = block.get("id") if isinstance(block, dict) else getattr(block, "id", None)
            return kind == "slash" and block_id == command
        return False

    @staticmethod
    def _renderable_user_input(user_input: Any) -> Any:
        """Adapt stored ``UserInput`` rows back to the WS input shape."""
        if isinstance(user_input, str):
            return user_input
        blocks = []
        for block in getattr(user_input, "blocks", None) or []:
            data = block if isinstance(block, dict) else block.model_dump()
            if data.get("type") == "text":
                blocks.append(WsTextBlock.model_validate(data))
            elif data.get("type") == "mention":
                blocks.append(WsMentionBlock.model_validate(data))
            elif data.get("type") == "slash":
                blocks.append(WsSlashBlock.model_validate(data))
        return WsChatMessage(
            session_id="",
            input=(getattr(user_input, "input", None) or getattr(user_input, "text", "") or ""),
            blocks=blocks,
        )

    async def _resume_task_confirm(self, ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
        """Resume Clarify after the user reviews the persisted task definition.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Current attempt carrying the dedicated confirmation response.
        context : AmphiContext
            Hydrated Session and Build workspace.
        pending_turn : SessionTurnRecord
            Awaiting Clarify Turn containing the original confirmation tool call.
        original_user_input : Any
            User input restored when the parked Turn resumes.
        """
        def field(name: str) -> Any:
            if isinstance(ota_context.user_input, dict):
                return ota_context.user_input.get(name)
            return getattr(ota_context.user_input, name, None)

        pending = (pending_turn.agent_state.get("interaction") or {})["task_confirm"]
        input_type = field("type")
        if input_type not in {None, "chat", "task_confirm"}:
            raise RuntimeError("This Session is waiting for a task confirmation.")
        direct_reply = input_type != "task_confirm"
        if not direct_reply and field("request_id") != pending["request_id"]:
            raise RuntimeError("This task confirmation does not match the pending request.")
        workspace = context.workspace
        build = workspace.build if workspace is not None else None
        if build is not None:
            build.record_task_confirmation(
                str(pending["request_id"]),
                str(pending.get("task_markdown") or ""),
            )

        confirmed = not direct_reply and field("action") == "confirm"
        feedback = (
            render_input(ota_context.user_input).strip()
            if direct_reply
            else str(field("feedback") or "").strip()
        )
        if direct_reply:
            message = (
                "The user replied to the entire task confirmation card instead "
                f"of choosing an action: {feedback}\n\n"
                "Incorporate the feedback directly into task.md and request task "
                "confirmation again."
            )
        elif confirmed:
            message = (
                "The user confirmed task.md as the workflow's task definition. "
                "Continue to Explore."
            )
        elif feedback:
            message = (
                f"The user requested these task.md revisions:\n\n{feedback}\n\n"
                "Incorporate the feedback directly and request task confirmation again."
            )
        else:
            message = (
                "The user requested revisions to task.md without specific feedback. "
                "Ask what should change in the task definition before rewriting task.md."
            )

        ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]
        for record in reversed(ota_context.ota_record):
            steps = (record.action_result or {}).get("results") or []
            confirm = next((step for step in steps if step.get("tool_name") == "request_human_task_confirm"), None)
            if confirm is not None:
                payload = confirm.get("tool_result")
                payload = dict(payload) if isinstance(payload, dict) else dict(pending)
                payload.update({
                    "status": (
                        "not_answered"
                        if direct_reply
                        else ("confirmed" if confirmed else "revision_requested")
                    ),
                    "feedback": feedback or None,
                    **({"user_message": feedback} if direct_reply else {}),
                    "message": message,
                })
                confirm["tool_result"] = payload
                break

        if confirmed:
            current = ota_context.think_status
            next_status = (
                current.model_copy(update={"stage": "explore"})
                if isinstance(current, BuildStageState)
                else BuildStageState(stage="explore")
            )
            ota_context.transition_think(next_status)
            await self._sync_build_space(ota_context, context)
        ota_context.transition_interaction(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    async def _resume_presentation_outline_confirm(self, ota_context: AmphiOTAContext, context: AmphiContext, pending_turn: SessionTurnRecord, original_user_input: Any) -> None:
        """Resume Plan with the user's edited and confirmed slide outline."""
        def field(name: str) -> Any:
            if isinstance(ota_context.user_input, dict):
                return ota_context.user_input.get(name)
            return getattr(ota_context.user_input, name, None)

        pending = AwaitingPresentationOutlineConfirm.model_validate(
            pending_turn.agent_state.get("interaction") or {},
        )
        input_type = field("type")
        if input_type not in {None, "chat", "presentation_outline_confirm"}:
            raise RuntimeError("This Session is waiting for a presentation outline confirmation.")
        direct_reply = input_type != "presentation_outline_confirm"
        if not direct_reply and field("request_id") != pending.request_id:
            raise RuntimeError("This presentation outline confirmation does not match the pending request.")

        state = ota_context.think_status
        if not isinstance(state, PresentationStageState) or state.stage != "ppt_plan":
            raise RuntimeError("Presentation outline confirmation requires the active Plan stage.")
        feedback = render_input(ota_context.user_input).strip() if direct_reply else ""
        if direct_reply:
            reports = [
                report for report in state.reports
                if not (report.stage == "ppt_plan" and report.step_id == "map_slides")
            ]
            state = state.model_copy(update={
                "step_index": 2,
                "reports": reports,
                "outline_confirmed": False,
                "outline_confirmation_id": None,
            })
            message = (
                "The user replied while reviewing the editable presentation outline. "
                f"Revise the chapter and slide map around this feedback:\n\n{feedback}"
            )
        else:
            chapters = field("chapters")
            state = state.apply_plan_step_data("map_slides", {"chapters": chapters}).model_copy(update={
                "outline_confirmed": True,
                "outline_confirmation_id": None,
            })
            message = (
                "The user confirmed the editable chapter and slide outline. Continue with "
                "the visual direction step using this confirmed runtime outline as the source of truth."
            )

        ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]
        record = ota_context.ota_record[-1] if ota_context.ota_record else None
        if record is None:
            ota_context.ota_record.append(OTARecord(observation_result=message))
        else:
            existing = getattr(record, "observation_result", None)
            record.observation_result = f"{existing}\n{message}" if existing else message
        ota_context.transition_think(state)
        ota_context.transition_interaction(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    async def _resume_workflow_confirm(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        pending_turn: SessionTurnRecord,
        original_user_input: Any,
    ) -> None:
        """Resume a parked workflow confirmation and save an approved Build.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Current attempt carrying the dedicated confirmation message.
        context : AmphiContext, optional
            Hydrated Session and Workspace context.
        pending_turn : SessionTurnRecord
            Awaiting Turn whose request and source id identify the Workflow.
        original_user_input : Any
            User input restored when the parked Turn resumes.
        """
        def field(name: str) -> Any:
            if isinstance(ota_context.user_input, dict):
                return ota_context.user_input.get(name)
            return getattr(ota_context.user_input, name, None)

        pending = (pending_turn.agent_state.get("interaction") or {})["workflow_confirm"]
        input_type = field("type")
        if input_type not in {None, "chat", "workflow_confirm"}:
            raise RuntimeError("This Session is waiting for a workflow confirmation.")
        direct_reply = input_type != "workflow_confirm"
        if not direct_reply and field("request_id") != pending["request_id"]:
            raise RuntimeError("This workflow confirmation does not match the pending request.")

        user_message = render_input(ota_context.user_input).strip() if direct_reply else ""
        action = str(field("action") or "").strip().lower()
        save_as_new = not direct_reply and action == "save_as_new"
        confirmed = not direct_reply and action in {"confirm", "save_as_new"}
        source_workflow_id = pending.get("workflow_id")
        target_workflow_id = None if save_as_new else source_workflow_id
        publication_operation = (
            "create" if save_as_new else str(pending.get("operation") or "create")
        )
        workflow = None
        save_error: Optional[str] = None
        if confirmed:
            workflows = context.workflows
            workspace = context.workspace
            try:
                if workflows is None or workspace is None:
                    raise RuntimeError("Workflow persistence is unavailable")
                if target_workflow_id is None:
                    workflow = await workflows.find_materialized_workflow(pending_turn.id)
                if workflow is None:
                    build = await workspace.prepare_build_space("resume")
                    if build.workflow_id != source_workflow_id:
                        raise RuntimeError(
                            "The active Build does not match the Workflow confirmation."
                        )
                    workflow = await workflows.materialize_workflow(
                        build.root,
                        workflow_id=target_workflow_id,
                        source_session_id=context.session.id,
                        source_turn_id=pending_turn.id,
                        name=str(field("name") or pending.get("default_name") or ""),
                        description=pending.get("summary"),
                    )
            except Exception as exc:  # noqa: BLE001 - save failure returns to Verify
                logger.warning(
                    "Workflow confirmation save failed for session %s: %s",
                    context.session.id,
                    exc,
                )
                save_error = str(exc).strip() or type(exc).__name__

        if direct_reply:
            result: Any = {
                **pending,
                "status": "not_answered",
                "user_message": user_message,
                "message": (
                    "The user replied to the entire workflow confirmation card instead "
                    f"of choosing an action: {user_message}"
                ),
            }
        elif workflow is not None:
            operation = "updated" if target_workflow_id is not None else "saved"
            result = {
                **pending,
                "operation": publication_operation,
                "status": "confirmed",
                "name": workflow.name,
                "workflow_id": workflow.workflow_id,
                "published_root": str(workflow.root.expanduser().resolve()),
                "message": (
                    f"The user confirmed the workflow, and it was {operation} successfully "
                    f"as `{workflow.name}` (workflow id: `{workflow.workflow_id}`)."
                ),
            }
        elif confirmed:
            result = {
                **pending,
                "operation": publication_operation,
                "status": "save_failed",
                "name": str(field("name") or pending.get("default_name") or ""),
                "error": save_error,
                "message": (
                    "The user approved the Workflow, but saving failed"
                    f"{': ' + save_error if save_error else ''}. "
                    "The Build remains open so Verify can correct or retry it."
                ),
            }
        else:
            result = {
                **pending,
                "status": "cancelled",
                "message": (
                    "The user cancelled the workflow confirmation. "
                    "The Build remains open for further changes."
                ),
            }

        ota_context.ota_record = [OTARecord.model_validate(record) for record in pending_turn.ota_records]
        for rec in reversed(ota_context.ota_record):
            steps = (rec.action_result or {}).get("results") or []
            confirm = next((s for s in steps if s.get("tool_name") == "request_human_workflow_confirm"), None)
            if confirm is not None:
                confirm["tool_result"] = result
                break

        if workflow is not None:
            current = ota_context.think_status
            workspace = context.workspace
            if workspace is not None:
                await workspace.discard_build()
            if isinstance(current, BuildStageState):
                self._stamp_mode_exit(
                    ota_context,
                    current,
                    str(result["message"]),
                    retained=False,
                )
            self._stamp_published_directory_handoff(
                ota_context,
                publication="The Workflow package under .build was published to",
                published_directory=workflow.root,
                relative_paths=(
                    "Package-relative paths are unchanged for task.md, explore.md, verify.md, "
                    "and workflow/. Other files from .build were not published and must not be "
                    "linked."
                ),
                temporary_workspace=".build",
            )
            ota_context.transition_think(NormalStageState())
            self._close_build_bindings(context)
        elif confirmed:
            await self._sync_build_space(ota_context, context)
        ota_context.transition_interaction(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    @classmethod
    def _resume_human_choice(cls, ota_context: AmphiOTAContext, context: AmphiContext, interaction: Dict[str, Any], rounds: List[Any], original_user_input: Any) -> None:
        ota_context.ota_record = [OTARecord.model_validate(r) for r in rounds]
        questions = [q for q in interaction.get("questions") or [] if isinstance(q, dict)]
        if cls._input_value(ota_context.user_input, "type") == "choice_answer":
            expected_id = str(interaction.get("request_id") or "")
            if cls._input_value(ota_context.user_input, "request_id") != expected_id:
                raise RuntimeError("This choice answer does not match the pending request.")
            reply = cls._choice_reply_text(ota_context.user_input, questions)
        else:
            reply = render_input(ota_context.user_input)
        for rec in reversed(ota_context.ota_record):
            steps = (rec.action_result or {}).get("results") or []
            ask = next((s for s in steps if s.get("tool_name") == "request_human_choice"), None)
            if ask is not None:
                ask["tool_result"] = reply
                ota_context.transition_interaction(None)  # the held request human choice is resolved; clear it
                break
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    @staticmethod
    def _resume_subagents(ota_context: AmphiOTAContext, context: AmphiContext, state: Dict[str, Any], rounds: List[Any], original_user_input: Any) -> None:
        """Fold a settled Child batch into its held parent tool calls."""
        def value(item: Any, name: str) -> Any:
            return item.get(name) if isinstance(item, dict) else getattr(item, name, None)

        def set_value(item: Any, name: str, value_: Any) -> None:
            if isinstance(item, dict):
                item[name] = value_
            else:
                setattr(item, name, value_)

        awaiting = AwaitingSubAgent.model_validate(state)
        completed = SubAgentsCompleted.model_validate(ota_context.user_input)

        ota_context.ota_record = [OTARecord.model_validate(record) for record in rounds]
        steps_by_id = {}
        for record in ota_context.ota_record:
            action = value(record, "action_result")
            for step in value(action, "results") or []:
                if value(step, "tool_name") == "run_subagent" and value(step, "tool_id"):
                    steps_by_id[str(value(step, "tool_id"))] = step

        results = {result.tool_call_id: result for result in completed.results}
        if len(results) != len(completed.results):
            raise RuntimeError("Child completion results contain duplicate tool call ids.")
        expected_call_ids = {call.tool_call_id for call in awaiting.calls}
        if set(results) != expected_call_ids:
            raise RuntimeError("Child completion results do not match the pending Child calls.")
        for call in awaiting.calls:
            step = steps_by_id.get(call.tool_call_id)
            result = results[call.tool_call_id]
            if step is None:
                raise RuntimeError(f"Child result for tool call {call.tool_call_id!r} has no held tool call.")
            if result.status == "completed":
                detail = result.answer or "(The sub-agent completed without an answer.)"
                tool_result = f"Sub-agent completed successfully.\n\n{detail}"
            else:
                detail = result.error or "No error details were provided."
                tool_result = f"Sub-agent ended with status `{result.status}`: {detail}"
            set_value(step, "tool_result", tool_result)
            set_value(step, "success", result.status == "completed")
            set_value(step, "error", result.error)

        ota_context.transition_subagents(None)
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    async def _resume_permission(self, ota_context: AmphiOTAContext, context: AmphiContext, permission: Dict[str, Any], rounds: List[Any], original_user_input: Any) -> None:

        def _reviewed_call_verdict(
            call: StepToolCall, original: str, resolved: str, instruction: Optional[str] = None
        ) -> CallVerdict:
            reason = None
            if resolved == Permission.DENY.value:
                if original == Permission.ASK.value:
                    # The user denied it; if they attached a note, merge it into reason so the agent
                    # learns why it was refused and which way to go instead (fed back into the next
                    # think round as _denied_step's error) rather than receiving only "denied".
                    reason = (
                        f"Denied by the user. User note: {instruction}"
                        if instruction else "Denied by the user."
                    )
                else:
                    reason = "Denied by the tool-permission policy."
            return CallVerdict(
                id=call.call_id,
                tool=call.tool,
                arguments=self._tool_args(call),
                verdict=resolved,
                reason=reason,
            )

        ota_context.ota_record = [OTARecord.model_validate(r) for r in rounds]
        calls = [StepToolCall.model_validate(c) for c in permission.get("calls") or []]
        verdicts = permission.get("verdicts") or []
        # Decisions arrive on a dedicated permission_answer frame and are aligned item by item via
        # call_index (chat text is no longer parsed): each ASK is ruled by its own answer (allowing A
        # and denying B both take effect); an ASK left unanswered fails closed to DENY; non-ASK items
        # pass through unchanged. The instruction carried by an allowed item (only a single-tool
        # "allow" card can produce one) decides whether step 2 below takes the "execute as-is" path or
        # the "hand back to the next think round to re-plan under the constraint" path.
        answers = self._permission_answers(ota_context.user_input)
        resolved: List[str] = []
        instructions: List[str] = []
        for i, original in enumerate(verdicts):
            if original != Permission.ASK.value:
                resolved.append(original)  # non-ASK items pass through unchanged
                continue
            ans = answers.get(i)
            if ans is None:
                resolved.append(Permission.DENY.value)  # an unanswered ASK → fail-closed
                continue
            decision, instruction = ans
            resolved.append(decision)
            if decision == Permission.ALLOW.value and instruction:
                instructions.append(instruction)
        # Re-planning applies only to a **single-tool allow card with an instruction** — the frontend
        # renders the instruction input on single-tool cards (items of length one) only. Multi-tool /
        # mixed allow+deny cards execute as-is even with an instruction, preserving the per-item ruling
        # semantics (execute A + deny B); skipping the whole round would otherwise penalise the
        # individual items. The stamp is likewise applied only on a real re-plan (otherwise already
        # executed calls would be stamped "not yet executed").
        replan = bool(instructions) and len(permission.get("items") or []) == 1
        if replan:
            self._stamp_instruction(ota_context, " ".join(instructions))

        # Terminal card data: the original ASK items (with call_index / decision flags / label) plus
        # each item's final decision and instruction. Stored on RoundPermission.items, from which GET
        # messages derives the settled approval into a terminal card (in the same position as the
        # pending one).
        decided_items: List[Dict[str, Any]] = []
        for it in permission.get("items") or []:
            ans = answers.get(it.get("call_index"))
            decision = ans[0] if ans else Permission.DENY.value  # an unanswered ASK → deny
            instruction = ans[1] if ans else None
            decided_items.append({**it, "decision": decision, "instruction": instruction})
        # Approval record: append the user's final allow/deny to the record written when the request
        # was raised, closing the loop.
        append_decisions(permission.get("audit_file"), decided_items)
        # Decision ledger: the batch of decisions is written to _routing.jsonl in structured form.
        # This is the single source of truth for "don't ask again about something already approved" —
        # it cannot be assembled from the session, because _resume_permission below ends with
        # session.without_last(), which removes the parked round, so this round's decisions would
        # never be readable along that path.
        append_user_decisions(self._permission_dir(context, permission), decided_items)

        # 1. Fold the user's decision onto the held round, restore its decision, then replay
        # the SAME tool pipeline the live path runs.
        held = ota_context.ota_record[-1]
        held_think = held.think_result
        step_content = (
            held_think.get("step_content") if isinstance(held_think, dict)
            else getattr(held_think, "step_content", None)
        ) or ""
        held.permission = RoundPermission(
            execution_mode=permission.get("execution_mode"),
            reviewed=True,
            verdicts=[
                _reviewed_call_verdict(c, original, resolved_v, (answers.get(i) or (None, None))[1])
                for i, (c, original, resolved_v) in enumerate(zip(calls, verdicts, resolved))
            ],
            items=decided_items,
        )
        ota_context.think_result = ThinkResult(step_content=step_content, tool_calls=calls)
        ota_context.transition_interaction(None)  # the held permission is resolved; clear it

        # 2. Not a re-plan (no instruction, or a multi-tool / mixed card): replay the approved calls
        # as-is (the same pipeline as the live path, with DENY items folded in after_action so the
        # per-item rulings take effect). A re-plan (single-tool allow card + instruction) is not
        # executed as-is — step 1 already stamped the instruction as this round's observation, so
        # execution is skipped here and control returns to on_agent; the next think round reads that
        # constraint and re-issues the call under it (the "instruction means re-plan" behaviour the
        # user chose). The held round keeps action_result as None, so history shows only "thinking +
        # the user's constraint note" and renders no executed card.
        if not replan:
            ota_context.tools = self._select_current_tools(ota_context, context)
            agent_ret = await self._invoke_template(self.before_action(ota_context, context))
            if agent_ret is not None:
                ota_context.think_result = agent_ret  # the DENY-folded decision (survivors)
            final = ota_context.think_result
            ota_context.action_result = (
                await self.action_tool_call(ota_context, context)
                if getattr(final, "tool_calls", None) else None
            )
            await self._invoke_template(self.after_action(ota_context, context))

        # 3. Restore the original ask and clear the session.
        context.session = context.session.without_last()
        ota_context.user_input = original_user_input

    @staticmethod
    def _permission_answers(user_input: Any) -> Dict[int, tuple]:
        """Decisions from a ``permission_answer`` frame, keyed by ``call_index``.

        Accepts the typed ``WsPermissionAnswer`` (live) or its persisted dict form;
        each value is ``(decision, instruction)``. Malformed / out-of-range items are
        dropped — an ASK left without a valid answer stays fail-closed at the call site.
        """
        raw = getattr(user_input, "answers", None)
        if raw is None and isinstance(user_input, dict):
            raw = user_input.get("answers")
        result: Dict[int, tuple] = {}
        for a in raw or []:
            idx = a.get("call_index") if isinstance(a, dict) else getattr(a, "call_index", None)
            decision = a.get("decision") if isinstance(a, dict) else getattr(a, "decision", None)
            instruction = a.get("instruction") if isinstance(a, dict) else getattr(a, "instruction", None)
            if isinstance(idx, int) and idx >= 0 and decision in (Permission.ALLOW.value, Permission.DENY.value):
                result[idx] = (decision, instruction)
        return result

    ############################################################################
    # Agent Method
    ############################################################################
    async def generate_session_title(self, ota_context: AmphiOTAContext, context: AmphiContext, llm: Any = None) -> Optional[str]:
        """
        A short, model-written title for the session — or ``None`` when none is due.
        """
        def _clean_title(raw: str) -> Optional[str]:
            if not raw or not raw.strip():
                return None
            line = raw.strip().splitlines()[0].strip().strip('"').strip("'").strip()
            return line[:TITLE_MAX_LEN].strip() or None

        # Only the first turn of an untitled session gets a title, summarised from the opener.
        if llm is None or context.session.title:
            return None
        raw = ota_context.user_input
        opener = (raw if isinstance(raw, str) else getattr(raw, "input", "") or "").strip()
        if self._has_slash_command(raw, "build"):
            opener = opener.removeprefix("/build").lstrip()
        if not opener:
            return None

        # One direct model call — best-effort; a failed title never breaks the turn.
        try:
            result = await llm.achat([
                Message.from_text(TITLE_PROMPT, role=Role.SYSTEM),
                Message.from_text(f"User request:\n{opener}", role=Role.USER),
            ])
        except Exception:  # noqa: BLE001
            return None
        content = result if isinstance(result, str) else (result.message.content if result and result.message else "")
        return _clean_title(content)

    ############################################################################
    # Helpers
    ############################################################################
    @staticmethod
    def _publish_stage(ota_context: AmphiOTAContext, status: Any) -> None:
        """Publish an internal think state using the client-facing stage shape."""
        stage = None if isinstance(status, NormalStageState) else status.stage
        workflow_id = status.workflow_id if isinstance(status, BuildStageState) else None
        payload = {"mode": status.mode, "stage": stage}
        if workflow_id is not None:
            payload["workflow_id"] = workflow_id
        if isinstance(status, PresentationStageState):
            payload.update({
                "presentation_goal": status.goal,
                "presentation_step_index": status.step_index,
                "presentation_reports": [
                    report.model_dump(mode="json") for report in status.reports
                ],
                "presentation_sources": [
                    source.model_dump(mode="json") for source in status.sources
                ],
                "presentation_outline": [
                    chapter.model_dump(mode="json") for chapter in status.outline
                ],
                "presentation_outline_confirmed": status.outline_confirmed,
                "presentation_outline_confirmation_id": status.outline_confirmation_id,
            })
        ota_context.stream.publish("stage", **payload)

    @staticmethod
    def _switch_status(current_status: Any, target_mode: str, target_stage: Optional[str]) -> Any:
        """Build the next state for an already-admitted cognitive switch."""
        if target_mode == "normal":
            return NormalStageState()
        if target_mode != current_status.mode:
            raise RuntimeError(f"Cannot switch from `{current_status.mode}` to `{target_mode}`.")
        if isinstance(current_status, BuildStageState):
            return current_status.model_copy(update={"stage": str(target_stage)})
        if isinstance(current_status, PresentationStageState):
            target = str(target_stage)
            current_index = PRESENTATION_STAGE_ORDER.index(current_status.stage)
            target_index = PRESENTATION_STAGE_ORDER.index(target)
            reports = current_status.reports
            if target_index <= current_index:
                retained_stages = set(PRESENTATION_STAGE_ORDER[:target_index])
                reports = [report for report in reports if report.stage in retained_stages]
            reset_plan = target_index <= PRESENTATION_STAGE_ORDER.index("ppt_plan")
            return current_status.model_copy(update={
                "stage": target,
                "step_index": 0,
                "reports": reports,
                **({
                    "sources": [],
                    "outline": [],
                    "outline_confirmed": False,
                    "outline_confirmation_id": None,
                } if reset_plan else {}),
            })
        if isinstance(current_status, WorkflowStageState):
            step_index = current_status.step_index if target_stage == current_status.stage else 0
            return current_status.model_copy(update={
                "stage": target_stage,
                "step_index": step_index,
            })
        raise RuntimeError("Normal mode does not expose the cognitive switch.")

    @staticmethod
    def _stamp_mode_exit(
        ota_context: AmphiOTAContext,
        status: Any,
        reason: Optional[str],
        *,
        retained: bool = True,
    ) -> None:
        """Record enough context for Main to close or redirect the special task."""
        note = f"[mode transition] `{status.mode}` stage `{status.stage}` returned control to Main."
        if reason:
            note += f" Reason: {str(reason).strip()}"
        if isinstance(status, BuildStageState) and retained:
            note += " The unfinished Build workspace was retained."
        record = ota_context._current_record()
        existing = getattr(record, "observation_result", None)
        record.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _stamp_published_directory_handoff(
        ota_context: AmphiOTAContext,
        *,
        publication: str,
        published_directory: Path,
        relative_paths: str,
        temporary_workspace: str,
    ) -> None:
        """Tell Main that a deleted workspace was published and already presented."""
        note = (
            f"[artifact publication]\n{publication}:\n"
            f"{Path(published_directory).expanduser().resolve()}\n\n"
            f"{relative_paths} The original temporary {temporary_workspace} workspace was "
            "deleted. The published location above is internal handoff context. The UI already "
            "presented the published artifacts in a dedicated card. In the final answer, "
            "briefly summarize the outcome without repeating or linking the published "
            "directory, artifact paths, file URIs, or artifact Markdown links."
        )
        record = ota_context._current_record()
        existing = getattr(record, "observation_result", None)
        record.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _stamp_stage_handoff(ota_context: AmphiOTAContext, source: Any, target: Any, reason: str) -> None:
        """Expose a source Think's self-contained handoff to the newly active Think."""
        note = (
            f"[stage handoff] `{source.mode}/{source.stage}` → "
            f"`{target.mode}/{target.stage}`\n{str(reason).strip()}"
        )
        record = ota_context._current_record()
        existing = getattr(record, "observation_result", None)
        record.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _close_build_bindings(context: AmphiContext) -> None:
        """Unbind the Build Space and its active Workflow package."""
        if context.workspace is not None:
            context.workspace.close_build_space()
        if context.workflows is not None:
            context.workflows.close_package()

    @staticmethod
    def _close_run_workflow_bindings(context: AmphiContext) -> None:
        """Unbind the Run Space and its active Run and Workflow package."""
        if context.workspace is not None:
            context.workspace.close_run_workflow_space()
        if context.workflow_runs is not None:
            context.workflow_runs.close_run_workflow()
        if context.workflows is not None:
            context.workflows.close_package()

    @staticmethod
    def _invalidate_presentation_artifacts(context: AmphiContext, stages: Iterable[str]) -> None:
        """Remove exact derived contracts that no longer belong to the active cursor."""
        workspace = context.workspace
        if workspace is None:
            return
        for stage in stages:
            relative = PRESENTATION_STAGE_ARTIFACTS.get(stage)
            if relative is None:
                continue
            path = workspace.work_dir / relative
            if path.parent.is_symlink():
                raise RuntimeError(
                    f"Cannot invalidate Presentation artifact through symlinked directory `{path.parent}`."
                )
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise RuntimeError(
                    f"Cannot invalidate stale Presentation artifact `{relative}`: {exc}."
                ) from exc

    @staticmethod
    async def _open_run_workflow(context: AmphiContext) -> Any:
        """Bind the active Space, Run artifacts, and pinned Workflow package."""
        workspace = context.workspace
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        if workspace is None or workflows is None or workflow_runs is None:
            raise RuntimeError("No Workflow runtime context is available.")
        space = await workspace.prepare_run_workflow_space("resume")
        try:
            run = workflow_runs.open_run_workflow(space.root)
            workflows.open_package(
                run.source_dir,
                workflow_id=space.workflow_id,
                name=space.workflow_name,
                validate=True,
            )
        except BaseException:
            AmphiAgent._close_run_workflow_bindings(context)
            raise
        return space

    @classmethod
    def _workflow_source(cls, status: WorkflowStageState, context: AmphiContext) -> Any:
        """Return the pinned package addressed by a Workflow cognitive state."""
        workspace = context.workspace
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        state = workspace.run_workflow if workspace is not None else None
        if state is None or workflows is None or workflow_runs is None:
            raise RuntimeError("No active Workflow Run is bound to this cognitive mode.")
        run = workflow_runs.require_run_workflow(state.root)
        source = workflows.require_package(run.source_dir)
        if (
            state.workflow_id != status.workflow_id
            or state.generation != status.generation
            or state.stage != status.stage
            or state.step_index != status.step_index
        ):
            raise RuntimeError("Workflow cognitive state does not match `.run/.state.json`.")
        return source

    async def _enter_or_resume_run_workflow(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        workflow_id: str,
        action: str,
    ) -> tuple[Any, str]:
        """Enter, resume, or atomically restart the Workspace-owned Run."""
        if context.session.is_child:
            raise RuntimeError("Child Sessions cannot control Workflow Runs.")
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        workspace = context.workspace
        if (
            workflows is None
            or workflow_runs is None
            or workspace is None
            or not context.session.id
        ):
            raise RuntimeError("No Workflow runtime context is available.")

        async def create(workflow_input: object) -> Any:
            stored_input = UserInput.from_runtime(workflow_input)
            await workflow_runs.require_completed_references(stored_input)
            async with workflows.guarded_source(workflow_id) as saved:
                if saved.workflow_id is None:
                    raise ValueError("A saved Workflow requires a stable id")
                initial_state = RunWorkflowState(
                    workflow_id=saved.workflow_id,
                    generation=uuid4().hex,
                    workflow_name=(saved.name or saved.workflow_id).strip(),
                    workflow_input=stored_input,
                )

                def populate(root: Path) -> None:
                    workflow_runs.populate_run_workflow(root, saved.root)

                await workspace.prepare_run_workflow_space(
                    "create",
                    initial_state=initial_state,
                    populate=populate,
                )
            await self._open_run_workflow(context)
            return workflows.require_package()

        active = workspace.run_workflow_checkpoint()
        if active is None:
            if action != "start":
                raise ValueError(
                    f"This Session has no unfinished Workflow Run for action `{action}`; "
                    "use `start`."
                )
            source = await create(ota_context.user_input)
            resolved_action = "started"
        else:
            if action == "start":
                raise ValueError(
                    "This Session already owns an unfinished Workflow Run; "
                    "use `resume` or `restart`."
                )
            if action == "resume":
                if active.workflow_id != workflow_id:
                    raise ValueError(
                        f"Cannot resume `{workflow_id}` because the unfinished Run belongs "
                        f"to `{active.workflow_id}`."
                    )
                await self._open_run_workflow(context)
                source = workflows.require_package()
                resolved_action = "resumed"
            elif action == "restart":
                workflow_input = (
                    active.workflow_input
                    if active.workflow_id == workflow_id
                    else ota_context.user_input
                )
                source = await create(workflow_input)
                resolved_action = "restarted"
            else:
                raise ValueError(f"Unsupported Workflow Run action: {action!r}")

        state = workspace.run_workflow
        if state is None:
            raise RuntimeError("Workflow Run space was not bound after entering the Run.")
        await workflows.associate_session(context.session.id, state.workflow_id)
        await workflow_runs.load_referenced(state.workflow_input)
        ota_context.transition_think(WorkflowStageState(
            workflow_id=state.workflow_id,
            generation=state.generation,
            stage=state.stage,
            step_index=state.step_index,
        ))
        return source, resolved_action

    @staticmethod
    async def _hydrate_run_workflow(
        status: WorkflowStageState,
        context: AmphiContext,
    ) -> Optional[WorkflowStageState]:
        """Project the authoritative `.run/.state.json` cursor into cognition."""
        workspace = context.workspace
        workflows = context.workflows
        workflow_runs = context.workflow_runs
        if workflows is None or workflow_runs is None or workspace is None:
            raise RuntimeError("No Workflow runtime context is available.")
        if not workspace.has_run_workflow:
            AmphiAgent._close_run_workflow_bindings(context)
            return None
        try:
            state = await AmphiAgent._open_run_workflow(context)
            source = workflows.require_package()
            if (
                status.workflow_id != state.workflow_id
                or status.generation != state.generation
            ):
                raise RuntimeError("Workflow cognitive state does not match the active Run.")
            steps = source.steps(state.stage)
            if state.step_index > len(steps):
                raise RuntimeError(
                    f"Workflow Run state points outside {state.stage} sections."
                )
        except BaseException:
            AmphiAgent._close_run_workflow_bindings(context)
            raise
        await workflow_runs.load_referenced(state.workflow_input)
        return WorkflowStageState(
            workflow_id=state.workflow_id,
            generation=state.generation,
            stage=state.stage,
            step_index=state.step_index,
        )

    def _workflow_remaining_units(self, status: Any, context: AmphiContext) -> int:
        """Return the remaining section count for the per-turn dispatch budget."""
        if not isinstance(status, WorkflowStageState):
            return 0
        try:
            source = self._workflow_source(status, context)
        except (RuntimeError, ValueError):
            return 0
        remaining = len(source.steps(status.stage)) - status.step_index
        return max(remaining + 1, 1)

    def _publish_workflow_progress(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        status: WorkflowStageState,
        progress: str,
        summary: Optional[str] = None,
        *,
        source: Optional[Any] = None,
    ) -> None:
        """Publish the current section through the typed Session event channel."""
        stream = getattr(ota_context, "stream", None)
        if stream is None:
            return
        source = source or self._workflow_source(status, context)
        steps = source.steps(status.stage)
        if status.step_index == len(steps):
            return
        step = steps[status.step_index]
        stream.publish(
            "workflow_progress",
            workflow_id=source.workflow_id,
            generation=status.generation,
            workflow_name=source.name,
            phase=status.stage,
            step_index=status.step_index,
            step_count=len(steps),
            title=step.title,
            **self._workflow_sections(source),
            status=progress,
            summary=summary,
        )

    @staticmethod
    def _workflow_sections(source: Any) -> Dict[str, List[str]]:
        """Return the serialized execution section titles."""
        return {
            "execution_steps": [step.title for step in source.execution_steps],
        }

    @classmethod
    async def _publish_workflow_run(
        cls,
        context: AmphiContext,
        expected: WorkflowStageState,
        *,
        status: WorkflowRunStatus,
    ) -> Any:
        """Validate an active terminal boundary and publish its immutable result."""
        workflow_runs = context.workflow_runs
        workspace = context.workspace
        space = workspace.run_workflow if workspace is not None else None
        if workflow_runs is None or space is None:
            raise RuntimeError("Cannot save a Workflow Run without its result library.")
        source = cls._workflow_source(expected, context)
        run = workflow_runs.require_run_workflow(space.root)
        if (
            space.workflow_id != expected.workflow_id
            or space.generation != expected.generation
            or space.stage != expected.stage
            or space.step_index != expected.step_index
        ):
            raise RuntimeError("Workflow cognitive state does not match `.run/.state.json`.")

        if status is WorkflowRunStatus.FAILED:
            failure = run.result_dir / "failure.md"
            if failure.is_symlink() or not failure.is_file():
                raise ValueError("Failed Run Workflow requires a durable failure report")
        elif space.step_index != len(source.execution_steps):
            raise ValueError("Run Workflow execution has not reached its completion boundary")

        return await workflow_runs.publish_run_workflow(
            result_id=workflow_runs.terminal_result_id(
                context.session.id,
                space.generation,
            ),
            workflow_id=space.workflow_id,
            workflow_name=space.workflow_name,
            source_session_id=context.session.id,
            workflow_input=space.workflow_input,
            status=status,
        )

    async def _settle_workflow_boundary(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> Optional[Any]:
        """Advance or publish a Workflow whose durable cursor is at a boundary.

        Returns
        -------
        WorkflowRun, optional
            The published terminal Run when this call completed it.

        Notes
        -----
        The durable ``.run/.state.json`` cursor is authoritative. This method
        therefore also settles Runs left at an execution completion boundary
        when terminal publication is interrupted.
        """
        status = ota_context.think_status
        if not isinstance(status, WorkflowStageState):
            return None
        source = self._workflow_source(status, context)
        steps = source.steps(status.stage)
        if status.step_index < len(steps):
            return None
        if status.step_index > len(steps):
            raise RuntimeError(
                f"Workflow Run state points outside {status.stage} sections."
            )

        published = await self._publish_workflow_run(
            context,
            status,
            status=WorkflowRunStatus.COMPLETED,
        )
        terminal_summary = (
            f"Workflow `{published.workflow_name}` completed all execution sections successfully."
        )
        await self._finish_workflow_run(
            ota_context,
            context,
            status,
            generation=status.generation,
            summary=terminal_summary,
            published=published,
        )
        return published

    @staticmethod
    def _stamp_workflow_result(
        ota_context: AmphiOTAContext,
        summary: str,
        published: Any,
        result_file_count: int,
    ) -> None:
        """Add one structured Workflow terminal result to the persisted trace."""
        record = ota_context._current_record()
        existing = getattr(record, "observation_result", None)
        note = f"{summary} Saved result id: `{published.run_id}`."
        record.observation_result = f"{existing}\n[workflow] {note}" if existing else f"[workflow] {note}"
        record.workflow_result = {
            "run_id": published.run_id,
            "workflow_id": published.workflow_id,
            "workflow_name": published.workflow_name,
            "status": published.status.value,
            "created_at": published.created_at.isoformat(),
            "result_file_count": result_file_count,
            "summary": summary,
        }

    async def _finish_workflow_run(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        status: WorkflowStageState,
        *,
        generation: str,
        summary: str,
        published: Any,
    ) -> None:
        """Close one already-persisted Run and return cognition to Main."""
        workspace = context.workspace
        if workspace is None:
            raise RuntimeError("Cannot close a Workflow Run without its Workspace.")
        deleted = await workspace.discard_run_workflow(
            expected_generation=generation,
        )
        if not deleted and workspace.has_run_workflow:
            raise RuntimeError(
                "The saved Workflow Run was replaced before its active snapshot could be removed."
            )
        # Intermediate work files are published for inspection and recovery, but
        # the terminal card's result count remains the final-deliverable count.
        result_file_count = len(published.result_files)
        self._stamp_workflow_result(
            ota_context,
            summary,
            published,
            result_file_count,
        )
        self._stamp_published_directory_handoff(
            ota_context,
            publication=(
                "The artifacts under .run/result and .run/background/work "
                "were published under"
            ),
            published_directory=published.root,
            relative_paths="Paths relative to .run are unchanged.",
            temporary_workspace=".run",
        )
        stream = getattr(ota_context, "stream", None)
        if stream is not None:
            stream.publish(
                "workflow_result",
                run_id=published.run_id,
                workflow_id=published.workflow_id,
                workflow_name=published.workflow_name,
                status=published.status.value,
                created_at=published.created_at.isoformat(),
                result_file_count=result_file_count,
                summary=summary,
            )
        self._stamp_mode_exit(
            ota_context,
            status,
            summary,
            retained=False,
        )
        self._close_run_workflow_bindings(context)
        ota_context.transition_think(NormalStageState())

    @staticmethod
    async def _sync_build_space(ota_context: AmphiOTAContext, context: AmphiContext, *, create: bool = False) -> None:
        """Project the resolved think state onto this turn's Workspace.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Turn state containing the active discriminated think state.
        context : AmphiContext
            Session context whose Workspace receives the Build-space projection.
        create : bool
            Create a new build directory instead of reopening an existing one.
        """
        workspace = context.workspace
        if workspace is None:
            return
        workflows = context.workflows
        think = ota_context.think_status
        if isinstance(think, BuildStageState):
            if workflows is None:
                raise RuntimeError("No Workflow library is available for the active Build.")
            if create:
                workflows.close_package()
            active = workspace.build
            if create:
                if think.workflow_id:
                    async with workflows.guarded_source(think.workflow_id) as workflow:
                        active = await workspace.prepare_build_space(
                            "create",
                            workflow_id=think.workflow_id,
                            stage=think.stage,
                        )
                        try:
                            await workflows.restore_source(workflow, active.root)
                            task_baseline = workflow.task_markdown
                            if task_baseline is None:
                                raise RuntimeError(
                                    "The saved Workflow has no task.md edit baseline."
                                )
                            active.record_edit_task_baseline(task_baseline)
                        except BaseException:
                            await workspace.discard_build()
                            raise
                else:
                    active = await workspace.prepare_build_space(
                        "create",
                        stage=think.stage,
                    )
            elif active is None:
                active = await workspace.prepare_build_space(
                    "resume",
                    stage=think.stage,
                )
            if active.workflow_id != think.workflow_id:
                raise RuntimeError("The active Build does not match the current edit target.")
            active.set_stage(think.stage, think.workflow_id)
            workflows.open_package(active.root)
            return
        workspace.close_build_space()
        if workflows is not None:
            workflows.close_package()

    @staticmethod
    def _get_current_ota_permission_status(ota_context: AmphiOTAContext) -> RoundPermission:
        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return RoundPermission()
        permission = getattr(records[-1], "permission", None)
        if permission is None:
            permission = (getattr(records[-1], "model_extra", None) or {}).get("permission")
        if isinstance(permission, RoundPermission):
            return permission
        if isinstance(permission, dict):
            return RoundPermission.model_validate(permission)
        return RoundPermission()

    @staticmethod
    def _reviewed_verdicts(verdicts: List[CallVerdict]) -> List[CallVerdict]:
        reviewed: List[CallVerdict] = []
        for cv in verdicts:
            if cv.verdict == Permission.DENY.value and not cv.reason:
                reviewed.append(cv.model_copy(update={"reason": "Denied by the user."}))
            else:
                reviewed.append(cv)
        return reviewed

    async def permission_check(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
        *,
        execution_mode: Optional[str] = None,
    ) -> List[CallVerdict]:
        """Evaluate system permissions for the proposed tool calls.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active turn containing the proposed tool calls and current Think stage.
        context : AmphiContext
            Session workspace, execution mode, mounts, and safety classifier context.
        execution_mode : Optional[str]
            Effective mode already resolved for this round; omitted to resolve it here.

        Returns
        -------
        List[CallVerdict]
            Permission verdicts aligned one-to-one with the proposed tool calls.
        """
        calls = getattr(ota_context.think_result, "tool_calls", None) or []
        execution_mode = execution_mode or self._effective_execution_mode(ota_context, context)
        workspace = context.workspace
        root = (
            str(workspace.work_dir)
            if workspace is not None
            else str(context.session.workspace_root or "")
        )
        # Merged from main: the real mount roots (this was mount_roots=[] with a TODO on the original
        # branch). Mounted directories are judged by the engine as inside the boundary rather than
        # always out of bounds; with no session (an edge case) it falls back to an empty list.
        mount_roots = workspace.mount_roots() if workspace is not None else []
        workflow_runs = context.workflow_runs
        if workflow_runs is not None:
            referenced_runs = workflow_runs.referenced_runs(ota_context.user_input)
            mount_roots.extend(
                str(path)
                for run in referenced_runs
                for path in (run.result_dir, run.background_work_dir)
            )
            if isinstance(ota_context.think_status, WorkflowStageState):
                source = self._workflow_source(ota_context.think_status, context)
                mount_roots.append(str(source.source_root))
                run_state = context.workspace.run_workflow
                if run_state is None:
                    raise RuntimeError("Workflow Run space was not prepared for permission review.")
                mount_roots.extend(
                    str(path)
                    for input_run in workflow_runs.referenced_runs(
                        run_state.workflow_input
                    )
                    for path in (input_run.result_dir, input_run.background_work_dir)
                )
        mount_roots = list(dict.fromkeys(mount_roots))
        audit_dir = workspace.permission_dir if workspace is not None else None
        engine = PermissionEngine(
            root,
            mount_roots=mount_roots,
            mode=execution_mode,
            classifier=LlmSafetyClassifier(self.llm, audit_dir=audit_dir),
            audit_dir=audit_dir,
        )
        verdicts = await engine.evaluate(
            calls,
            self._recent_user_messages(ota_context, context),
            agent_reasoning=self._current_reasoning(ota_context),
            session_approvals=self._session_approvals(context, ota_context),
            named_paths=self._named_paths(ota_context, context),
        )
        aligned: List[CallVerdict] = []
        for c, verdict in zip(calls, verdicts):
            cid = getattr(c, "call_id", None)
            aligned.append(verdict.model_copy(update={"id": str(cid)}) if cid else verdict)
        return aligned

    @staticmethod
    def _current_think_unit_name(ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Resolve the active ThinkUnit from cognitive state and Session role."""
        status = ota_context.think_status
        if context.session.is_child:
            if not isinstance(status, NormalStageState):
                raise RuntimeError("Child Sessions can run only the normal SubAgent Think.")
            return "subagent"
        return status.stage

    def _current_think_worker(self, ota_context: AmphiOTAContext, context: AmphiContext) -> Any:
        """Return the worker bound to the active cognitive state and Session role."""
        unit_name = self._current_think_unit_name(ota_context, context)
        unit = getattr(self, unit_name, None)
        worker = getattr(unit, "_worker_template", None)
        if worker is None:
            raise RuntimeError(f"No Think worker is registered for unit `{unit_name}`.")
        return worker

    def _effective_execution_mode(self, ota_context: AmphiOTAContext, context: AmphiContext) -> str:
        """Resolve the current Think's override over the Invocation/User base mode."""
        worker = self._current_think_worker(ota_context, context)
        override = getattr(worker, "permission_mode_override", None)
        return ExecutionMode(override if override is not None else context.execution_mode).value

    def _select_current_tools(self, ota_context: AmphiOTAContext, context: AmphiContext) -> List[ToolSpec]:
        """Select the exact runtime tools owned by the active Think worker."""
        worker = self._current_think_worker(ota_context, context)
        select_tools = getattr(worker, "select_tools", None)
        if not callable(select_tools):
            raise RuntimeError(
                f"Think worker `{type(worker).__name__}` does not define select_tools()."
            )
        return list(select_tools(ota_context, context))

    async def legality_check(self, ota_context: AmphiOTAContext, context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict]) -> List[CallVerdict]:
        """Evaluate Agent- and Worker-level action legality after permission.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active turn and current Think stage.
        context : AmphiContext
            Session context used by legality rules.
        calls : List[StepToolCall]
            Complete proposed call batch in model order.
        verdicts : List[CallVerdict]
            Permission verdicts aligned one-to-one with ``calls``.

        Returns
        -------
        List[CallVerdict]
            Final admission verdicts with illegal allowed calls downgraded to deny.

        """
        think_status = ota_context.think_status

        def _agent_legality_check(call: StepToolCall) -> Optional[str]:
            """Check one call against Agent-owned execution invariants."""
            tool_name = getattr(call, "tool", None)
            visible_tools = {
                spec.tool_name for spec in getattr(ota_context, "tools", None) or []
            }
            if tool_name not in visible_tools:
                return (
                    f"tool `{tool_name}` rejected: it is not available in this "
                    "Session's current ToolSurface."
                )
            if tool_name == "switch":
                if isinstance(think_status, NormalStageState):
                    return "switch rejected: Main enters cognitive modes through their dedicated tools."
                arguments = self._tool_args(call)
                requested_mode = arguments.get("mode") or None
                target_stage = arguments.get("stage") or None
                if requested_mode not in (None, "normal"):
                    return (
                        f"switch rejected: omit mode to remain in `{think_status.mode}`, "
                        "or use mode `normal` to return to Main."
                    )
                if requested_mode == "normal":
                    if target_stage:
                        return (
                            "switch rejected: mode `normal` cannot be combined with "
                            "a target stage."
                        )
                    return None
                if not target_stage:
                    return (
                        "switch rejected: provide a target stage, or use mode `normal` "
                        "to return to Main."
                    )

                target_mode = think_status.mode
                registered_stages = self.thinking_modes.get(target_mode)
                unit = getattr(self, str(target_stage), None)
                if (
                    registered_stages is None
                    or target_stage not in registered_stages
                    or unit is None
                ):
                    return (
                        f"switch rejected: target stage `{target_stage}` is not registered "
                        f"for mode `{target_mode}`."
                    )
            if tool_name == "request_build":
                arguments = self._tool_args(call)
                if arguments.get("mode", "ask") != "ask":
                    return None
                workspace = context.workspace
                retained = workspace.build_checkpoint() if workspace is not None else None
                if retained is not None and not str(arguments.get("reason") or "").strip():
                    return (
                        "request_build rejected: mode `ask` requires a concrete reason "
                        "when resolving an unfinished Build conflict."
                    )
            return None

        worker = self._current_think_worker(ota_context, context)
        think_legality_check = getattr(worker, "legality_check", None)

        resolved: List[CallVerdict] = []
        for call, verdict in zip(calls, verdicts):
            if verdict.verdict != Permission.ALLOW.value:
                resolved.append(verdict)
                continue

            reason = _agent_legality_check(call)
            if reason is None and callable(think_legality_check):
                reason = await think_legality_check(call, ota_context, context)
            if (
                reason is None
                and getattr(call, "tool", None) == "switch"
                and isinstance(think_status, BuildStageState)
            ):
                arguments = self._tool_args(call)
                if (
                    arguments.get("mode") != "normal"
                    and arguments.get("stage")
                    and not str(arguments.get("reason") or "").strip()
                ):
                    reason = (
                        "switch rejected: a Build stage handoff requires a non-empty, "
                        "self-contained reason for the next stage."
                    )
            resolved.append(
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if reason else verdict
            )

        if (
            len(calls) > 1
            and any(getattr(call, "tool", None) == "request_human_task_confirm" for call in calls)
        ):
            reason = (
                "task confirmation rejected: request_human_task_confirm must run alone "
                "after the final task.md write has completed."
            )
            resolved = [
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if (
                    verdict.verdict == Permission.ALLOW.value
                    and getattr(call, "tool", None) == "request_human_task_confirm"
                )
                else verdict
                for call, verdict in zip(calls, resolved)
            ]

        build_controls = {"edit_workflow", "request_build"}
        if len(calls) > 1 and any(getattr(call, "tool", None) in build_controls for call in calls):
            reason = "Build control rejected: Build entry tools must run alone."
            resolved = [
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if verdict.verdict == Permission.ALLOW.value and getattr(call, "tool", None) in build_controls
                else verdict
                for call, verdict in zip(calls, resolved)
            ]

        # Entering presentation mode changes the next ThinkUnit. Keep that state
        # transition atomic, matching the existing Build and Workflow entry rule.
        presentation_controls = {"report_presentation_step", "request_presentation"}
        if len(calls) > 1 and any(getattr(call, "tool", None) in presentation_controls for call in calls):
            reason = "Presentation control rejected: entry and step reports must run alone."
            resolved = [
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if verdict.verdict == Permission.ALLOW.value and getattr(call, "tool", None) in presentation_controls
                else verdict
                for call, verdict in zip(calls, resolved)
            ]

        workflow_controls = {
            "request_run_workflow",
            "report_workflow_step",
        }
        if len(calls) > 1 and any(getattr(call, "tool", None) in workflow_controls for call in calls):
            reason = (
                "Workflow control rejected: Run entry, step-report, and completion "
                "tools must run alone."
            )
            resolved = [
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if verdict.verdict == Permission.ALLOW.value and getattr(call, "tool", None) in workflow_controls
                else verdict
                for call, verdict in zip(calls, resolved)
            ]

        control_flow_tools = self.exclusive_control_tools | {"run_subagent"}
        allowed_control_tools = [
            str(getattr(call, "tool", ""))
            for call, verdict in zip(calls, resolved)
            if verdict.verdict == Permission.ALLOW.value
            and getattr(call, "tool", None) in control_flow_tools
        ]
        exclusive_count = sum(
            tool in self.exclusive_control_tools for tool in allowed_control_tools
        )
        invalid_control_mix = exclusive_count > 1 or (
            exclusive_count == 1 and "run_subagent" in allowed_control_tools
        )
        if invalid_control_mix:
            reason = (
                "control-flow rejected: only one exclusive control tool may run per "
                "round; run_subagent may be batched only with other run_subagent calls."
            )
            resolved = [
                verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
                if (
                    verdict.verdict == Permission.ALLOW.value
                    and getattr(call, "tool", None) in control_flow_tools
                )
                else verdict
                for call, verdict in zip(calls, resolved)
            ]
        return resolved

    @staticmethod
    def _recent_user_messages(ota_context: AmphiOTAContext, context: AmphiContext) -> List[str]:
        """Recent USER request texts (prior turns + this turn) — the classifier's TRUSTED
        intent signal and the ONLY authorization basis. User-provenance only; never assistant
        reasoning or tool output.

        Fixes the prior single-turn bug: the classifier's soft_deny unlock keys on "did the
        user name this operation", which a one-message window couldn't see across a multi-step
        turn where the naming happened in an earlier turn. History is best-effort — any failure
        degrades to just the current turn, never breaks permission evaluation."""
        messages: List[str] = []
        try:
            # Newest-first with an early break: this runs on every init_state and
            # permission batch, and only the window's tail survives anyway — a
            # 1000-turn session must not pay a full scan per resume.
            for turn in reversed(context.session.get_all()):
                if len(messages) >= _MAX_CLASSIFIER_USER_MESSAGES:
                    break
                text = getattr(getattr(turn, "user_input", None), "text", "") or ""
                if isinstance(text, str) and text.strip():
                    messages.append(text.strip())
        except Exception:  # noqa: BLE001 — history is context, must not break the gate
            pass
        messages.reverse()
        current = AmphiAgent._current_user_text(ota_context)
        if current and (not messages or messages[-1] != current):
            messages.append(current)
        return messages[-_MAX_CLASSIFIER_USER_MESSAGES:]

    @staticmethod
    def _current_user_text(ota_context: AmphiOTAContext) -> str:
        """This turn's user input as plain text (str input, or ``.input`` / ``.text`` field)."""
        raw = getattr(ota_context, "user_input", "")
        text = raw if isinstance(raw, str) else (getattr(raw, "input", "") or getattr(raw, "text", "") or "")
        return text.strip() if isinstance(text, str) else ""

    @staticmethod
    def _permission_dir(context: Optional[AmphiContext], permission: Optional[Dict[str, Any]] = None) -> Optional[Path]:
        """The permissions directory of this session (where the audit trail and decision ledger
        live). Returns ``None`` when it cannot be resolved, and callers skip silently.

        The workspace is authoritative; when the workspace is unreachable it falls back to the
        parent directory of the approval record — that record is written into the same directory,
        so it is another way of obtaining the same fact."""
        workspace = getattr(context, "workspace", None) if context is not None else None
        perm_dir = getattr(workspace, "permission_dir", None)
        if perm_dir is not None:
            return perm_dir
        audit_file = (permission or {}).get("audit_file")
        return Path(audit_file).parent if audit_file else None

    @staticmethod
    def _approval_line(row: Dict[str, Any]) -> str:
        """One row of the decision ledger → one line fed to the classifier. **It must carry the
        concrete target**: what the classifier judges is "whether the operation under review is of
        the same kind as an approved one", and ``summary`` is the plain-language text produced by
        :mod:`_describe` (deliberately without paths or arguments), which alone cannot settle
        "whether the write_file just approved and this edit_file are in the same repository".

        The target is taken from ``command`` in the ledger (already processed by the keep-both-ends
        policy on write, so the part of a heredoc that actually runs is not cut off). A missing or
        malformed decision → an empty string (which the caller discards).

        Everything this function renders itself is pinned to English: its only consumer is the
        classifier's all-English system prompt, whose approved/denied recognition keys off these
        lines — the same reason ``_engine.py`` pins judgement labels to en. The persisted
        ``label`` text was rendered in the request locale at park time, so rows carry the label's
        catalog id too and it is re-rendered in English here; ``summary``/legacy ``label`` text
        stays as written."""
        if not isinstance(row, dict):
            return ""
        decision = row.get("decision")
        tool = str(row.get("tool") or "")
        if decision not in ("allow", "deny") or not tool:
            return ""
        mark = backend_i18n.text(
            "security.approval.allowed_mark"
            if decision == "allow"
            else "security.approval.denied_mark",
            locale="en",
        )
        parts = [f"{mark} `{tool}`"]
        target = str(row.get("command") or "").strip().replace("\n", " ")
        if target:
            parts.append(backend_i18n.text("security.approval.target", target=target, locale="en"))
        summary = str(row.get("summary") or "").strip()
        label_id = str(row.get("label_id") or "").strip()
        if summary:
            parts.append(summary)
        elif label_id:
            parts.append(label_text(label_id, locale="en"))
        elif str(row.get("label") or "").strip():
            parts.append(str(row.get("label") or "").strip())
        return " — ".join(parts)

    @staticmethod
    def _session_approvals(context: Optional[AmphiContext] = None, ota_context: Optional[AmphiOTAContext] = None) -> List[str]:
        """The allow/deny decisions the user made this session — **trusted context** (equivalent to
        the user naming and authorising that operation), so an operation already decided on does not
        raise another card.

        The source of truth is the decision rows in
        ``<session>/.internal/permissions/_routing.jsonl``
        (:func:`~security._routing.read_user_decisions`). It is **not assembled from the session
        object**, for three reasons, every one of them hit in practice:

        * ``_resume_permission`` ends with ``session.without_last()``, which removes the parked
          round, so this round's decision **never appears** in ``session.get_all()``;
        * the ledger stores the **full command**, whereas assembling from items truncates the target
          to 200 characters — and for a heredoc command (``python3 - <<'PY' … base64 …``) the first
          200 characters are all wrapper, cutting away the actual intent at the end, so the
          classifier cannot recognise "the same kind" and asks again;
        * an append-only file is immune to object lifecycles, and the memory survives a daemon
          restart.

        ``ota_context`` is no longer needed (the parameter is kept so call sites need not change);
        best-effort: if it cannot be read it returns empty and never interrupts the approval flow."""
        rows = read_user_decisions(AmphiAgent._permission_dir(context))
        lines = [AmphiAgent._approval_line(r) for r in rows]
        # Deduplicate: when the same operation raises several dialogs in a row, duplicate rows must
        # not eat the whole budget.
        return list(dict.fromkeys(line for line in lines if line))[-_MAX_CLASSIFIER_APPROVALS:]

    @staticmethod
    def _named_paths(ota_context: AmphiOTAContext, context: Optional[AmphiContext] = None) -> List[str]:
        """Absolute local paths the user named in their messages across **the whole session** — the
        basis for the policy's ALLOW entry 'project directory named by the user'.

        Why this is tracked separately: that exception only recognises paths the user actually
        named, while ``_recent_user_messages`` keeps only the last 5 messages — once the naming
        message is pushed out of the window by later "go on / ok" messages, the exception **silently
        stops applying** and the same directory suddenly starts raising dialogs. Paths are small, so
        they do not slide out with the message window and accumulate for the whole session. This
        states only the fact that the user mentioned them; whether that authorises anything is still
        judged by the classifier against the policy."""
        texts: List[str] = []
        session = getattr(context, "session", None) if context is not None else None
        if session is not None:
            try:
                for turn in session.get_all():
                    text = getattr(getattr(turn, "user_input", None), "text", "") or ""
                    if isinstance(text, str):
                        texts.append(text)
            except Exception:  # noqa: BLE001 — context is best-effort; it must never interrupt the ruling
                pass
        texts.append(AmphiAgent._current_user_text(ota_context))
        found: List[str] = []
        for text in texts:
            for match in _NAMED_PATH_RE.finditer(text):
                path = match.group("quoted_windows") or match.group("plain") or ""
                found.append(path.rstrip(".,;:!?。，、；：！？)]}】》`'\""))
        return list(dict.fromkeys(p for p in found if len(p) > 3))[-_MAX_CLASSIFIER_NAMED_PATHS:]

    @staticmethod
    def _current_reasoning(ota_context: AmphiOTAContext) -> str:
        """The Agent's reasoning behind THIS batch of tool calls (the think step's
        ``step_content``) — fed to the classifier as an UNTRUSTED claim to CROSS-VERIFY against
        the user's stated goals. Never authorization on its own (soft_deny still unlocks only on
        user naming); tool execution results are still NOT fed. Truncated to bound prompt size
        and prompt-injection surface."""
        think = getattr(ota_context, "think_result", None)
        text = getattr(think, "step_content", "") if think is not None else ""
        if not isinstance(text, str):
            return ""
        return text.strip()[:_MAX_CLASSIFIER_REASONING_CHARS]

    @staticmethod
    def _stamp_instruction(ota_context: AmphiOTAContext, instruction: str) -> None:
        """Stamp the user's approval-time custom instruction onto the held round's
        observation. Under the "instruction ⇒ re-plan" semantics, the approved call is
        NOT executed verbatim — this note tells the next think unit the action is still
        pending and must be re-issued honouring the constraint."""
        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return
        last = records[-1]
        note = (
            "[The user allowed the operation above but attached a constraint — the operation "
            "has **NOT** been executed; adjust the arguments to honour the constraint and "
            f"re-issue the corresponding tool call] {instruction}"
        )
        existing = getattr(last, "observation_result", None)
        last.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _tool_args(call: Any) -> Dict[str, Any]:
        """Flatten a ``StepToolCall``'s name/value argument list into a dict."""
        out: Dict[str, Any] = {}
        for arg in getattr(call, "tool_arguments", None) or []:
            if isinstance(arg, dict):
                name = arg.get("name")
                if name is not None:
                    out[str(name)] = arg.get("value")
                continue
            name = getattr(arg, "name", None)
            if name is not None:
                out[str(name)] = getattr(arg, "value", None)
        return out

    @staticmethod
    def _stamp_continue(ota_context: AmphiOTAContext) -> None:
        """Ask Main to recover an empty response without assuming the task is done."""
        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return
        note = (
            "[system] The previous round ended without a user-visible response. "
            "Re-evaluate the current task from the available context and continue "
            "appropriately. If work remains, continue it and call tools as needed. "
            "If the task is complete, give the user a clear, concise outcome and say "
            "where relevant results can be found. If progress is blocked or depends "
            "on a user decision, explain the concrete blocker and use the appropriate "
            "interaction. Do not assume completion solely because the previous round "
            "was empty, and do not repeat work already confirmed complete."
        )
        last = records[-1]
        existing = getattr(last, "observation_result", None)
        last.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _stamp_workflow_continue(ota_context: AmphiOTAContext) -> None:
        """Remind the active Workflow stage that a section ends through its report tool."""
        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return
        note = (
            "[workflow] The current section is still active. Complete only this section, "
            "then call report_workflow_step with its result. Do not use "
            "switch(mode=\"normal\") as a completion shortcut; it is only for an explicit "
            "user request to stop or leave the Run. Ask the user when required."
        )
        record = records[-1]
        existing = getattr(record, "observation_result", None)
        record.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _stamp_presentation_continue(ota_context: AmphiOTAContext) -> None:
        """Remind a presentation stage to finish through a real cognitive handoff."""
        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return
        status = ota_context.think_status
        if not isinstance(status, PresentationStageState):
            return
        steps = PRESENTATION_STAGE_STEPS.get(status.stage, ())
        if status.stage == "ppt_brief":
            note = (
                "[presentation] Brief is still active. Complete `.presentation/brief.md`, then "
                "call switch(stage=\"ppt_plan\", reason=...). Do not call "
                "report_presentation_step; Brief has no production-step cursor."
            )
        elif status.step_index < len(steps):
            current = steps[status.step_index]
            note = (
                f"[presentation] Production step `{current.step_id}` is still active. Complete "
                "only that step, then call report_presentation_step with its concrete result "
                "and evidence."
            )
        else:
            current_index = PRESENTATION_STAGE_ORDER.index(status.stage)
            if status.stage == "ppt_review":
                handoff = 'switch(mode="normal", reason=...)'
            else:
                handoff = f'switch(stage="{PRESENTATION_STAGE_ORDER[current_index + 1]}", reason=...)'
            note = (
                f"[presentation] Every production step in `{status.stage}` is reported. Call "
                f"{handoff} now; do not repeat a completed step."
            )
        record = records[-1]
        existing = getattr(record, "observation_result", None)
        record.observation_result = f"{existing}\n{note}" if existing else note

    @staticmethod
    def _stamp_build_continue(ota_context: AmphiOTAContext) -> None:
        # Fed back to a build stage that finished without its completion control.
        status = ota_context.think_status
        stage = status.stage if isinstance(status, BuildStageState) else ""
        if stage == "clarify":
            nudge = (
                "[build] Your last reply did NOT complete Clarify. When task.md is ready, "
                "call request_human_task_confirm so the user can review it; the system "
                "will enter Explore after confirmation. Need missing input first? Call "
                "request_human_choice."
            )
        elif stage == "verify":
            nudge = (
                "[build] Your last reply did NOT complete Verify. On a safe verification PASS, call "
                "request_human_workflow_confirm and end the turn on that tool call; only "
                "successful user confirmation and save close the Build. Do not use "
                "switch(mode=\"normal\") as a completion shortcut. If verification failed, "
                "switch to the stage that owns the defect or ask the user when required."
            )
        else:
            nudge = (
                "[build] Your last reply did NOT move the pipeline — you are still in this "
                "stage. The stage advances ONLY when you actually INVOKE the switch tool "
                "(a real tool call). Writing a tool call as text in your message does NOT "
                "count and changes nothing. When this stage is done, call the switch tool "
                "to hand off to the next Build stage. Never switch to normal merely because "
                "the work appears complete; normal is only for an explicit user pause or exit. "
                "Need input from the user? Call request_human_choice. Otherwise invoke the "
                "next-stage handoff now—call it, don't type it."
            )

        records = getattr(ota_context, "ota_record", None) or []
        if not records:
            return
        last = records[-1]
        existing = getattr(last, "observation_result", None)
        last.observation_result = (
            f"{existing}\n{nudge}" if existing else nudge
        )

    @staticmethod
    def _save_large_tool_results(result: Optional[ActionResult], context: AmphiContext) -> None:
        """Persist oversized tool outputs or errors and leave a short pointer."""
        if result is None:
            return
        workspace = context.workspace
        base_dir = workspace.tool_result_dir if workspace is not None else None
        if base_dir is None:
            return

        day_dir = base_dir / datetime.now().strftime("%Y-%m-%d")
        for step in getattr(result, "results", None) or []:
            failed = getattr(step, "success", True) is False
            value = (
                getattr(step, "error", None)
                if failed
                else getattr(step, "tool_result", None)
            )
            if value is None:
                continue
            text = (
                json.dumps(value, ensure_ascii=False, default=str)
                if isinstance(value, dict)
                else str(value)
            )
            if len(text) <= TOOL_RESULT_INLINE_CHAR_LIMIT:
                continue

            day_dir.mkdir(parents=True, exist_ok=True)
            raw_tool_name = str(getattr(step, "tool_name", None) or "tool")
            safe_tool_name = "".join(
                char if char.isalnum() or char in ("-", "_") else "_"
                for char in raw_tool_name
            ).strip("_") or "tool"
            timestamp = datetime.now().strftime("%H%M%S_%f")
            while True:
                path = day_dir / f"{safe_tool_name}_{timestamp}_{secrets.token_hex(4)}.txt"
                if not path.exists():
                    break

            payload = text.encode("utf-8")
            path.write_bytes(payload)
            pointer = (
                "Tool result exceeded inline limit and was written to file.\n"
                f"Path: {path}\n"
                f"Bytes: {len(payload)}\n"
                f"Inline limit: {TOOL_RESULT_INLINE_CHAR_LIMIT} characters."
            )
            if failed:
                step.error = pointer
            else:
                step.tool_result = pointer

    @staticmethod
    def _denied_step(cv: CallVerdict) -> ActionStepResult:
        """A blocked tool call rendered as a failed step, so the next loop reads why.

        ``tool_id`` is the verdict's unique ``id`` — never a static ``deny_<tool>``,
        which collided across same-tool denials and 400'd the LLM ("Duplicate value
        for 'tool_call_id'").
        """
        return ActionStepResult(
            tool_id=cv.id,
            tool_name=cv.tool,
            tool_arguments=cv.arguments,
            tool_result=None,
            success=False,
            error=model_facing_reason(cv),
        )

    @classmethod
    def _duplicate_tool_call_verdicts(cls, calls: List[StepToolCall]) -> Optional[List[CallVerdict]]:
        """Reject an entire tool batch when provider call identities collide."""
        seen: set[str] = set()
        duplicates: set[str] = set()
        for call in calls:
            call_id = getattr(call, "call_id", None)
            if not call_id:
                continue
            rendered_id = str(call_id)
            if rendered_id in seen:
                duplicates.add(rendered_id)
            seen.add(rendered_id)
        if not duplicates:
            return None
        rendered = ", ".join(f"`{call_id}`" for call_id in sorted(duplicates))
        reason = (
            "tool-call batch rejected before execution because duplicate call "
            f"id(s) were returned: {rendered}."
        )
        return [
            CallVerdict(
                tool=str(getattr(call, "tool", None) or "(unknown)"),
                arguments=cls._tool_args(call),
                verdict=Permission.DENY.value,
                reason=reason,
            )
            for call in calls
        ]
