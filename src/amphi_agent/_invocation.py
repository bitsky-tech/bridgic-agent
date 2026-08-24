from __future__ import annotations

import asyncio
import json
import logging
import os
from src.amphi_store._session_mount import SessionMountRecord
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Optional

from ._agent import AmphiAgent
from ._browser import BrowserHost
from ._context import AmphiContext, AmphiOTAContext
from ._error import PublicAgentError
from ._memory import Memory
from ._schedules import ScheduleLibrary
from ._session import Session
from ._skills import SkillLibrary
from ._workflows import WorkflowLibrary
from ._workflow_run import WorkflowRunLibrary
from ._state import (
    AgentResult,
    AwaitingBuildConfirm,
    AwaitingBuildConflict,
    AwaitingWorkflowRunChoice,
    AwaitingAcceptRule,
    AwaitingFeedback,
    AwaitingPermission,
    AwaitingTaskConfirm,
    AwaitingWorkflowConfirm,
    AwaitingSubAgent,
    BuildStageState,
    SubAgentCall,
    SubAgentResult,
    SubAgentsCompleted,
)
from ._workspace import AppEnvironmentStatus, Workspace
from ..amphi_service.protocol import (
    CancelledEvent,
    ErrorEvent,
    FinalEvent,
    SubAgentEvent,
    SessionCompletedEvent,
)
from ..amphi_service.protocol.llms._codex_credentials import CodexAuthError
from ..amphi_store import (
    SessionMountRepository,
    SessionKind,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
    SessionTurnRecord,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
    UserRepository,
)

if TYPE_CHECKING:
    from ._state import InteractionState
    from ..amphi_service.runtime._session_events import SessionEventBroker
    from ..amphi_service.runtime._system_events import SystemEventBroker

logger = logging.getLogger(__name__)

__all__ = [
    "AgentInvocation",
    "InvocationBusyError",
    "InvocationDisposition",
    "InvocationNotFoundError",
    "InvocationOutcome",
    "InvocationRunResult",
    "InvocationStaleAnswerError",
    "InvocationStateError",
    "InvocationTraceLimitError",
]

################################################################################################################
# Exceptions
################################################################################################################
class InvocationNotFoundError(LookupError):
    """Raised when an Agent Session is missing."""


class InvocationStateError(RuntimeError):
    """Raised when an Agent Session cannot make the requested transition."""


class InvocationBusyError(InvocationStateError):
    """Raised when this process already owns an active Session task."""


class InvocationStaleAnswerError(InvocationStateError):
    """Raised when an idempotent interaction answer has already gone stale."""


class InvocationTraceLimitError(RuntimeError):
    """Raised when a Turn checkpoint exceeds its persistence budget."""


class InvocationDisposition(str, Enum):
    """How one Agent execution attempt left its Session."""

    COMPLETED = "completed"
    AWAITING_SUBAGENTS = "awaiting_subagents"
    AWAITING_FEEDBACK = "awaiting_feedback"
    AWAITING_PERMISSION = "awaiting_permission"
    AWAITING_ACCEPT_RULE = "awaiting_accept_rule"
    AWAITING_TASK_CONFIRM = "awaiting_task_confirm"
    AWAITING_WORKFLOW_CONFIRM = "awaiting_workflow_confirm"
    AWAITING_BUILD_CONFIRM = "awaiting_build_confirm"


################################################################################################################
# Outcome
################################################################################################################
@dataclass(frozen=True)
class InvocationOutcome:
    """Terminal or parked result of one Agent execution attempt."""

    answer: str
    disposition: InvocationDisposition
    input_tokens: int
    output_tokens: int

    @property
    def parked(self) -> bool:
        return self.disposition is not InvocationDisposition.COMPLETED

    @property
    def tokens_spent(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True)
class InvocationRunResult:
    """One Session-scoped Agent attempt and its durable identities."""

    session_id: str
    turn_id: str
    outcome: InvocationOutcome
    interaction: Optional["InteractionState"] = None
    title: Optional[str] = None
    duration_ms: int = 0
    completed_at: Optional[str] = None


@dataclass
class _RootChildPool:
    """One root Session's execution slots and live lease references."""

    slots: asyncio.Semaphore
    leases: int = 0


class _RootChildPoolRegistry:
    """Manage an independent Child execution semaphore for each root Session.

    Parameters
    ----------
    limit : int
        Maximum simultaneously executing Child attempts for one root Session.
    """

    def __init__(self, limit: int) -> None:
        if limit <= 0:
            raise ValueError("Child concurrency limit must be positive")
        self._limit = limit
        self._pools: dict[str, _RootChildPool] = {}
        self._lock = asyncio.Lock()

    @asynccontextmanager
    async def lease(self, root_session_id: str) -> AsyncIterator[None]:
        """Wait for and hold one execution slot owned by ``root_session_id``."""
        async with self._lock:
            pool = self._pools.get(root_session_id)
            if pool is None:
                pool = _RootChildPool(asyncio.Semaphore(self._limit))
                self._pools[root_session_id] = pool
            pool.leases += 1

        acquired = False
        try:
            await pool.slots.acquire()
            acquired = True
            yield
        finally:
            if acquired:
                pool.slots.release()
            async with self._lock:
                pool.leases -= 1
                if pool.leases == 0 and self._pools.get(root_session_id) is pool:
                    self._pools.pop(root_session_id, None)


