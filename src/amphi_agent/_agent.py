import asyncio
import json
import logging
import re
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from bridgic.amphibious import (
    ActionResult,
    ActionStepResult,
    AmphibiousAutoma,
    RETURN,
    StepToolCall,
    ThinkUnit,
    ThinkUnitDescriptor,
    think_unit,
    OTARecord,
)
from bridgic.amphibious._amphibious_automa import _decision_to_matched_calls
from bridgic.amphibious._type import ThinkResult  # the worker's decision (step_content + tool_calls)
from bridgic.core.agentic import ConcurrentAutoma
from bridgic.core.agentic.tool_specs import ToolSpec
from bridgic.core.automa.args import ArgsMappingRule, InOrder
from bridgic.core.model.types import Message, Role, ToolCall

from .cognitive import (
    PRESENTATION_STAGE_ORDER,
    PRESENTATION_STAGE_STEPS,
    get_cognitive_stages,
    BaseThink,
    WorkflowRunThink,
)
from ._context import AmphiContext, AmphiOTAContext, ContextUsageSnapshot
from ._describe import describe_commands
from ._error import AgentEmptyAnswerError
from .prompts.title import TITLE_PROMPT
from ._state import (
    AgentResult,
    AgentState,
    AwaitingPermission,
    BuildStageState,
    AwaitingSubAgent,
    ContextCompactionState,
    NormalStageState,
    PresentationStageState,
    RoundPermission,
    CallVerdict,
    SubAgentsCompleted,
    WorkflowStageState,
)
from .security import ExecutionMode, LlmSafetyClassifier, Permission, PermissionEngine
from .security._audit import append_decisions, write_approval_record
from .security._routing import append_user_decisions, read_user_decisions
from .security._classifier import MAX_USER_MESSAGES as _CLASSIFIER_MAX_USER_MESSAGES
from .security._classify import label_text
from .security._engine import model_facing_reason
from .tools._bash import current_execution_mode, current_tool_call_id
from ..amphi_store import (
    TurnStatus,
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

        self.thinking_modes: dict[str, tuple[str, ...]] = {}
        descriptors: dict[str, ThinkUnitDescriptor] = {}
        for stage in get_cognitive_stages():
            descriptor = getattr(AmphiAgent, stage.stage, None)
            if not isinstance(descriptor, ThinkUnitDescriptor):
                if hasattr(AmphiAgent, stage.stage) or (
                    hasattr(self, stage.stage) and not isinstance(getattr(self, stage.stage), ThinkUnitDescriptor)
                ):
                    raise ValueError(f"Cognitive stage {stage.stage!r} would overwrite an Agent attribute.")
                descriptors[stage.stage] = think_unit(stage.worker_class(), max_attempts=DEFAULT_MAX_ROUNDS)
            self.thinking_modes[stage.mode] = (*self.thinking_modes.get(stage.mode, ()), stage.stage)

        # The framework resolves ThinkUnits on the class; reuse existing declarations
        # so later instances preserve worker templates and explicit subclass overrides.
        for name, descriptor in descriptors.items():
            setattr(AmphiAgent, name, descriptor)


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
            WorkflowRunThink._publish_workflow_progress(ota_context, context, current_status, "running")

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
                    WorkflowRunThink._publish_workflow_progress(ota_context, context, next_status, "running")
                    if entering_workflow:
                        budget = max(
                            budget,
                            WorkflowRunThink._workflow_remaining_units(next_status, context) + 1,
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
        # Tool Legality Check
        ########################
        if current_ota_permission_status.reviewed:
            verdicts = self._reviewed_verdicts(current_ota_permission_status.verdicts)
        else:
            verdicts = [
                CallVerdict(id=call.call_id, tool=call.tool, arguments=self._tool_args(call), verdict=Permission.ALLOW.value)
                for call in calls
            ]
        verdicts = await self.legality_check(ota_context, context, calls, verdicts)

        ########################
        # Tool Permission Check
        ########################
        if not current_ota_permission_status.reviewed:
            legal_indices = [index for index, verdict in enumerate(verdicts) if verdict.verdict == Permission.ALLOW.value]
            if legal_indices:
                permission_verdicts = await self.permission_check(
                    ota_context,
                    context,
                    [calls[index] for index in legal_indices],
                    execution_mode=effective_execution_mode,
                )
                for index, verdict in zip(legal_indices, permission_verdicts):
                    verdicts[index] = verdict

        ota_context.ota_record[-1].permission = RoundPermission(
            execution_mode=effective_execution_mode,
            reviewed=current_ota_permission_status.reviewed,
            verdicts=verdicts,
            items=current_ota_permission_status.items,
        )

        ########################
        # Tool Permission Approval
        ########################
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

        ########################
        # Run Action Tool Call
        ########################
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

    async def _execute_tool_calls(self, ota_context: AmphiOTAContext, context: Optional[AmphiContext] = None) -> ActionResult:
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
        """Fold all-denied rounds and delegate results through the active cognitive worker.

        All-denied rounds skip action_tool_call, so fold their verdicts here too.
        Permission replay also enters here and uses the same worker delegation.
        """
        gate = self._get_current_ota_permission_status(ota_context)
        denied = [cv for cv in gate.verdicts if cv.verdict == Permission.DENY.value]
        if denied and ota_context.action_result is None and not isinstance(ota_context.interaction_status, AwaitingPermission):
            ota_context.action_result = ActionResult(results=[self._denied_step(cv) for cv in denied])

        successful_steps = [
            step for step in getattr(ota_context.action_result, "results", None) or []
            if step.success
        ]
        worker = self._current_think_worker(ota_context, context)
        try:
            await worker.handle_action_result(ota_context, context, self)
        finally:
            # Normalize successful empty outputs after handling, even if a handler raised.
            # Results rejected by a cognitive worker retain their failure payload.
            for step in successful_steps:
                if step.success and step.tool_result in (None, ""):
                    step.tool_result = EMPTY_SUCCESS_TOOL_RESULT

        if False:  # the framework's template validator requires async-gen shape
            yield

    async def init_state(self, ota_context: AmphiOTAContext, context: AmphiContext) -> None:
        """Restore execution data, initialize the selected Think, and replay approvals.

        Terminal Turns retain only durable cognitive progress for a new task.
        Awaiting Turns retain their execution history and original task while the
        selected Think interprets the incoming reply. Permission replay remains
        an engine operation and runs after the Think restores its resources.
        """
        detected = detect_locale(*self._recent_user_messages(ota_context, context))
        if detected is not None:
            activate_locale(detected)

        completing_subagents = isinstance(ota_context.user_input, SubAgentsCompleted)
        input_type = (ota_context.user_input.get("type") if isinstance(ota_context.user_input, dict) else getattr(ota_context.user_input, "type", None))
        is_child = context.session.is_child
        if is_child and self._has_slash_command(ota_context.user_input, "build"):
            ota_context.ota_record.append(OTARecord(
                observation_result=(
                    "[child capability] Build slash commands are available only in root "
                    "Sessions; continue this task in normal mode."
                ),
            ))

        turns = context.session.get_all()
        previous_turn = turns[-1] if turns else None
        if previous_turn is not None:
            previous_usage = ContextUsageSnapshot.model_validate(previous_turn.context_usage)
            if previous_turn.status.is_terminal:
                previous_usage = previous_usage.model_copy(update={"input_tokens": 0, "output_tokens": 0})
            ota_context.context_usage = previous_usage
            raw_compaction = (previous_turn.agent_state or {}).get("context_compaction")
            if raw_compaction:
                compaction = ContextCompactionState.model_validate(raw_compaction)
                if previous_turn.status.is_terminal:
                    compaction = compaction.model_copy(update={"turn": {}})
                ota_context.state.context_compaction = compaction

        awaiting = previous_turn is not None and not previous_turn.status.is_terminal
        if not awaiting:
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
            if input_type == "presentation_template_selection":
                raise RuntimeError("This Session has no pending presentation template selection.")

        dump = previous_turn.ota_context_dump() if previous_turn is not None else {}
        state = dump.get("state") or {}
        think = state.get("think") or {}
        interaction = state.get("interaction") or {}
        if awaiting:
            ota_context.browser_tool_loaded = bool(dump.get("browser_tool_loaded"))
            ota_context.workspace_tools_loaded = bool(dump.get("workspace_tools_loaded"))
            ota_context.skills_tool_loaded = bool(dump.get("skills_tool_loaded"))
            pending_state = AgentState.model_validate({
                "interaction": state.get("interaction"),
                "subagents": state.get("subagents"),
            })
            ota_context.transition_interaction(pending_state.interaction)
            ota_context.transition_subagents(pending_state.subagents)

        resumable = awaiting or (
            previous_turn is not None
            and previous_turn.status in {TurnStatus.COMPLETED, TurnStatus.CANCELLED, TurnStatus.FAILED}
        )
        if resumable and think.get("mode") in self.thinking_modes and not is_child:
            ota_context.transition_think(AgentState.model_validate({"think": think}).think)

        worker = self._current_think_worker(ota_context, context)
        await worker.init_state(ota_context, context, previous_turn, self)

        if awaiting and previous_turn.status is TurnStatus.AWAITING_PERMISSION:
            if not isinstance(interaction, dict) or "permission" not in interaction:
                raise RuntimeError("The pending permission Turn has no permission state.")
            if input_type != "permission_answer":
                raise RuntimeError("This Session is waiting for a permission answer.")
            rounds = dump.get("ota_record") or []
            if not rounds:
                raise RuntimeError("The pending permission Turn has no resumable trace.")
            await self._resume_permission(
                ota_context, context, interaction.get("permission") or {}, rounds,
                self._renderable_user_input(previous_turn.user_input),
            )

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

    async def _resume_permission(self, ota_context: AmphiOTAContext, context: AmphiContext, permission: Dict[str, Any], rounds: List[Any], original_user_input: Any) -> None:

        def _reviewed_call_verdict(call: StepToolCall, original: str, resolved: str, instruction: Optional[str] = None) -> CallVerdict:
            recorded = recorded_verdicts.get(call.call_id)
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
                    reason = (recorded.reason if recorded is not None else None) or "Denied by the tool-permission policy."
            if recorded is not None:
                return recorded.model_copy(update={"verdict": resolved, "reason": reason})
            return CallVerdict(
                id=call.call_id,
                tool=call.tool,
                arguments=self._tool_args(call),
                verdict=resolved,
                reason=reason,
            )

        ota_context.ota_record = [OTARecord.model_validate(r) for r in rounds]
        recorded_verdicts = {
            verdict.id: verdict
            for verdict in self._get_current_ota_permission_status(ota_context).verdicts
        }
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
                "presentation_template_candidates": [
                    candidate.model_dump(mode="json") for candidate in status.template_candidates
                ],
                "presentation_template_selection_id": status.template_selection_id,
                "presentation_template_selection_status": status.template_selection_status,
                "presentation_template_selection_error": status.template_selection_error,
                "presentation_selected_template": (
                    status.selected_template.model_dump(mode="json")
                    if status.selected_template is not None
                    else None
                ),
            })
        ota_context.stream.publish("stage", **payload)

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
        calls: List[StepToolCall],
        *,
        execution_mode: Optional[str] = None,
    ) -> List[CallVerdict]:
        """Evaluate system permissions for the tool calls admitted by legality checks.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active turn containing the proposed tool calls and current Think stage.
        context : AmphiContext
            Session workspace, execution mode, mounts, and safety classifier context.
        calls : List[StepToolCall]
            Tool calls that passed legality checks, in their original relative order.
        execution_mode : Optional[str]
            Effective mode already resolved for this round; omitted to resolve it here.

        Returns
        -------
        List[CallVerdict]
            Permission verdicts aligned one-to-one with the supplied tool calls.
        """
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
                source = WorkflowRunThink._workflow_source(ota_context.think_status, context)
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

    def _current_think_worker(self, ota_context: AmphiOTAContext, context: AmphiContext) -> BaseThink:
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
        """Check executable tools and registered routing, then delegate business policy."""
        visible_tools = {spec.tool_name for spec in ota_context.tools or []}
        think_status = ota_context.think_status

        def engine_reason(call: StepToolCall) -> Optional[str]:
            if call.tool not in visible_tools:
                return (
                    f"tool `{call.tool}` rejected: it is not available in this "
                    "Session's current ToolSurface."
                )
            if call.tool == "switch":
                arguments = self._tool_args(call)
                target_stage = arguments.get("stage")
                if think_status.mode != "normal" and not arguments.get("mode") and target_stage:
                    registered_stages = self.thinking_modes.get(think_status.mode)
                    unit = getattr(self, str(target_stage), None)
                    if registered_stages is None or target_stage not in registered_stages or unit is None:
                        return (
                            f"switch rejected: target stage `{target_stage}` is not registered "
                            f"for mode `{think_status.mode}`."
                        )
            return None

        resolved = list(verdicts)
        for index, (call, verdict) in enumerate(zip(calls, verdicts)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = engine_reason(call)
            if reason:
                resolved[index] = verdict.model_copy(update={"verdict": Permission.DENY.value, "reason": reason})

        worker = self._current_think_worker(ota_context, context)
        return await worker.legality_check(ota_context, context, calls, resolved)

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
            if not failed and step.tool_name == "ppt_rag":
                # Plan consumes the complete shortlist in handle_action_result and
                # replaces it with a compact template-selection receipt.
                continue
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