################################################################################################################
# Agent Run
################################################################################################################
class AgentInvocation:
    """Create, restore, run, and persist Session-scoped Agent attempts.

    Parameters
    ----------
    llms : Any
        Process-wide model cache used to resolve the Session owner's model.
    session_events : SessionEventBroker
        Process-wide live-event broker for Session attempts.
    system_events : SystemEventBroker
        Process-wide broker for Child lifecycle and Session notifications.
    history_renderer : Optional[Callable[[list[SessionTurnRecord]], str]]
        Renderer for the root Session's workspace ``history.md`` projection.
    session_repository, turn_repository, mount_repository : Optional
        Injectable persistence dependencies used by focused tests.
    browser_host : BrowserHost, optional
        App-owned browser host. A private host is created only for standalone
        Invocation use and is closed by :meth:`shutdown`.
    max_concurrent_children : int
        Per-root Session limit for simultaneously executing Child Agent attempts.
    """

    MAX_OTA_CONTEXT_BYTES = 2 * 1024 * 1024
    MAX_CONCURRENT_CHILDREN = 10
    INTERACTION_ANSWER_TYPES = frozenset({
        "build_confirm",
        "accept_rule",
        "permission_answer",
        "task_confirm",
        "workflow_confirm",
        "choice_answer",
    })

    def __init__(
        self,
        llms: Any,
        session_events: "SessionEventBroker",
        system_events: "SystemEventBroker",
        *,
        history_renderer: Optional[Callable[[list[SessionTurnRecord]], str]] = None,
        session_repository: Optional[SessionRepository] = None,
        turn_repository: Optional[SessionTurnRepository] = None,
        mount_repository: Optional[SessionMountRepository] = None,
        browser_host: Optional[BrowserHost] = None,
        max_concurrent_children: int = MAX_CONCURRENT_CHILDREN,
    ) -> None:
        # Agent invocation task management
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._tasks_lock = asyncio.Lock()
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._child_pools = _RootChildPoolRegistry(max_concurrent_children)
        self._cancelling_sessions: dict[str, int] = {}

        # Agent invocation context dependencies
        self._llms = llms
        self._sessions = session_repository or SessionRepository()
        self._turns = turn_repository or SessionTurnRepository()
        self._mounts = mount_repository or SessionMountRepository()
        self._owns_browser_host = browser_host is None
        self._browser_host = browser_host or BrowserHost()
        self._session_events = session_events
        self._system_events = system_events
        self._history_renderer = history_renderer
        # Late-bound scheduler ``kill`` so schedule-deleting tools can cancel an
        # in-flight run. Only the callable is held (not the SchedulerService)
        # to keep amphi_agent free of a service import cycle. See
        # ``bind_schedule_killer``.
        self._schedule_killer: Optional[Callable[[str], Any]] = None

    async def prepare(self) -> None:
        """Prepare process-wide Agent resources before accepting Invocations."""
        await Workspace.prepare_environment()

    @staticmethod
    def environment_status() -> AppEnvironmentStatus:
        """Return the readiness of the resources :meth:`prepare` builds.

        The daemon now answers requests before preparation finishes, so both
        the gateway status payload and any Agent command that cannot run yet
        read their answer from here.
        """
        return Workspace.environment_status()

    @staticmethod
    def _error_message(exc: BaseException) -> str:
        """Return only the protocol-compatible display text for a failure."""
        return PublicAgentError.from_exception(exc).message

    ############################################################################
    # Invoke Agent
    ############################################################################
    async def arun(
        self, session_id: str, user_input: Any, *, execution_mode: Optional[str] = None,
    ) -> asyncio.Task[InvocationRunResult]:
        """Create and return a managed Agent task for one Session.

        Parameters
        ----------
        session_id : str
            Target root or Child Session to run or resume.
        user_input : Any
            Opening request or interaction answer for this attempt.
        execution_mode : Optional[str]
            Override the owner's execution mode for this attempt (e.g. ``'full'``
            for scheduler-fired runs). A resumed nonterminal Child Turn reuses its
            persisted mode; other ``None`` values use ``user.execution_mode``.

        Returns
        -------
        asyncio.Task[InvocationRunResult]
            Managed task that callers may await when they need the final result.

        Raises
        ------
        InvocationNotFoundError
            If ``session_id`` does not identify a durable Session.
        InvocationStateError
            If this process already owns an active task for the Session.
        """
        record = await self._sessions.load_by_id(session_id)
        if record is None:
            raise InvocationNotFoundError(session_id)
        task = await self._schedule(record, user_input, execution_mode=execution_mode)

        def consume_result(completed: asyncio.Task[Any]) -> None:
            if not completed.cancelled():
                completed.exception()
        task.add_done_callback(consume_result)

        return task

    async def arun_subagent(
        self,
        parent_session_id: str,
        user_input: Any,
        parent_call_id: Optional[str] = None,
        execution_mode: Optional[str] = None,
    ) -> asyncio.Task[InvocationRunResult]:
        """Create a Child Session and run it through the normal invocation path.

        Parameters
        ----------
        parent_session_id : str
            Session whose execution context launched the Child Agent.
        user_input : Any
            Opening request for the Child Agent.
        parent_call_id : Optional[str]
            Tool call that launched the Child Agent, when one exists.
        execution_mode : Optional[str]
            Effective mode inherited through the calling Bash environment.

        Returns
        -------
        asyncio.Task[InvocationRunResult]
            Managed Child Agent task. Its result carries the new Child Session id.

        Raises
        ------
        InvocationNotFoundError
            If the parent Session does not exist.
        """
        parent = await self._sessions.load_by_id(parent_session_id)
        if parent is None:
            raise InvocationNotFoundError(parent_session_id)
        self._require_root_subagent_parent(parent)
        goal = UserInput.from_runtime(user_input).text
        child = await self._sessions.create_child(
            parent.user_id,
            parent_session_id=parent.id,
            parent_call_id=parent_call_id,
            subagent_mode=SubAgentMode.RPC,
            title=goal or None,
        )
        try:
            return await self.arun(child.id, user_input, execution_mode=execution_mode)
        except BaseException as exc:
            self._spawn_background(self._settle_subagent(child, user_input, error=exc))
            raise

    async def _schedule(
        self, record: SessionRecord, user_input: Any, *, execution_mode: Optional[str] = None,
    ) -> asyncio.Task[InvocationRunResult]:
        """Create and register the sole active Agent task for a Session.

        Parameters
        ----------
        record : SessionRecord
            Durable Session whose id is used as the process-level serial gate.
        user_input : Any
            New request or structured interaction response for the Agent.
        Returns
        -------
        asyncio.Task[InvocationRunResult]
            Task owned and released by this AgentInvocation instance.

        Raises
        ------
        InvocationStateError
            If another task is already active or the input cannot resume the
            Session's durable tail.
        InvocationStaleAnswerError
            If a structured interaction answer no longer matches a parked request.
        """
        async def execute() -> InvocationRunResult:
            publisher = self._session_events.open(record.id)
            try:
                if record.parent_session_id is None:
                    result = await self._execute(
                        record, user_input, publisher, execution_mode=execution_mode,
                    )
                else:
                    root = await self._sessions.root(record.id, record.user_id)
                    if root is None:
                        raise InvocationStateError(
                            f"Session {record.id!r} has an invalid parent chain"
                        )
                    async with self._child_pools.lease(root.id):
                        self._publish_subagent_event(
                            record.parent_session_id,
                            record.id,
                            record.parent_call_id,
                            record.subagent_mode or SubAgentMode.BLOCKING,
                            phase="status",
                            goal="",
                            status="running",
                        )
                        result = await self._execute(
                            record, user_input, publisher, execution_mode=execution_mode,
                        )
            except asyncio.CancelledError:
                publisher.finish(CancelledEvent())
                raise
            except CodexAuthError as exc:
                publisher.finish(ErrorEvent(message=self._error_message(exc)))
                if record.parent_session_id is None:
                    self._system_events.publish_nowait(SessionCompletedEvent(session_id=record.id))
                raise
            except Exception as exc:
                error_message = self._error_message(exc)
                logger.exception("Agent invocation failed for Session %s", record.id)
                publisher.finish(ErrorEvent(message=error_message))
                if record.parent_session_id is None:
                    self._system_events.publish_nowait(SessionCompletedEvent(session_id=record.id))
                raise

            outcome = result.outcome
            if result.title is not None:
                publisher.publish("title", title=result.title)
            self._publish_interaction(publisher, result.interaction)
            if outcome.disposition is InvocationDisposition.AWAITING_SUBAGENTS:
                # Blocking Children park this logical Turn; the resumed parent sends its only Final.
                publisher.finish()
            else:
                publisher.finish(
                    FinalEvent(
                        answer=outcome.answer,
                        tokens_spent=outcome.tokens_spent,
                        input_tokens=outcome.input_tokens,
                        output_tokens=outcome.output_tokens,
                        duration_ms=result.duration_ms,
                        completed_at=result.completed_at,
                    ),
                )
            if (
                record.parent_session_id is None
                and outcome.disposition is not InvocationDisposition.AWAITING_SUBAGENTS
            ):
                self._system_events.publish_nowait(SessionCompletedEvent(session_id=record.id))
            return result
            
        async with self._tasks_lock:
            existing = self._tasks.get(record.id)
            if existing is not None and not existing.done():
                if self._input_type(user_input) in self.INTERACTION_ANSWER_TYPES:
                    raise InvocationStaleAnswerError(
                        f"Interaction answer for Session {record.id!r} is stale",
                    )
                raise InvocationBusyError(f"A turn is already running for Session {record.id!r}")

            latest = await self._turns.latest(record.id, record.user_id)
            accepted_interaction = self._accept_input(latest, user_input)
            if accepted_interaction:
                handled = await self._sessions.mark_interaction_handled(record.id, record.user_id)
                if not handled:
                    raise InvocationNotFoundError(record.id)
                record = record.model_copy(update={"status": SessionStatus.FINISH})

            task = asyncio.create_task(
                execute(),
                name=f"agent-invocation:{record.id}",
            )
            self._tasks[record.id] = task

            def release(completed: asyncio.Task[Any]) -> None:
                if self._tasks.get(record.id) is completed:
                    self._tasks.pop(record.id, None)

            task.add_done_callback(release)
            if record.parent_session_id is not None:
                task.add_done_callback(
                    lambda completed: self._spawn_background(
                        self._settle_subagent(record, user_input, completed),
                    ),
                )
                self._publish_subagent_event(
                    record.parent_session_id,
                    record.id,
                    record.parent_call_id,
                    record.subagent_mode or SubAgentMode.BLOCKING,
                    phase="started" if latest is None else "status",
                    goal=record.title or "",
                    status="queued",
                )
            return task

    @staticmethod
    def _input_type(user_input: Any) -> Optional[str]:
        """Return the structured input discriminator, when one exists."""
        value = (
            user_input.get("type")
            if isinstance(user_input, dict)
            else getattr(user_input, "type", None)
        )
        return str(value) if value is not None else None

    @staticmethod
    def _input_field(user_input: Any, name: str) -> Any:
        """Read one field from a dict or typed runtime input."""
        return (
            user_input.get(name)
            if isinstance(user_input, dict)
            else getattr(user_input, name, None)
        )

    @classmethod
    def _accept_input(cls, latest: Optional[SessionTurnRecord], user_input: Any) -> bool:
        """Validate an input against the durable Session tail.

        Parameters
        ----------
        latest : SessionTurnRecord, optional
            Latest persisted Turn for the Session.
        user_input : Any
            New chat input, control answer, or internal Child completion.

        Returns
        -------
        bool
            ``True`` only when this input consumes a user interaction. The
            caller clears the Session's transient awaiting projection before
            starting the accepted continuation.

        Raises
        ------
        InvocationStateError
            If the input cannot legally resume the durable tail.
        InvocationStaleAnswerError
            If a structured answer has no matching parked interaction.
        """
        input_type = cls._input_type(user_input)
        structured_answer = input_type in cls.INTERACTION_ANSWER_TYPES
        interaction = (
            (latest.agent_state or {}).get("interaction") or {}
            if latest is not None
            else {}
        )
        interaction = interaction if isinstance(interaction, dict) else {}

        if latest is None or latest.status.is_terminal:
            if structured_answer:
                raise InvocationStaleAnswerError("This Session has no matching pending interaction")
            if isinstance(user_input, SubAgentsCompleted):
                raise InvocationStateError("This Session has no pending Child Agent state to resume")
            return False

        if latest.status is TurnStatus.AWAITING_SUBAGENTS:
            if isinstance(user_input, SubAgentsCompleted):
                return False
            if structured_answer:
                raise InvocationStaleAnswerError("This Session has no matching pending interaction")
            raise InvocationStateError(
                "Child Agents are still running; wait for them to finish before sending another message",
            )

        if latest.status is TurnStatus.AWAITING_PERMISSION:
            expected_id = interaction.get("request_id") if "permission" in interaction else None
            request_id = cls._input_field(user_input, "request_id")
            if input_type == "permission_answer" and expected_id and request_id == expected_id:
                return True
            if structured_answer:
                raise InvocationStaleAnswerError("This interaction answer does not match the pending request")
            raise InvocationStateError(
                "A permission request is pending; answer it before sending other messages",
            )

        if latest.status is not TurnStatus.AWAITING_HUMAN:
            raise InvocationStateError(
                f"Session {latest.session_id!r} has unsupported Turn status {latest.status.value!r}",
            )

        expected_type: Optional[str] = None
        expected_id: Optional[str] = None
        if interaction.get("build_confirm") is True:
            expected_type = "build_confirm"
            expected_id = interaction.get("request_id")
        elif "task_confirm" in interaction:
            expected_type = "task_confirm"
            pending = interaction.get("task_confirm")
            expected_id = pending.get("request_id") if isinstance(pending, dict) else None
        elif "accept_rule" in interaction:
            expected_type = "accept_rule"
            pending = interaction.get("accept_rule")
            expected_id = pending.get("request_id") if isinstance(pending, dict) else None
        elif "workflow_confirm" in interaction:
            expected_type = "workflow_confirm"
            pending = interaction.get("workflow_confirm")
            expected_id = pending.get("request_id") if isinstance(pending, dict) else None

        if expected_type is not None:
            request_id = cls._input_field(user_input, "request_id")
            if input_type == expected_type and expected_id and request_id == expected_id:
                return True
            if input_type in {None, "chat"}:
                return True
            if structured_answer:
                raise InvocationStaleAnswerError(
                    f"This {input_type.replace('_', ' ')} does not match the pending request",
                )
            raise InvocationStateError(
                f"This {expected_type.replace('_', ' ')} does not match the pending request",
            )

        if (
            interaction.get("build_conflict") is True
            or interaction.get("workflow_run_choice") is True
            or "questions" in interaction
        ):
            expected_id = interaction.get("request_id")
            request_id = cls._input_field(user_input, "request_id")
            if input_type == "choice_answer" and expected_id and request_id == expected_id:
                return True
            if input_type in {None, "chat"}:
                return True
            if structured_answer:
                raise InvocationStaleAnswerError("This Session has no matching pending interaction")
            raise InvocationStateError("This Session is waiting for a human choice")

        raise InvocationStateError("The pending human Turn has no matchable interaction state")

    async def _execute(
        self, record: SessionRecord, user_input: Any, stream: Any, *, execution_mode: Optional[str] = None,
    ) -> InvocationRunResult:
        """Hydrate a Session, execute one Agent turn, and project its result.

        Parameters
        ----------
        record : SessionRecord
            Durable Session container to hydrate.
        user_input : Any
            New request or structured interaction response for the Agent.
        stream : Any
            Live event publisher attached to the OTA context.

        Returns
        -------
        InvocationRunResult
            Freshly persisted Turn result and normalized Agent outcome.
        """
        user = await UserRepository().load(record.user_id)
        if user is None:
            raise InvocationNotFoundError(record.user_id)

        previous_turns = await self._turns.list_conversation(user.id, record.id)
        model = user.current_model
        # Explicit attempt mode wins. A parked Child retains its delegated mode;
        # other attempts use the owner's current configured mode.
        if (
            execution_mode is None
            and record.parent_session_id is not None
            and previous_turns
            and not previous_turns[-1].status.is_terminal
        ):
            execution_mode = previous_turns[-1].execution_mode
        execution_mode = execution_mode or user.execution_mode
        max_rounds = user.default_max_rounds
        ota_context = AmphiOTAContext(user_input=user_input, stream=stream)
        title_task: Optional[asyncio.Task[Optional[str]]] = None
        prepared_children: list[tuple[SessionRecord, SubAgentCall]] = []
        workflows: Optional[WorkflowLibrary] = None
        attempt_started_at = time.perf_counter()

        def elapsed_ms() -> int:
            return max(0, int((time.perf_counter() - attempt_started_at) * 1000))

        async def failure_projection(default: SessionStatus) -> SessionStatus:
            latest = await self._turns.latest(record.id, record.user_id)
            before_tail_id = previous_turns[-1].id if previous_turns else None
            if (
                record.status is SessionStatus.AWAITING
                and (latest.id if latest is not None else None) == before_tail_id
            ):
                return SessionStatus.AWAITING
            return default

        async def discard_prepared_children() -> None:
            if not prepared_children:
                return
            await asyncio.shield(asyncio.gather(*(
                self._sessions.delete(child.id, user.id)
                for child, _call in reversed(prepared_children)
            ), return_exceptions=True))
            prepared_children.clear()

        async def load_mounts():
            session_ids = [root.id]
            if record.id != root.id:
                session_ids.append(record.id)
            groups = await asyncio.gather(*(
                self._mounts.list_for_session(session_id, user.id)
                for session_id in session_ids
            ))
            return list[SessionMountRecord]({
                mount.id: mount
                for group in groups
                for mount in group
            }.values())

        # Run the entire session logic
        try:
            # If current session is child session, find the top parent
            root = await self._sessions.root(record.id, user.id)
            if root is None:
                raise InvocationStateError(f"Session {record.id!r} has an invalid parent chain")

            # Init the agent LLM + Context
            llm = await self._llms.resolve(user, model)
            workflows = WorkflowLibrary(user.id)
            workflow_runs = WorkflowRunLibrary(user.id)
            skills, workflows, workflow_runs, schedules, mounts = await asyncio.gather(
                SkillLibrary(user.id).load(),
                workflows.load(),
                workflow_runs.load(
                    user_input,
                    *(turn.user_input for turn in previous_turns),
                ),
                ScheduleLibrary(user.id, mutable=root.kind is not SessionKind.SCHEDULED).load(),
                load_mounts(),
            )
            referenced_runs = workflow_runs.referenced_runs(user_input)
            referenced_workflow_ids = tuple(dict.fromkeys(
                run.workflow_id for run in referenced_runs
            ))
            await asyncio.gather(
                workflows.associate_session_input(root.id, user_input),
                *(workflows.associate_session(root.id, workflow_id)
                  for workflow_id in referenced_workflow_ids),
                *(workflow_runs.associate_session(root.id, run.run_id)
                  for run in referenced_runs),
            )
            workspace = Workspace(root.id, session_root=Path(root.workspace_root), mounts=mounts)
            await workspace.prepare_workspace()
            context = AmphiContext(
                session=Session(record, turns=previous_turns),
                memory=Memory(user.id),
                schedules=schedules,
                skills=skills,
                workflows=workflows,
                workflow_runs=workflow_runs,
                workspace=workspace,
                browser=self._browser_host.for_session(
                    record.id,
                    tool_result_dir=workspace.tool_result_dir,
                ),
                invocations=self,
                execution_mode=execution_mode,
            )
            agent = AmphiAgent(max_rounds=max_rounds, verbose=False)

            # Run the agent turn logic
            try:
                agent_result = await agent.arun(llm=llm, context=context, ota_context=ota_context)
                if record.parent_session_id is None:
                    title_task = asyncio.create_task(agent.generate_session_title(llm=llm, context=context, ota_context=ota_context))
                if isinstance(agent_result, AwaitingSubAgent):
                    prepared_children = await self._prepare_subagents(record, agent_result.calls, SubAgentMode.BLOCKING)
                outcome = self._outcome(agent_result, ota_context)
            except asyncio.CancelledError:
                try:
                    await asyncio.shield(
                        self._persist_turn_result(
                            user.id,
                            record,
                            previous_turns,
                            context,
                            ota_context,
                            error="Agent execution cancelled",
                            status=TurnStatus.CANCELLED,
                            model=model,
                            execution_mode=execution_mode,
                            max_rounds=max_rounds,
                            duration_ms=elapsed_ms(),
                        ),
                    )
                finally:
                    await discard_prepared_children()
                raise
            except Exception as exc:
                error_message = self._error_message(exc)
                try:
                    await self._persist_turn_result(
                        user.id,
                        record,
                        previous_turns,
                        context,
                        ota_context,
                        error=error_message,
                        model=model,
                        execution_mode=execution_mode,
                        max_rounds=max_rounds,
                        duration_ms=elapsed_ms(),
                    )
                finally:
                    await discard_prepared_children()
                raise
            else:
                try:
                    turn = await self._persist_turn_result(
                        user.id,
                        record,
                        previous_turns,
                        context,
                        ota_context,
                        outcome=outcome,
                        model=model,
                        execution_mode=execution_mode,
                        max_rounds=max_rounds,
                        duration_ms=elapsed_ms(),
                    )
                except BaseException:
                    await discard_prepared_children()
                    raise
        
        except asyncio.CancelledError:
            if title_task is not None:
                title_task.cancel()
                await asyncio.gather(title_task, return_exceptions=True)
            status = await failure_projection(SessionStatus.FINISH)
            await self._update_projection(
                record,
                status,
                model,
                record.last_answer if status is SessionStatus.AWAITING else "",
            )
            raise
        except Exception:
            if title_task is not None:
                title_task.cancel()
                await asyncio.gather(title_task, return_exceptions=True)
            status = await failure_projection(SessionStatus.COMPLETED)
            await self._update_projection(
                record,
                status,
                model,
                record.last_answer if status is SessionStatus.AWAITING else "",
            )
            raise

        if outcome.disposition is InvocationDisposition.AWAITING_SUBAGENTS:
            session_status = SessionStatus.FINISH
        elif outcome.parked:
            session_status = SessionStatus.AWAITING
        else:
            session_status = SessionStatus.COMPLETED
        await self._update_projection(record, session_status, model, outcome.answer)
        if record.parent_session_id is None:
            await self._checkpoint_workspace(workspace, user_input, outcome.answer)
        if prepared_children:
            await self._schedule_subagents(record, prepared_children)
        
        if title_task is not None:
            self._spawn_background(
                self._emit_title_when_ready(title_task, record.id, user.id, record.title)
            )
        return InvocationRunResult(
            session_id=record.id,
            turn_id=turn.id,
            outcome=outcome,
            interaction=ota_context.interaction_status,
            title=None,
            duration_ms=turn.duration_ms or 0,
            completed_at=turn.created_at.isoformat(),
        )

    ############################################################################
    # Agent Runtime Data And Checkpoint
    ############################################################################
    async def _persist_turn_result(
        self,
        user_id: str,
        session: SessionRecord,
        before_turns: list[SessionTurnRecord],
        context: AmphiContext,
        ota_context: AmphiOTAContext,
        *,
        outcome: Optional[InvocationOutcome] = None,
        error: Optional[str] = None,
        status: Optional[TurnStatus] = None,
        model: Optional[str] = None,
        execution_mode: Optional[str] = None,
        max_rounds: Optional[int] = None,
        duration_ms: int = 0,
    ) -> SessionTurnRecord:
        """Append or replace one Turn from the Agent's final Session view.

        Parameters
        ----------
        user_id : str
            Session owner authorizing the write.
        session : SessionRecord
            Durable Session receiving the result.
        before_turns : list[SessionTurnRecord]
            Conversation loaded before the Agent ran.
        context : AmphiContext
            Agent context whose Session may have consumed its trailing Turn.
        ota_context : AmphiOTAContext
            Final Agent trace and state to persist.
        outcome : Optional[InvocationOutcome]
            Normal or parked Agent result.
        error : Optional[str]
            Agent failure persisted when no outcome exists.
        status : Optional[TurnStatus]
            Explicit persistence status for cancellation; otherwise derived.

        Returns
        -------
        SessionTurnRecord
            Newly inserted result row.
        """
        if (outcome is None) == (error is None):
            raise ValueError("exactly one of outcome or error is required")

        before_ids = [turn.id for turn in before_turns]
        remaining_turns = context.session.get_all()
        remaining_ids = [turn.id for turn in remaining_turns]
        replaced: Optional[SessionTurnRecord] = None
        if remaining_ids == before_ids:
            replace_tail = False
        elif before_turns and remaining_ids == before_ids[:-1]:
            replace_tail = True
            replaced = before_turns[-1]
        else:
            raise InvocationStateError(
                "Agent changed Session history beyond appending or consuming its tail",
            )

        trace_error: Optional[InvocationTraceLimitError] = None
        try:
            checkpoint = self._ota_context_values(ota_context)
        except InvocationTraceLimitError as exc:
            checkpoint = self._minimal_recovery_checkpoint(ota_context)
            if outcome is not None:
                outcome = None
                error = self._error_message(exc)
                trace_error = exc

        input_tokens = (
            outcome.input_tokens if outcome is not None else ota_context.input_tokens
        )
        output_tokens = (
            outcome.output_tokens if outcome is not None else ota_context.output_tokens
        )
        if replaced is not None:
            input_tokens += replaced.input_tokens
            output_tokens += replaced.output_tokens
            duration_ms += replaced.duration_ms or 0

        if status is None:
            if error is not None:
                status = TurnStatus.FAILED
            else:
                assert outcome is not None
                status = self._status_for(outcome)
        values = {
            "session_id": session.id,
            "expected_tail_id": before_turns[-1].id if before_turns else None,
            "user_input": UserInput.from_runtime(ota_context.user_input),
            "status": status,
            "final_answer": (
                outcome.answer
                if outcome is not None and status is TurnStatus.COMPLETED
                else None
            ),
            "error": error,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "model": model,
            "execution_mode": execution_mode,
            "max_rounds": max_rounds,
            "duration_ms": duration_ms,
            **checkpoint,
        }
        if replace_tail:
            turn = await self._turns.replace_tail_result(user_id, **values)
        else:
            turn = await self._turns.append_result(user_id, **values)
        if trace_error is not None:
            raise trace_error
        return turn

    async def _update_projection(self, record: SessionRecord, status: SessionStatus, model: Optional[str], last_answer: Optional[str]) -> None:
        try:
            await self._sessions.update_turn_projection(
                record.id,
                record.user_id,
                status=status,
                model=model,
                last_answer=last_answer,
            )
            if record.parent_session_id is not None or self._history_renderer is None:
                return
            turns = await self._turns.list_conversation(record.user_id, record.id)

            def write_history() -> None:
                target = Path(record.workspace_root) / "history.md"
                temporary = target.with_name("history.md.tmp")
                temporary.write_text(self._history_renderer(turns), encoding="utf-8")
                os.replace(temporary, target)

            await asyncio.to_thread(write_history)
        except Exception:  # noqa: BLE001 - Turn persistence remains authoritative
            return

    async def _checkpoint_workspace(self, workspace: Workspace, user_input: Any, answer: str) -> None:
        def message() -> str:
            lines = (answer or "").strip().splitlines()
            if lines and lines[0]:
                return f"Agent turn: {lines[0][:120]}"
            text = getattr(user_input, "input", "") or str(user_input or "")
            first = text.strip().splitlines()[0] if text.strip() else "workspace changes"
            return f"Agent turn: {first[:120]}"

        try:
            await asyncio.to_thread(workspace.checkpoints.checkpoint, message())
        except Exception:  # noqa: BLE001 - checkpoint metadata cannot fail a turn
            return

    ############################################################################
    # Sub Agent Management
    ############################################################################
    async def start_subagent(self, parent_session_id: str, call: SubAgentCall) -> str:
        """Create and schedule one background Child Session.

        Parameters
        ----------
        parent_session_id : str
            Running Session that issued the background delegation.
        call : SubAgentCall
            Complete background call with its preallocated Child Session id.

        Returns
        -------
        str
            Durable Child Session id. The parent does not wait for its result.
        """
        parent = await self._sessions.load_by_id(parent_session_id)
        if parent is None:
            raise InvocationNotFoundError(parent_session_id)
        self._require_root_subagent_parent(parent)
        children = await self._prepare_subagents(parent, [call], SubAgentMode.BACKGROUND)
        await self._schedule_subagents(parent, children)
        return call.session_id

    async def _prepare_subagents(self, parent: SessionRecord, calls: list[SubAgentCall], mode: SubAgentMode) -> list[tuple[SessionRecord, SubAgentCall]]:
        """Create the Child Sessions represented by one Agent dispatch.

        Parameters
        ----------
        parent : SessionRecord
            Running parent Session that issued the tool calls.
        calls : list[SubAgentCall]
            Child goals with preallocated Session and parent tool call ids.
        mode : SubAgentMode
            Runtime relationship shared by the prepared children.

        Returns
        -------
        list[tuple[SessionRecord, SubAgentCall]]
            Created Child Sessions paired with their original calls.
        """
        self._require_root_subagent_parent(parent)
        children: list[tuple[SessionRecord, SubAgentCall]] = []
        try:
            for call in calls:
                record = await self._sessions.create_child(
                    parent.user_id,
                    parent_session_id=parent.id,
                    parent_call_id=call.tool_call_id,
                    subagent_mode=mode,
                    session_id=call.session_id,
                    title=call.goal,
                )
                children.append((record, call))
        except BaseException:
            await asyncio.shield(asyncio.gather(*(
                self._sessions.delete(child.id, parent.user_id)
                for child, _call in reversed(children)
            ), return_exceptions=True))
            raise
        return children

    @staticmethod
    def _require_root_subagent_parent(parent: SessionRecord) -> None:
        """Reject nested delegation at the Child Session creation boundary."""
        if parent.parent_session_id is not None:
            raise InvocationStateError(
                "Child Sessions cannot create sub-agents; delegation is available only "
                "from a root Session.",
            )

    async def _schedule_subagents(self, parent: SessionRecord, children: list[tuple[SessionRecord, SubAgentCall]]) -> None:
        """Schedule Child Sessions through the normal ``arun`` path."""
        for child, call in children:
            try:
                await self.arun(
                    child.id,
                    call.goal,
                    execution_mode=call.execution_mode,
                )
            except Exception as exc:  # noqa: BLE001 - one failed launch must not block siblings
                self._spawn_background(self._settle_subagent(child, call.goal, error=exc))

    async def _settle_subagent(self, child: SessionRecord, user_input: Any, task: Optional[asyncio.Task[InvocationRunResult]] = None, error: Optional[BaseException] = None) -> None:
        """Persist an unrecorded failure, publish status, and try the parent join."""
        if task is not None:
            if task.cancelled():
                error = asyncio.CancelledError("Agent execution cancelled")
            elif task.exception() is not None:
                error = task.exception()

        turn = await self._turns.latest(child.id, child.user_id)
        if turn is None and error is not None:
            status = TurnStatus.CANCELLED if isinstance(error, asyncio.CancelledError) else TurnStatus.FAILED
            message = "Agent execution cancelled" if status is TurnStatus.CANCELLED else self._error_message(error)
            try:
                turn = await self._turns.append_result(
                    child.user_id,
                    session_id=child.id,
                    expected_tail_id=None,
                    user_input=self._turn_input(user_input),
                    ota_records=[],
                    agent_state={},
                    browser_tool_loaded=False,
                    workspace_tools_loaded=False,
                    skills_tool_loaded=False,
                    status=status,
                    final_answer=None,
                    error=message,
                    input_tokens=0,
                    output_tokens=0,
                )
                await self._update_projection(
                    child,
                    SessionStatus.COMPLETED,
                    child.last_used_model,
                    "",
                )
            except Exception:  # noqa: BLE001 - another writer may have settled it
                turn = await self._turns.latest(child.id, child.user_id)

        turns = await self._turns.list_conversation(child.user_id, child.id)
        goal = turns[0].user_input.text if turns else self._turn_input(user_input).text
        if child.parent_session_id is not None:
            self._publish_subagent_event(
                child.parent_session_id,
                child.id,
                child.parent_call_id,
                child.subagent_mode or SubAgentMode.BLOCKING,
                phase="status",
                goal=goal,
                status=turn.status if turn is not None else "failed",
                turn=turn,
            )
            parent = await self._sessions.load_by_id(child.parent_session_id)
            if parent is not None:
                await self._join_subagents(parent)

    async def _join_subagents(self, parent: SessionRecord) -> None:
        """Resume a parent when its currently persisted Child batch is terminal."""
        if self._cancelling_sessions.get(parent.id, 0):
            return

        def waiting_state(turn: Optional[SessionTurnRecord]) -> Optional[AwaitingSubAgent]:
            if turn is None or turn.status is not TurnStatus.AWAITING_SUBAGENTS:
                return None
            state = turn.agent_state or {}
            raw = state.get("subagents") if isinstance(state, dict) else None
            if not isinstance(raw, dict):
                return None
            try:
                waiting = AwaitingSubAgent.model_validate(raw)
            except Exception:  # noqa: BLE001 - malformed checkpoints stay inspectable
                return None
            call_ids = [call.tool_call_id for call in waiting.calls]
            session_ids = [call.session_id for call in waiting.calls]
            if len(call_ids) != len(set(call_ids)) or len(session_ids) != len(set(session_ids)):
                return None
            return waiting

        async def terminal_results(waiting: AwaitingSubAgent) -> Optional[list[SubAgentResult]]:
            turns = await asyncio.gather(*(
                self._turns.latest(call.session_id, parent.user_id)
                for call in waiting.calls
            ))
            if any(turn is None or not turn.status.is_terminal for turn in turns):
                return None
            return [
                SubAgentResult(
                    tool_call_id=call.tool_call_id,
                    status=turn.status.value,
                    answer=(
                        turn.final_answer or "(child completed with no answer)"
                        if turn.status is TurnStatus.COMPLETED
                        else None
                    ),
                    error=turn.error,
                )
                for call, turn in zip(waiting.calls, turns)
                if turn is not None
            ]

        parked = await self._turns.latest(parent.id, parent.user_id)
        waiting = waiting_state(parked)
        if waiting is None:
            return
        results = await terminal_results(waiting)
        if results is None:
            return

        async with self._tasks_lock:
            parent_task = self._tasks.get(parent.id)
        if parent_task is not None and parent_task is not asyncio.current_task() and not parent_task.done():
            await asyncio.gather(asyncio.shield(parent_task), return_exceptions=True)

        current = await self._turns.latest(parent.id, parent.user_id)
        current_waiting = waiting_state(current)
        if (
            current is None
            or parked is None
            or current.id != parked.id
            or current_waiting is None
            or self.is_running(parent.id)
            or self._cancelling_sessions.get(parent.id, 0)
        ):
            return
        results = await terminal_results(current_waiting)
        if results is None:
            return
        try:
            await self.arun(
                parent.id,
                SubAgentsCompleted(results=results),
                execution_mode=current.execution_mode,
            )
        except InvocationStateError:
            return

    async def recover(self) -> None:
        """Resume completed Child joins; Workflow Runs recover from Workspace state."""
        turns = await self._turns.list_latest_by_status(TurnStatus.AWAITING_SUBAGENTS)
        for turn in turns:
            parent = await self._sessions.load_by_id(turn.session_id)
            if parent is None or self.is_running(parent.id):
                continue
            await self._join_subagents(parent)

    def _publish_subagent_event(
        self,
        parent_session_id: str,
        child_session_id: str,
        parent_call_id: Optional[str],
        mode: SubAgentMode,
        *,
        phase: str,
        goal: str,
        status: Any,
        turn: Optional[SessionTurnRecord] = None,
    ) -> None:
        """Publish one Child lifecycle event to the parent Session."""
        status_value = status.value if isinstance(status, Enum) else str(status)
        self._system_events.publish_nowait(SubAgentEvent(
            session_id=parent_session_id,
            invocation_id=child_session_id,
            parent_invocation_id=parent_session_id,
            parent_tool_call_id=parent_call_id,
            mode=mode.value,
            goal=goal,
            status=status_value,
            phase=phase,
            answer=turn.final_answer if turn is not None else None,
            error=turn.error if turn is not None else None,
        ))

    ############################################################################
    # Agent Task Management
    ############################################################################

    async def _delete_workspace_workflow_runs(self, sessions: list[SessionRecord]) -> None:
        """Delete active Runs only when their root Session is in this scope."""
        if not sessions:
            return
        if any(session.user_id != sessions[0].user_id for session in sessions):
            raise RuntimeError("A Session tree cannot span multiple users")
        roots: dict[Path, list[SessionRecord]] = {}
        for session in sessions:
            root = Path(session.workspace_root).expanduser()
            if root.is_symlink():
                raise RuntimeError("A Session Workspace root cannot be a symbolic link")
            roots.setdefault(root.resolve(), []).append(session)
        for root, scoped_sessions in roots.items():
            workspace = Workspace(scoped_sessions[0].id, session_root=root)
            if any(session.parent_session_id is None for session in scoped_sessions):
                await workspace.discard_run_workflow()

    async def cancel(self, session_id: str) -> bool:
        """Cancel one Session tree, including parked Child Agent turns.

        A Child may have no live asyncio task because it is parked on a human
        interaction or waiting for its own blocking Children. Such a Child must
        still become durably terminal so its parent batch can join.
        """
        record = await self._sessions.load_by_id(session_id)
        if record is None:
            return False
        tree = await self._sessions.list_tree(record.user_id, record.id)
        cancelling_ids = [item.id for item in tree]
        for item_id in cancelling_ids:
            self._cancelling_sessions[item_id] = self._cancelling_sessions.get(item_id, 0) + 1
        try:
            changed = False
            tasks = []
            for child in reversed(tree):
                async with self._tasks_lock:
                    task = self._tasks.get(child.id)
                if task is not None and not task.done():
                    task.cancel()
                    tasks.append(task)
                    changed = True
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

            manually_cancelled: list[SessionRecord] = []
            for item in reversed(tree):
                if await self._cancel_parked_session(item):
                    manually_cancelled.append(item)
                    changed = True
            for item in manually_cancelled:
                self._session_events.open(item.id).finish(CancelledEvent())
            if record in manually_cancelled and record.parent_session_id is not None:
                cancelled_turn = await self._turns.latest(record.id, record.user_id)
                if cancelled_turn is not None:
                    await self._settle_subagent(record, cancelled_turn.user_input)
            return changed
        finally:
            for item_id in cancelling_ids:
                remaining = self._cancelling_sessions.get(item_id, 0) - 1
                if remaining > 0:
                    self._cancelling_sessions[item_id] = remaining
                else:
                    self._cancelling_sessions.pop(item_id, None)

    async def _cancel_parked_session(self, record: SessionRecord) -> bool:
        """Replace one nonterminal parked Turn with a cancelled terminal Turn."""
        latest = await self._turns.latest(record.id, record.user_id)
        if latest is None:
            if record.parent_session_id is None:
                return False
            values = {
                "session_id": record.id,
                "expected_tail_id": None,
                "user_input": UserInput(text=record.title or ""),
                "ota_records": [],
                "agent_state": {},
                "browser_tool_loaded": False,
                "workspace_tools_loaded": False,
                "skills_tool_loaded": False,
                "status": TurnStatus.CANCELLED,
                "final_answer": None,
                "error": "Agent execution cancelled by user",
                "input_tokens": 0,
                "output_tokens": 0,
                "model": record.last_used_model,
            }
            try:
                await self._turns.append_result(record.user_id, **values)
            except RuntimeError:
                return False
        else:
            if latest.status.is_terminal:
                return False
            state = dict(latest.agent_state or {})
            state["interaction"] = None
            state["subagents"] = None
            try:
                await self._turns.replace_tail_result(
                    record.user_id,
                    session_id=record.id,
                    expected_tail_id=latest.id,
                    user_input=latest.user_input,
                    ota_records=latest.ota_records,
                    agent_state=state,
                    browser_tool_loaded=latest.browser_tool_loaded,
                    workspace_tools_loaded=latest.workspace_tools_loaded,
                    skills_tool_loaded=latest.skills_tool_loaded,
                    status=TurnStatus.CANCELLED,
                    final_answer=None,
                    error="Agent execution cancelled by user",
                    input_tokens=latest.input_tokens,
                    output_tokens=latest.output_tokens,
                    model=latest.model,
                    execution_mode=latest.execution_mode,
                    max_rounds=latest.max_rounds,
                    duration_ms=latest.duration_ms or 0,
                )
            except RuntimeError:
                return False
        await self._update_projection(
            record,
            SessionStatus.COMPLETED,
            record.last_used_model,
            "",
        )
        return True

    async def remove_session_tree(self, session_id: str) -> int:
        """Delete one Session tree and every private Workflow Run it owns."""
        record = await self._sessions.load_by_id(session_id)
        if record is None:
            return 0
        tree = await self._sessions.list_tree(record.user_id, record.id)
        await self.cancel(record.id)
        await self._delete_workspace_workflow_runs(tree)
        await self._browser_host.release_sessions(item.id for item in tree)
        for item in reversed(tree):
            await self._turns.delete_for_session(item.user_id, item.id)
            await self._mounts.delete_for_session(item.id, item.user_id)
            await self._sessions.delete(item.id, item.user_id)
            await self._session_events.drop(item.id)
        return len(tree)

    async def reset_session(self, session_id: str) -> bool:
        """Clear a root Session's Turns and remove every Child Session below it."""
        record = await self._sessions.load_by_id(session_id)
        if record is None:
            return False
        tree = await self._sessions.list_tree(record.user_id, record.id)
        await self.cancel(record.id)
        await self._delete_workspace_workflow_runs(tree)
        await self._browser_host.release_sessions(item.id for item in tree)
        for child in reversed(tree[1:]):
            await self._turns.delete_for_session(child.user_id, child.id)
            await self._mounts.delete_for_session(child.id, child.user_id)
            await self._sessions.delete(child.id, child.user_id)
            await self._session_events.drop(child.id)
        await self._turns.delete_for_session(record.user_id, record.id)
        await self._sessions.reset(record.id, record.user_id)
        return True

    async def shutdown(self) -> None:
        """Cancel and drain every process-owned Agent and background task."""
        async with self._tasks_lock:
            tasks = [task for task in self._tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        background = [
            task for task in self._background_tasks if not task.done()
        ]
        for task in background:
            task.cancel()
        if background:
            await asyncio.gather(*background, return_exceptions=True)
        if self._owns_browser_host:
            await self._browser_host.shutdown()

    def is_running(self, session_id: str) -> bool:
        """Return whether this process owns an active task for the Session."""
        task = self._tasks.get(session_id)
        return task is not None and not task.done()

    def has_running_tasks(self) -> bool:
        """Return whether this process owns any active Agent task."""
        return any(not task.done() for task in self._tasks.values())

    def bind_schedule_killer(self, killer: Callable[[str], Any]) -> None:
        """Bind the scheduler's ``kill`` so schedule-deleting tools can cancel an
        in-flight run. Late-bound in the daemon wiring because the
        ``SchedulerService`` is constructed after (and holding) this invocation;
        passing only the callable avoids an amphi_agent -> service import cycle.
        """
        self._schedule_killer = killer

    async def kill_schedule(self, schedule_id: str) -> None:
        """Cancel any in-flight run for ``schedule_id`` (no-op if unbound)."""
        if self._schedule_killer is not None:
            await self._schedule_killer(schedule_id)

    async def _finalize_title(
        self,
        task: "asyncio.Task[Optional[str]]",
        session_id: str,
        user_id: str,
        current_title: Optional[str],
    ) -> Optional[str]:
        try:
            title = await task
            if not title or title == current_title:
                return None
            await self._sessions.rename(session_id, user_id, title)
            return title
        except Exception:  # noqa: BLE001 - title generation is best effort
            return None

    async def _emit_title_when_ready(
        self,
        task: "asyncio.Task[Optional[str]]",
        session_id: str,
        user_id: str,
        current_title: Optional[str],
    ) -> None:
        """Await + persist the generated title OFF the turn's critical path, then push
        it to the Session topic as a ``title`` event so the sidebar updates. The
        turn's publisher has finished by now, so this goes through the broker's
        ``emit`` (topic subscribers persist across turns)."""
        title = await self._finalize_title(task, session_id, user_id, current_title)
        if title is not None:
            self._session_events.emit(session_id, "title", title=title)

    def _spawn_background(self, coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        self._background_tasks.add(task)

        def finish(completed: asyncio.Task[Any]) -> None:
            self._background_tasks.discard(completed)
            if completed.cancelled():
                return
            error = completed.exception()
            if error is not None:
                logger.error("Background invocation task failed", exc_info=error)

        task.add_done_callback(finish)

    ############################################################################
    # Helper
    ############################################################################
    @staticmethod
    def _publish_interaction(publisher: Any, interaction: Optional["InteractionState"]) -> None:
        """Publish one persisted interaction request on its Session topic."""
        if isinstance(interaction, AwaitingPermission):
            permission = interaction.permission or {}
            publisher.publish(
                "permission_request",
                kind="choose",
                questions=permission.get("questions") or [],
                items=permission.get("items") or [],
                request_id=interaction.request_id,
            )
        elif isinstance(interaction, AwaitingFeedback):
            publisher.publish(
                "human_request",
                kind="choose",
                prompt=interaction.prompt,
                questions=interaction.questions,
                request_id=interaction.request_id,
            )
        elif isinstance(interaction, AwaitingBuildConfirm):
            publisher.publish(
                "build_confirm_request",
                request_id=interaction.request_id,
                goal=interaction.goal,
                reason=interaction.reason,
            )
        elif isinstance(interaction, AwaitingBuildConflict):
            publisher.publish(
                "human_request",
                kind="choose",
                questions=interaction.questions,
                request_id=interaction.request_id,
            )
        elif isinstance(interaction, AwaitingWorkflowRunChoice):
            publisher.publish(
                "human_request",
                kind="choose",
                questions=interaction.questions,
                request_id=interaction.request_id,
            )
        elif isinstance(interaction, AwaitingAcceptRule):
            payload = interaction.accept_rule or {}
            publisher.publish(
                "accept_rule_request",
                request_id=str(payload.get("request_id") or ""),
                rules=payload.get("candidate_rules") or [],
            )
        elif isinstance(interaction, AwaitingTaskConfirm):
            payload = interaction.task_confirm or {}
            publisher.publish(
                "task_confirm_request",
                request_id=str(payload.get("request_id") or ""),
                task_markdown=str(payload.get("task_markdown") or ""),
                previous_task_markdown=payload.get("previous_task_markdown"),
                operation=str(payload.get("operation") or "create"),
                workflow_id=payload.get("workflow_id"),
                original_task_markdown=payload.get("original_task_markdown"),
            )
        elif isinstance(interaction, AwaitingWorkflowConfirm):
            payload = interaction.workflow_confirm or {}
            publisher.publish(
                "workflow_confirm_request",
                request_id=str(payload.get("request_id") or ""),
                default_name=str(payload.get("default_name") or ""),
                summary=payload.get("summary"),
                operation=str(payload.get("operation") or "create"),
                workflow_id=payload.get("workflow_id"),
            )

    @staticmethod
    def _status_for(outcome: InvocationOutcome) -> TurnStatus:
        if outcome.disposition is InvocationDisposition.COMPLETED:
            return TurnStatus.COMPLETED
        if outcome.disposition is InvocationDisposition.AWAITING_SUBAGENTS:
            return TurnStatus.AWAITING_SUBAGENTS
        if outcome.disposition is InvocationDisposition.AWAITING_PERMISSION:
            return TurnStatus.AWAITING_PERMISSION
        return TurnStatus.AWAITING_HUMAN

    @classmethod
    def _ota_context_values(cls, ota_context: AmphiOTAContext) -> dict[str, Any]:
        dump = ota_context.model_dump(
            mode="json",
            include={
                "ota_record",
                "state",
                "browser_tool_loaded",
                "workspace_tools_loaded",
                "skills_tool_loaded",
            },
        )
        values = {
            "ota_records": dump.get("ota_record") or [],
            "agent_state": dump.get("state") or {},
            "browser_tool_loaded": bool(dump.get("browser_tool_loaded")),
            "workspace_tools_loaded": bool(dump.get("workspace_tools_loaded")),
            "skills_tool_loaded": bool(dump.get("skills_tool_loaded")),
        }
        size = len(
            json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )
        if size > cls.MAX_OTA_CONTEXT_BYTES:
            raise InvocationTraceLimitError(
                f"Invocation OTA context exceeded {cls.MAX_OTA_CONTEXT_BYTES} bytes",
            )
        return values

    @staticmethod
    def _minimal_recovery_checkpoint(
        ota_context: AmphiOTAContext,
    ) -> dict[str, Any]:
        """Keep only cognitive state when a complete OTA trace is too large."""
        state_dump = ota_context.model_dump(
            mode="json",
            include={"state"},
        ).get("state") or {}
        think = state_dump.get("think") if isinstance(state_dump, dict) else None
        return {
            "ota_records": [],
            "agent_state": {"think": think} if isinstance(think, dict) else {},
            "browser_tool_loaded": False,
            "workspace_tools_loaded": False,
            "skills_tool_loaded": False,
        }

    @staticmethod
    def _outcome(agent_result: AgentResult, ota_context: AmphiOTAContext) -> InvocationOutcome:
        if isinstance(agent_result, str):
            if ota_context.interaction_status is not None or ota_context.subagent_status is not None:
                raise InvocationStateError("Agent returned text while a parked state remained active")
            disposition = InvocationDisposition.COMPLETED
            answer = agent_result
        elif isinstance(agent_result, AwaitingSubAgent):
            if ota_context.subagent_status != agent_result:
                raise InvocationStateError("Agent sub-agent result does not match its waiting state")
            disposition = InvocationDisposition.AWAITING_SUBAGENTS
            answer = ""
        elif isinstance(agent_result, AwaitingPermission):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent permission result does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_PERMISSION
            answer = ""
        elif isinstance(agent_result, AwaitingFeedback):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent feedback result does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_FEEDBACK
            answer = ""
        elif isinstance(agent_result, AwaitingAcceptRule):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError(
                    "Agent acceptance-rule result does not match its interaction state"
                )
            disposition = InvocationDisposition.AWAITING_ACCEPT_RULE
            answer = ""
        elif isinstance(agent_result, AwaitingBuildConfirm):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent Build confirmation does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_BUILD_CONFIRM
            answer = ""
        elif isinstance(agent_result, AwaitingBuildConflict):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent Build conflict does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_FEEDBACK
            answer = ""
        elif isinstance(agent_result, AwaitingWorkflowRunChoice):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError(
                    "Agent Workflow Run choice does not match its interaction state"
                )
            disposition = InvocationDisposition.AWAITING_FEEDBACK
            answer = ""
        elif isinstance(agent_result, AwaitingTaskConfirm):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent task result does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_TASK_CONFIRM
            answer = ""
        elif isinstance(agent_result, AwaitingWorkflowConfirm):
            if ota_context.interaction_status != agent_result:
                raise InvocationStateError("Agent workflow result does not match its interaction state")
            disposition = InvocationDisposition.AWAITING_WORKFLOW_CONFIRM
            answer = ""
        else:
            raise TypeError(f"Unsupported Agent result: {type(agent_result).__name__}")
        return InvocationOutcome(
            answer=answer,
            disposition=disposition,
            input_tokens=ota_context.input_tokens,
            output_tokens=ota_context.output_tokens,
        )
