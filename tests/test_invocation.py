import asyncio
from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import (
    AgentInvocation,
    AmphiAgent,
    AmphiContext,
    AmphiOTAContext,
    InvocationDisposition,
    InvocationOutcome,
    InvocationRunResult,
    InvocationStaleAnswerError,
    InvocationStateError,
    InvocationTraceLimitError,
    Session,
)
from src.amphi_agent._browser import SessionBrowser
from src.amphi_agent._cognitive import MainThink, render_input
from src.amphi_agent._state import (
    AwaitingSubAgent,
    AwaitingFeedback,
    AwaitingWorkflowRunChoice,
    BuildStageState,
    RoundPermission,
    SubAgentCall,
    SubAgentResult,
    SubAgentsCompleted,
)
from src.amphi_agent._workflow_run import RunWorkflow, WorkflowRun, WorkflowRunLibrary
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._subagent import BackgroundSubagentRequest, SubagentRequest
from src.amphi_agent.tools._request_human import RequestBuild
from src.amphi_service.protocol import (
    WsAcceptRuleMessage,
    CancelledEvent,
    ErrorEvent,
    FinalEvent,
    SubAgentEvent,
    WsBuildConfirmMessage,
    WsChatMessage,
    WsTaskConfirmMessage,
    WsWorkflowConfirmMessage,
)
from src.amphi_store import (
    SessionMountRepository,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SubAgentMode,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
    UserRepository,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)
from src.amphi_service.runtime import SessionEventBroker, SystemEventBroker
from ._session_turns import make_session_turns


@pytest.fixture
async def invocation_repo(connected_repo, tmp_path):
    """Create the user and root Session required by invocation tests."""
    users = UserRepository()
    await users.ensure_seeded("user-1")
    await users.set_active_provider(
        "user-1", api_key="test-key", base_url=None, model="model-1",
    )
    workspace = tmp_path / "session-1"
    (workspace / ".work").mkdir(parents=True)
    await SessionRepository().save(SessionRecord(
        id="session-1",
        user_id="user-1",
        workspace_root=str(workspace),
    ))


@pytest.fixture
def session_events() -> SessionEventBroker:
    return SessionEventBroker()


class _BrowserHostSpy:
    def __init__(self) -> None:
        self.released: list[tuple[str, ...]] = []
        self.session_bindings: list[tuple[str, Path | None]] = []
        self.shutdown_calls = 0

    def for_session(self, session_id: str, *, tool_result_dir: Path | None = None):
        self.session_bindings.append((session_id, tool_result_dir))
        return SessionBrowser(self, session_id, tool_result_dir=tool_result_dir)

    async def release_sessions(self, session_ids) -> None:
        self.released.append(tuple(session_ids))

    async def shutdown(self) -> None:
        self.shutdown_calls += 1


async def _create_workspace_run(
    workspace_root: Path,
    source_root: Path,
):
    package = source_root / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\nname: invocation-fixture\ndescription: Invocation fixture.\n---\n\n"
        "# Execute\n\nProduce a result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (source_root / name).write_text(f"# {name}\n", encoding="utf-8")
    workspace = Workspace("session-1", session_root=workspace_root)
    workflow_input = UserInput(text="run report")
    return workspace, await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": "wf-report",
            "generation": "generation-1",
            "workflow_name": "Report",
            "workflow_input": workflow_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=lambda root: RunWorkflow(root).prepare(
            "create",
            source_root=source_root,
        ),
    )


async def _create_terminal_run(
    result_id: str,
    source_session_id: str = "session-1",
) -> WorkflowRun:
    active_root = WorkflowRun.managed_root("wf-report", result_id).parent / f".{result_id}.active"
    (active_root / "result").mkdir(parents=True)
    (active_root / "source").mkdir()
    (active_root / "background" / "work").mkdir(parents=True)
    (active_root / "result" / "result.txt").write_text("done\n", encoding="utf-8")
    return await WorkflowRunLibrary("user-1").publish(
        active_root,
        result_id=result_id,
        workflow_id="wf-report",
        workflow_name="Report",
        source_session_id=source_session_id,
        workflow_input=UserInput(text="run report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )


class FakeLlms:
    async def resolve(self, user, model):
        assert user.id == "user-1"
        return object()


async def test_invocation_shutdown_closes_only_an_owned_browser_host(
    monkeypatch: pytest.MonkeyPatch,
    session_events: SessionEventBroker,
) -> None:
    import src.amphi_agent._invocation as invocation_module

    owned_host = _BrowserHostSpy()
    monkeypatch.setattr(invocation_module, "BrowserHost", lambda: owned_host)
    owned_invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    app_host = _BrowserHostSpy()
    app_invocation = AgentInvocation(
        FakeLlms(), session_events, SystemEventBroker(), browser_host=app_host,
    )

    await owned_invocation.shutdown()
    await app_invocation.shutdown()

    assert owned_host.shutdown_calls == 1
    assert app_host.shutdown_calls == 0


async def test_invocation_binds_browser_snapshots_to_workspace_internal_results(
    invocation_repo,
    session_events,
    tmp_path,
    monkeypatch,
) -> None:
    import src.amphi_agent._invocation as invocation_module

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            return "done"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    browser_host = _BrowserHostSpy()
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
        browser_host=browser_host,
    )

    result = await (await invocation.arun("session-1", "inspect the page"))

    assert result.outcome.answer == "done"
    assert browser_host.session_bindings == [(
        "session-1",
        (tmp_path / "session-1" / ".internal" / "tool_results").resolve(),
    )]


async def test_invocation_prepare_delegates_to_workspace(
    session_events: SessionEventBroker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def prepare_environment() -> None:
        calls.append("prepare")

    monkeypatch.setattr(Workspace, "prepare_environment", prepare_environment)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    await invocation.prepare()

    assert calls == ["prepare"]


async def test_invocation_associates_a_referenced_run_with_the_root_session(
    invocation_repo,
    session_events,
    tmp_path,
    monkeypatch,
) -> None:
    """Referencing a published Run makes it visible from the current Session."""
    import src.amphi_agent._invocation as invocation_module

    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    source_root = tmp_path / "source-session"
    source_root.mkdir()
    await SessionRepository().save(SessionRecord(
        id="session-source",
        user_id="user-1",
        workspace_root=str(source_root),
    ))
    run = await _create_terminal_run("wfr_referenced", "session-source")

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            return "referenced"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    user_input = UserInput(
        text="参考之前的结果",
        blocks=[{
            "type": "mention",
            "id": run.run_id,
            "label": "Report",
            "group": "WorkflowRun",
        }],
    )

    result = await (await invocation.arun("session-1", user_input))

    assert result.outcome.answer == "referenced"
    associated = await WorkflowRunRepository().list_for_session("user-1", "session-1")
    assert [row.id for row in associated] == [run.run_id]
    assert associated[0].source_session_id == "session-source"


@pytest.mark.parametrize(("interaction", "answer"), [
    (
        {"build_confirm": True, "request_id": "build-1", "goal": "Build it"},
        WsBuildConfirmMessage(
            session_id="session-1",
            request_id="build-1",
            action="confirm",
        ),
    ),
    (
        {
            "accept_rule": {
                "request_id": "accept-1",
                "candidate_rules": ["The result exists."],
            },
        },
        WsAcceptRuleMessage(
            session_id="session-1",
            request_id="accept-1",
            decisions=["accept"],
        ),
    ),
    (
        {"task_confirm": {"request_id": "task-1"}},
        WsTaskConfirmMessage(
            session_id="session-1",
            request_id="task-1",
            action="confirm",
        ),
    ),
    (
        {"workflow_confirm": {"request_id": "workflow-1"}},
        WsWorkflowConfirmMessage(
            session_id="session-1",
            request_id="workflow-1",
            action="cancel",
        ),
    ),
])
def test_structured_confirmation_admission_consumes_only_the_matching_request(
    interaction,
    answer,
) -> None:
    """Build/task/workflow confirmations share matching and stale semantics."""
    pending = make_session_turns([(
        UserInput(text="original request"),
        {"state": {"interaction": interaction}},
    )], user_id="user-1", session_id="session-1")[-1]

    assert AgentInvocation._accept_input(pending, answer) is True

    stale = answer.model_copy(update={"request_id": "stale-request"})
    with pytest.raises(InvocationStaleAnswerError, match="does not match"):
        AgentInvocation._accept_input(pending, stale)


def test_workflow_run_choice_is_published_and_parked_as_feedback() -> None:
    questions = [{
        "question": "继续旧运行还是重新运行？",
        "options": [{"label": "继续原运行"}, {"label": "丢弃并重新运行"}],
    }]
    choice = AwaitingWorkflowRunChoice(
        existing_workflow_id="wf-report",
        requested_workflow_id="wf-report",
        questions=questions,
        request_id="workflow-run-choice-1",
    )
    ota = AmphiOTAContext(user_input="继续")
    ota.transition_interaction(choice)

    outcome = AgentInvocation._outcome(choice, ota)

    assert outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK
    events = []

    class Publisher:
        def publish(self, event: str, **payload) -> None:
            events.append((event, payload))

    AgentInvocation._publish_interaction(Publisher(), choice)
    assert events == [(
        "human_request",
        {
            "kind": "choose",
            "questions": questions,
            "request_id": "workflow-run-choice-1",
        },
    )]


async def test_arun_subagent_creates_a_child_session_and_uses_normal_invocation(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """The RPC Child entry creates durable lineage before scheduling arun."""
    import src.amphi_agent._invocation as invocation_module

    seen_contexts: list[tuple[str, str]] = []

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            seen_contexts.append((context.session.id, context.execution_mode))
            return "child result"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    task = await invocation.arun_subagent(
        "session-1",
        "inspect this",
        parent_call_id="call-bash",
        execution_mode="full",
    )
    result = await task
    child = await SessionRepository().load(result.session_id, "user-1")

    assert child is not None
    assert child.parent_session_id == "session-1"
    assert child.parent_call_id == "call-bash"
    assert child.subagent_mode is SubAgentMode.RPC
    assert seen_contexts == [(child.id, "full")]
    assert result.outcome.answer == "child result"
    await invocation.shutdown()


async def test_child_session_cannot_create_grandchildren_through_invocation_entries(
    invocation_repo,
    session_events,
) -> None:
    """RPC, background, and blocking creation share the root-parent invariant."""
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    repository = SessionRepository()
    child = await repository.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-root",
        subagent_mode=SubAgentMode.RPC,
    )
    call = SubAgentCall.create("call-child", "nested task")

    with pytest.raises(InvocationStateError, match="Child Sessions cannot create sub-agents"):
        await invocation.arun_subagent(child.id, "nested rpc task")
    with pytest.raises(InvocationStateError, match="Child Sessions cannot create sub-agents"):
        await invocation.start_subagent(child.id, call)
    with pytest.raises(InvocationStateError, match="Child Sessions cannot create sub-agents"):
        await invocation._prepare_subagents(child, [call], SubAgentMode.BLOCKING)

    assert await repository.list_children("user-1", child.id) == []
    await invocation.shutdown()


async def test_child_agent_attempts_share_their_root_concurrency_limit(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """Children of one root share that root's execution slots."""
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
        max_concurrent_children=2,
    )
    repository = SessionRepository()
    children = [
        await repository.create_child(
            "user-1",
            parent_session_id="session-1",
            parent_call_id="call-bash",
            subagent_mode=SubAgentMode.RPC,
        )
        for _ in range(3)
    ]
    entered = 0
    active = 0
    peak = 0
    two_started = asyncio.Event()
    release = asyncio.Event()

    async def execute(record, user_input, stream, *, execution_mode=None):
        nonlocal entered, active, peak
        entered += 1
        active += 1
        peak = max(peak, active)
        if entered == 2:
            two_started.set()
        await release.wait()
        active -= 1
        return InvocationRunResult(
            session_id=record.id,
            turn_id=f"turn-{record.id}",
            outcome=InvocationOutcome("done", InvocationDisposition.COMPLETED, 0, 0),
        )

    async def settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(invocation, "_execute", execute)
    monkeypatch.setattr(invocation, "_settle_subagent", settle)
    tasks = [await invocation.arun(child.id, "inspect") for child in children]

    await asyncio.wait_for(two_started.wait(), timeout=1)
    await asyncio.sleep(0)
    assert entered == 2
    assert peak == 2

    release.set()
    await asyncio.gather(*tasks)
    assert entered == 3
    assert peak == 2
    await invocation.shutdown()


async def test_child_agent_attempts_use_independent_root_concurrency_pools(
    invocation_repo,
    session_events,
    tmp_path,
    monkeypatch,
) -> None:
    """One saturated root does not consume another root's execution slots."""
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
        max_concurrent_children=1,
    )
    repository = SessionRepository()
    second_workspace = tmp_path / "session-2"
    (second_workspace / ".work").mkdir(parents=True)
    await repository.save(SessionRecord(
        id="session-2",
        user_id="user-1",
        workspace_root=str(second_workspace),
    ))
    roots = ("session-1", "session-2")
    children = [
        await repository.create_child(
            "user-1",
            parent_session_id=root_id,
            parent_call_id=f"call-{root_id}-{index}",
            subagent_mode=SubAgentMode.RPC,
        )
        for root_id in roots
        for index in range(2)
    ]
    entered = {root_id: 0 for root_id in roots}
    active = {root_id: 0 for root_id in roots}
    peak = {root_id: 0 for root_id in roots}
    both_roots_started = asyncio.Event()
    release = asyncio.Event()

    async def execute(record, user_input, stream, *, execution_mode=None):
        root_id = record.parent_session_id
        entered[root_id] += 1
        active[root_id] += 1
        peak[root_id] = max(peak[root_id], active[root_id])
        if all(entered[value] >= 1 for value in roots):
            both_roots_started.set()
        await release.wait()
        active[root_id] -= 1
        return InvocationRunResult(
            session_id=record.id,
            turn_id=f"turn-{record.id}",
            outcome=InvocationOutcome("done", InvocationDisposition.COMPLETED, 0, 0),
        )

    async def settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(invocation, "_execute", execute)
    monkeypatch.setattr(invocation, "_settle_subagent", settle)
    tasks = [await invocation.arun(child.id, "inspect") for child in children]

    await asyncio.wait_for(both_roots_started.wait(), timeout=1)
    await asyncio.sleep(0)
    assert entered == {"session-1": 1, "session-2": 1}
    assert active == {"session-1": 1, "session-2": 1}

    release.set()
    await asyncio.gather(*tasks)
    assert entered == {"session-1": 2, "session-2": 2}
    assert peak == {"session-1": 1, "session-2": 1}
    await invocation.shutdown()


async def test_parked_child_attempt_releases_its_root_concurrency_slot(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A Child waiting for human input does not retain an execution slot."""
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
        max_concurrent_children=1,
    )
    repository = SessionRepository()
    first, second = [
        await repository.create_child(
            "user-1",
            parent_session_id="session-1",
            parent_call_id=f"call-{index}",
            subagent_mode=SubAgentMode.RPC,
        )
        for index in range(2)
    ]
    second_started = asyncio.Event()
    release_second = asyncio.Event()

    async def execute(record, user_input, stream, *, execution_mode=None):
        if record.id == first.id:
            return InvocationRunResult(
                session_id=record.id,
                turn_id=f"turn-{record.id}",
                outcome=InvocationOutcome(
                    "",
                    InvocationDisposition.AWAITING_FEEDBACK,
                    0,
                    0,
                ),
            )
        second_started.set()
        await release_second.wait()
        return InvocationRunResult(
            session_id=record.id,
            turn_id=f"turn-{record.id}",
            outcome=InvocationOutcome("done", InvocationDisposition.COMPLETED, 0, 0),
        )

    async def settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(invocation, "_execute", execute)
    monkeypatch.setattr(invocation, "_settle_subagent", settle)

    first_task = await invocation.arun(first.id, "inspect")
    first_result = await first_task
    assert first_result.outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK

    second_task = await invocation.arun(second.id, "inspect")
    await asyncio.wait_for(second_started.wait(), timeout=1)
    release_second.set()
    await second_task
    await invocation.shutdown()


async def test_resumed_child_reports_queued_before_reacquiring_its_root_slot(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """An accepted Child interaction stops looking unanswered while it queues."""
    class RecordingSystemEvents:
        def __init__(self) -> None:
            self.events: list[SubAgentEvent] = []

        def publish_nowait(self, event) -> int:
            if isinstance(event, SubAgentEvent):
                self.events.append(event)
            return 1

    system_events = RecordingSystemEvents()
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        system_events,
        max_concurrent_children=1,
    )
    repository = SessionRepository()
    holder, resumed = [
        await repository.create_child(
            "user-1",
            parent_session_id="session-1",
            parent_call_id=f"call-{index}",
            subagent_mode=SubAgentMode.RPC,
            title=f"child {index}",
        )
        for index in range(2)
    ]
    parked = await SessionTurnRepository().append_result(
        "user-1",
        session_id=resumed.id,
        expected_tail_id=None,
        user_input=UserInput(text="original child task"),
        ota_records=[{"observation_result": "waiting"}],
        agent_state={"interaction": {"questions": [{"question": "Continue?"}]}},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_HUMAN,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    await repository.update_turn_projection(
        resumed.id,
        "user-1",
        status=SessionStatus.AWAITING,
        model="model-1",
        last_answer=None,
    )
    holder_started = asyncio.Event()
    release_holder = asyncio.Event()
    resumed_started = asyncio.Event()

    async def execute(record, user_input, stream, *, execution_mode=None):
        if record.id == holder.id:
            holder_started.set()
            await release_holder.wait()
        else:
            resumed_started.set()
        return InvocationRunResult(
            session_id=record.id,
            turn_id=f"turn-{record.id}",
            outcome=InvocationOutcome("done", InvocationDisposition.COMPLETED, 0, 0),
        )

    async def settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(invocation, "_execute", execute)
    monkeypatch.setattr(invocation, "_settle_subagent", settle)
    holder_task = await invocation.arun(holder.id, "hold the slot")
    await asyncio.wait_for(holder_started.wait(), timeout=1)
    system_events.events.clear()

    resumed_task = await invocation.arun(resumed.id, "continue")
    await asyncio.sleep(0)
    resumed_events = [
        event for event in system_events.events
        if event.invocation_id == resumed.id
    ]
    assert [(event.phase, event.status) for event in resumed_events] == [
        ("status", "queued"),
    ]
    assert not resumed_started.is_set()
    latest = await SessionTurnRepository().latest(resumed.id, "user-1")
    assert latest is not None and latest.id == parked.id
    assert latest.status is TurnStatus.AWAITING_HUMAN

    release_holder.set()
    await asyncio.wait_for(resumed_started.wait(), timeout=1)
    assert [
        event.status
        for event in system_events.events
        if event.invocation_id == resumed.id
    ] == ["queued", "running"]
    await asyncio.gather(holder_task, resumed_task)
    await invocation.shutdown()


async def test_cancelling_queued_child_does_not_leak_root_pool_state(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """Cancelling a waiter releases its lease reference and leaves the pool reusable."""
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
        max_concurrent_children=1,
    )
    repository = SessionRepository()
    first, queued = [
        await repository.create_child(
            "user-1",
            parent_session_id="session-1",
            parent_call_id=f"call-{index}",
            subagent_mode=SubAgentMode.RPC,
        )
        for index in range(2)
    ]
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    entered: list[str] = []

    async def execute(record, user_input, stream, *, execution_mode=None):
        entered.append(record.id)
        if record.id == first.id:
            first_started.set()
            await release_first.wait()
        return InvocationRunResult(
            session_id=record.id,
            turn_id=f"turn-{record.id}",
            outcome=InvocationOutcome("done", InvocationDisposition.COMPLETED, 0, 0),
        )

    async def settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(invocation, "_execute", execute)
    monkeypatch.setattr(invocation, "_settle_subagent", settle)
    first_task = await invocation.arun(first.id, "first")
    await asyncio.wait_for(first_started.wait(), timeout=1)
    queued_task = await invocation.arun(queued.id, "queued")
    await asyncio.sleep(0)
    assert entered == [first.id]

    assert await invocation.cancel(queued.id) is True
    assert queued_task.cancelled()
    release_first.set()
    await first_task

    replacement = await repository.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-replacement",
        subagent_mode=SubAgentMode.RPC,
    )
    replacement_task = await invocation.arun(replacement.id, "replacement")
    await replacement_task
    assert entered == [first.id, replacement.id]
    assert invocation._child_pools._pools == {}
    await invocation.shutdown()


async def test_agent_invocation_runs_and_resumes_by_session_id(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """The latest parked Turn is resumed without exposing a Turn id."""
    import src.amphi_agent._invocation as invocation_module

    contexts = []
    loaded_turn_ids = []

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            assert (max_rounds, verbose) == (50, False)

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            contexts.append((context, ota_context))
            loaded_turn_ids.append([turn.id for turn in context.session.get_all()])
            if len(contexts) == 1:
                ota_context.transition_interaction(AwaitingFeedback(
                    questions=[{
                        "question": "Review this file?",
                        "options": [{"label": "yes"}, {"label": "no"}],
                    }],
                ))
                ota_context.input_tokens = 2
                ota_context.output_tokens = 1
                return ota_context.interaction_status
            if len(contexts) == 2:
                previous = context.session.get_all()[-1]
                context.session = context.session.without_last()
                ota_context.user_input = previous.user_input
                ota_context.transition_interaction(None)
            ota_context.input_tokens = 3
            ota_context.output_tokens = 4
            return "approved" if len(contexts) == 2 else "next answer"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    task = await invocation.arun("session-1", "inspect the files")
    parked = await task
    assert parked.session_id == "session-1"
    assert parked.outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK
    stored = await SessionTurnRepository().latest("session-1", "user-1")
    assert stored is not None
    assert stored.status is TurnStatus.AWAITING_HUMAN
    assert stored.input_tokens == 2 and stored.output_tokens == 1

    await UserRepository().set_model("user-1", "model-2")
    await UserRepository().set_execution_mode("user-1", "full")
    task = await invocation.arun("session-1", "yes")
    completed = await task
    assert completed.session_id == "session-1"
    assert completed.turn_id != parked.turn_id
    assert completed.outcome.answer == "approved"
    stored = await SessionTurnRepository().latest("session-1", "user-1")
    assert stored is not None
    assert stored.status is TurnStatus.COMPLETED
    assert stored.input_tokens == 5 and stored.output_tokens == 5
    assert stored.user_input.text == "inspect the files"
    assert loaded_turn_ids[1] == [parked.turn_id]
    assert contexts[1][0].session.get_all() == []
    assert contexts[1][0].execution_mode == "full"

    task = await invocation.arun("session-1", "next")
    followup = await task
    records = await SessionTurnRepository().list_conversation("user-1", "session-1")
    assert [record.id for record in records] == [completed.turn_id, followup.turn_id]
    assert [record.session_ordinal for record in records] == [0, 1]
    assert records[1].user_input.text == "next"


async def test_child_resume_keeps_delegated_mode_until_the_logical_turn_finishes(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A parked Child keeps its delegated mode, while a later Turn uses the User mode."""
    import src.amphi_agent._invocation as invocation_module

    child = await SessionRepository().create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.RPC,
    )
    context_modes: list[str] = []

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            context_modes.append(context.execution_mode)
            if len(context_modes) == 1:
                ota_context.transition_interaction(AwaitingFeedback(
                    questions=[{
                        "question": "Continue the delegated task?",
                        "options": [{"label": "yes"}, {"label": "no"}],
                    }],
                ))
                return ota_context.interaction_status
            if len(context_modes) == 2:
                previous = context.session.get_all()[-1]
                context.session = context.session.without_last()
                ota_context.user_input = previous.user_input
                ota_context.transition_interaction(None)
                return "delegated task completed"
            return "follow-up completed"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    parked = await (await invocation.arun(
        child.id,
        "perform the delegated task",
        execution_mode="full",
    ))
    parked_turn = await SessionTurnRepository().latest(child.id, "user-1")
    assert parked.outcome.disposition is InvocationDisposition.AWAITING_FEEDBACK
    assert parked_turn is not None
    assert parked_turn.status is TurnStatus.AWAITING_HUMAN
    assert parked_turn.execution_mode == "full"

    await UserRepository().set_execution_mode("user-1", "request")
    completed = await (await invocation.arun(child.id, "yes"))
    completed_turn = await SessionTurnRepository().latest(child.id, "user-1")
    assert completed.outcome.answer == "delegated task completed"
    assert completed_turn is not None
    assert completed_turn.status is TurnStatus.COMPLETED
    assert completed_turn.execution_mode == "full"

    followup = await (await invocation.arun(child.id, "now do a follow-up"))
    assert followup.outcome.answer == "follow-up completed"
    assert context_modes == ["full", "full", "request"]
    turns = await SessionTurnRepository().list_conversation("user-1", child.id)
    assert [turn.execution_mode for turn in turns] == ["full", "request"]
    await invocation.shutdown()


async def test_agent_invocation_fails_a_turn_when_context_setup_fails(
    invocation_repo,
    session_events,
) -> None:
    """A failure before AmphiAgent starts cannot leave a reusable created Turn."""
    class BrokenLlms:
        async def resolve(self, user, model):
            raise RuntimeError("provider unavailable")

    invocation = AgentInvocation(BrokenLlms(), session_events, SystemEventBroker())
    subscription = session_events.subscribe("session-1")
    error_event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)
    task = await invocation.arun("session-1", "start")
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await task

    event = await error_event
    assert isinstance(event, ErrorEvent)
    assert event.message == "RuntimeError: provider unavailable"
    await subscription.aclose()

    assert await SessionTurnRepository().latest("session-1", "user-1") is None
    session = await SessionRepository().load("session-1", "user-1")
    assert session is not None
    assert session.status.value == "completed"


async def test_context_setup_failure_does_not_reopen_an_accepted_interaction(
    invocation_repo,
    session_events,
) -> None:
    """A failed accepted resume does not restore the handled awaiting projection."""
    turns = SessionTurnRepository()
    parked = await turns.append_result(
        "user-1",
        session_id="session-1",
        expected_tail_id=None,
        user_input=UserInput(text="original task"),
        ota_records=[{"observation_result": "waiting"}],
        agent_state={"interaction": {"questions": []}},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_HUMAN,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    await SessionRepository().update_turn_projection(
        "session-1",
        "user-1",
        status=SessionStatus.AWAITING,
        model="model-1",
        last_answer=None,
    )

    class BrokenLlms:
        async def resolve(self, user, model):
            raise RuntimeError("provider unavailable")

    invocation = AgentInvocation(BrokenLlms(), session_events, SystemEventBroker())
    task = await invocation.arun("session-1", "answer")
    with pytest.raises(RuntimeError, match="provider unavailable"):
        await task

    current = await SessionTurnRepository().latest("session-1", "user-1")
    session = await SessionRepository().load("session-1", "user-1")
    assert current is not None and current.id == parked.id
    assert session is not None and session.status is SessionStatus.COMPLETED


def test_chat_is_admitted_as_a_whole_confirmation_card_response() -> None:
    message = WsChatMessage(
        session_id="s1",
        input="请根据这张卡片整体调整",
        blocks=[{"type": "text", "value": "请根据这张卡片整体调整"}],
    )
    interactions = [
        {
            "build_confirm": True,
            "request_id": "build-1",
            "goal": "Build the workflow.",
        },
        {
            "accept_rule": {
                "request_id": "accept-1",
                "candidate_rules": ["The result exists."],
            },
        },
        {"task_confirm": {"request_id": "task-1"}},
        {"workflow_confirm": {"request_id": "workflow-1"}},
    ]

    for interaction in interactions:
        pending = make_session_turns([(
            UserInput(text="build the workflow"),
            {"state": {"interaction": interaction}},
        )])[-1]
        assert AgentInvocation._accept_input(pending, message) is True


async def test_agent_invocation_persists_failure_after_agent_starts(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """An Agent failure becomes a fresh failed Turn with its available trace."""
    import src.amphi_agent._invocation as invocation_module

    class FailingAgent:
        final_answer = ""

        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            ota_context.ota_record = [OTARecord(observation_result="started")]
            ota_context.input_tokens = 2
            try:
                raise TimeoutError
            except TimeoutError as exc:
                raise RuntimeError("agent failed:") from exc

    monkeypatch.setattr(invocation_module, "AmphiAgent", FailingAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    subscription = session_events.subscribe("session-1")
    error_event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)
    task = await invocation.arun("session-1", "do work")
    with pytest.raises(RuntimeError, match="agent failed"):
        await task

    event = await error_event
    assert isinstance(event, ErrorEvent)
    assert event.message == "RuntimeError: agent failed: (caused by TimeoutError)"
    await subscription.aclose()

    failed = await SessionTurnRepository().latest("session-1", "user-1")
    assert failed is not None
    assert failed.status is TurnStatus.FAILED
    assert failed.error == "RuntimeError: agent failed: (caused by TimeoutError)"
    assert failed.user_input.text == "do work"
    assert failed.input_tokens == 2


async def test_agent_invocation_cancels_during_context_setup(
    invocation_repo,
    session_events,
) -> None:
    """Task ownership starts before context setup and removes an empty Root Turn."""
    started = asyncio.Event()

    class BlockingLlms:
        async def resolve(self, user, model):
            started.set()
            await asyncio.Event().wait()

    invocation = AgentInvocation(BlockingLlms(), session_events, SystemEventBroker())
    await invocation.arun("session-1", "start")
    await started.wait()
    assert invocation.is_running("session-1")
    assert await invocation.cancel("session-1") is True
    for _ in range(20):
        if not invocation.is_running("session-1"):
            break
        await asyncio.sleep(0)
    assert not invocation.is_running("session-1")
    assert await SessionTurnRepository().latest("session-1", "user-1") is None


async def test_child_session_isolates_history_and_shares_workspace(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A Child has its own Turn sequence and explicit parent provenance."""
    import src.amphi_agent._invocation as invocation_module

    turns = SessionTurnRepository()
    await turns.append_result(
        "user-1",
        session_id="session-1",
        expected_tail_id=None,
        user_input=UserInput(text="parent goal"),
        ota_records=[],
        agent_state={},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="parent answer",
        error=None,
        input_tokens=0,
        output_tokens=0,
    )

    contexts = []
    loaded_turn_ids = []

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            contexts.append((context, ota_context))
            loaded_turn_ids.append([turn.id for turn in context.session.get_all()])
            if len(contexts) == 1:
                ota_context.transition_interaction(AwaitingFeedback(
                    questions=[{"question": "Approve?", "options": []}],
                    request_id="req-child",
                ))
                ota_context.input_tokens = 2
                ota_context.output_tokens = 1
                return ota_context.interaction_status
            else:
                previous = context.session.get_all()[-1]
                context.session = context.session.without_last()
                ota_context.user_input = previous.user_input
                ota_context.transition_interaction(None)
                ota_context.input_tokens = 3
                ota_context.output_tokens = 4
                return "child done"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    sessions = SessionRepository()
    child = await sessions.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    parent = await sessions.load("session-1", "user-1")
    assert parent is not None
    assert child.parent_session_id == parent.id
    assert child.parent_call_id == "call-child"
    assert child.workspace_root == parent.workspace_root

    workspace_root = Path(parent.workspace_root)
    root_file = workspace_root / "root.txt"
    child_file = workspace_root / "child.txt"
    root_file.write_text("root")
    child_file.write_text("child")
    mounts = SessionMountRepository()
    root_mount = await mounts.create(
        parent.id,
        "user-1",
        name=root_file.name,
        abs_path=str(root_file),
        kind="file",
    )
    child_mount = await mounts.create(
        child.id,
        "user-1",
        name=child_file.name,
        abs_path=str(child_file),
        kind="file",
    )

    task = await invocation.arun(child.id, "child goal")
    parked = await task
    assert parked.outcome.parked
    assert contexts[0][0].session.get_all() == []
    assert contexts[0][0].session.id == child.id
    assert contexts[0][0].session.is_child is True
    assert contexts[0][0].session.parent_session_id == parent.id
    assert contexts[0][0].session.subagent_mode is SubAgentMode.BLOCKING
    assert str(contexts[0][0].workspace.session_root) == parent.workspace_root
    assert contexts[0][0].workspace.reference_map(
        [root_mount.id, child_mount.id],
    ) == {
        root_mount.id: str(root_file),
        child_mount.id: str(child_file),
    }
    parent_history = await turns.list_conversation("user-1", "session-1")
    assert [turn.user_input.text for turn in parent_history] == ["parent goal"]

    task = await invocation.arun(child.id, "yes")
    completed = await task
    assert completed.outcome.answer == "child done"
    assert loaded_turn_ids[1] == [parked.turn_id]
    assert contexts[1][0].session.get_all() == []
    current = await SessionTurnRepository().latest(child.id, "user-1")
    assert current is not None
    assert current.id != parked.turn_id
    assert current.user_input.text == "child goal"
    assert current.input_tokens == 5 and current.output_tokens == 5


async def test_agent_invocation_persists_cancelled_turn_before_first_completed_round(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """Cancellation owns the live task and checkpoints its user-visible Turn."""
    import src.amphi_agent._invocation as invocation_module

    started = asyncio.Event()

    class BlockingAgent:
        final_answer = ""

        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            ota_context._current_record().think_result = {
                "step_content": "partial answer",
                "tool_calls": [],
            }
            started.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(invocation_module, "AmphiAgent", BlockingAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    subscription = session_events.subscribe("session-1")
    terminal_event = asyncio.create_task(anext(subscription))
    await asyncio.sleep(0)
    await invocation.arun("session-1", "wait")
    await started.wait()
    assert await invocation.cancel("session-1") is True
    assert isinstance(await terminal_event, CancelledEvent)
    await subscription.aclose()
    assert not invocation.is_running("session-1")
    cancelled = await SessionTurnRepository().latest("session-1", "user-1")
    assert cancelled is not None
    assert cancelled.status is TurnStatus.CANCELLED
    assert cancelled.user_input.text == "wait"
    assert cancelled.ota_records[0]["think_result"]["step_content"] == "partial answer"


async def test_agent_invocation_preserves_build_state_when_cancelled_before_first_round(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A Build initialized before its first completed round remains resumable."""
    import src.amphi_agent._invocation as invocation_module

    real_agent = AmphiAgent()
    started = asyncio.Event()
    stages = []

    class BlockingBuildAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            await real_agent.init_state(ota_context, context)
            if not isinstance(ota_context.think_status, BuildStageState):
                ota_context.open_record()
                ota_context.action_result = ActionResult(results=[ActionStepResult(
                    tool_id="request-build-start",
                    tool_name="request_build",
                    tool_arguments={
                        "goal": "create report",
                        "mode": "start",
                    },
                    tool_result=RequestBuild("create report", mode="start"),
                    success=True,
                )])
                async for _ in real_agent.after_action(ota_context, context):
                    pass
            assert isinstance(ota_context.think_status, BuildStageState)
            stages.append(ota_context.think_status.stage)
            if len(stages) == 1:
                started.set()
                await asyncio.Event().wait()
            return "resumed"

    monkeypatch.setattr(invocation_module, "AmphiAgent", BlockingBuildAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    first = await invocation.arun("session-1", WsChatMessage(
        session_id="session-1",
        input="/build create report",
        blocks=[
            {"type": "slash", "id": "build", "label": "构建"},
            {"type": "text", "value": " create report"},
        ],
    ))
    started_waiter = asyncio.create_task(started.wait())
    done, _ = await asyncio.wait(
        {first, started_waiter},
        return_when=asyncio.FIRST_COMPLETED,
    )
    if first in done:
        await first
    await started_waiter

    assert await invocation.cancel("session-1") is True
    cancelled = await SessionTurnRepository().latest("session-1", "user-1")
    assert cancelled is not None
    assert cancelled.status is TurnStatus.CANCELLED
    assert cancelled.agent_state["think"] == {"mode": "build", "stage": "clarify"}

    resumed = await invocation.arun("session-1", "continue from here")
    result = await resumed
    assert result.outcome.answer == "resumed"
    assert stages == ["clarify", "clarify"]


async def test_agent_invocation_rejects_a_second_running_turn(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """The Invocation boundary enforces one active task per Session."""
    from src.amphi_agent import InvocationStateError

    import src.amphi_agent._invocation as invocation_module

    started = asyncio.Event()

    class BlockingAgent:
        final_answer = ""

        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            started.set()
            await asyncio.Event().wait()

    monkeypatch.setattr(invocation_module, "AmphiAgent", BlockingAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    await invocation.arun("session-1", "first")
    await started.wait()

    with pytest.raises(InvocationStateError, match="already running"):
        await invocation.arun(
            "session-1",
            "second",
        )
    assert await invocation.cancel("session-1") is True
    cancelled = await SessionTurnRepository().latest("session-1", "user-1")
    assert cancelled is not None
    assert cancelled.status is TurnStatus.CANCELLED
    assert cancelled.user_input.text == "first"


async def test_invocation_trace_limit_fails_turn(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    import src.amphi_agent._invocation as invocation_module

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            ota_context.ota_record = [OTARecord(observation_result="x" * 256)]
            ota_context.input_tokens = 1
            ota_context.output_tokens = 1
            return "done"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(
        FakeLlms(),
        session_events,
        SystemEventBroker(),
    )
    monkeypatch.setattr(AgentInvocation, "MAX_OTA_CONTEXT_BYTES", 64)
    task = await invocation.arun("session-1", "large trace")
    with pytest.raises(InvocationTraceLimitError, match="exceeded 64 bytes"):
        await task
    failed = await SessionTurnRepository().latest("session-1", "user-1")
    assert failed is not None
    assert failed.status is TurnStatus.FAILED
    assert failed.error == "Invocation OTA context exceeded 64 bytes"
    assert failed.user_input.text == "large trace"


async def test_session_turn_result_write_validates_and_replaces_tail(
    invocation_repo,
) -> None:
    """Repository executes the caller-selected tail operation atomically."""
    turns = SessionTurnRepository()

    def values(text: str) -> dict:
        return {
            "session_id": "session-1",
            "user_input": UserInput(text=text),
            "ota_records": [],
            "agent_state": {},
            "browser_tool_loaded": False,
            "workspace_tools_loaded": False,
            "skills_tool_loaded": False,
            "status": TurnStatus.COMPLETED,
            "final_answer": text,
            "error": None,
            "input_tokens": 1,
            "output_tokens": 1,
        }

    first = await turns.append_result(
        "user-1",
        expected_tail_id=None,
        **values("first"),
    )
    with pytest.raises(RuntimeError, match="tail changed"):
        await turns.append_result(
            "user-1",
            expected_tail_id=None,
            **values("stale append"),
        )

    replacement = await turns.replace_tail_result(
        "user-1",
        expected_tail_id=first.id,
        **values("replacement"),
    )
    records = await turns.list_conversation("user-1", "session-1")
    assert replacement.id != first.id
    assert [record.id for record in records] == [replacement.id]
    assert replacement.session_ordinal == 0


async def test_agent_collects_subagent_calls_as_one_dispatch() -> None:
    """The Agent returns one serializable batch without starting Child work itself."""
    action = ActionResult(results=[ActionStepResult(
        tool_id="call-a",
        tool_name="run_subagent",
        tool_arguments={"goal": "task a"},
        tool_result=SubagentRequest(goal="task a"),
        success=True,
    ), ActionStepResult(
        tool_id="call-b",
        tool_name="run_subagent",
        tool_arguments={"goal": "task b"},
        tool_result=SubagentRequest(goal="task b"),
        success=True,
    )])
    ota_context = AmphiOTAContext(user_input="parent goal")
    ota_context.action_result = action
    ota_context.ota_record = [OTARecord(
        action_result=action,
        permission=RoundPermission(execution_mode="full"),
    )]
    async for _ in AmphiAgent().after_action(
        ota_context,
        AmphiContext(execution_mode="request"),
    ):
        pass

    assert ota_context.interaction_status is None
    waiting = ota_context.subagent_status
    assert isinstance(waiting, AwaitingSubAgent)
    assert [
        (call.tool_call_id, call.goal, call.execution_mode)
        for call in waiting.calls
    ] == [("call-a", "task a", "full"), ("call-b", "task b", "full")]
    assert len({call.session_id for call in waiting.calls}) == 2
    assert [
        step.tool_result for step in ota_context.ota_record[0].action_result.results
    ] == [
        "Sub-agent dispatch accepted. The parent Agent will pause until every requested sub-agent finishes.",
        "Sub-agent dispatch accepted. The parent Agent will pause until every requested sub-agent finishes.",
    ]
    ota_context.model_dump(mode="json", exclude={"stream", "tools"})


def test_pending_subagent_batch_requires_unique_tool_call_ids() -> None:
    with pytest.raises(ValueError, match="duplicate tool call ids"):
        AwaitingSubAgent(calls=[
            SubAgentCall(
                session_id="session-child-a",
                tool_call_id="call-duplicate",
                goal="task a",
            ),
            SubAgentCall(
                session_id="session-child-b",
                tool_call_id="call-duplicate",
                goal="task b",
            ),
        ])


def test_subagent_call_accepts_legacy_data_without_an_execution_mode() -> None:
    call = SubAgentCall.model_validate({
        "session_id": "session-child",
        "tool_call_id": "call-child",
        "goal": "legacy task",
    })

    assert call.execution_mode is None


async def test_agent_starts_a_background_subagent_without_parking() -> None:
    """The background tool resolves to a Child id while the parent keeps running."""
    calls = []

    class FakeInvocations:
        async def start_subagent(self, parent_session_id, call):
            calls.append((parent_session_id, call))
            return call.session_id

    action = ActionResult(results=[ActionStepResult(
        tool_id="call-child",
        tool_name="start_subagent",
        tool_arguments={"goal": "background task"},
        tool_result=BackgroundSubagentRequest(goal="background task"),
        success=True,
    )])
    ota_context = AmphiOTAContext(user_input="parent goal")
    ota_context.action_result = action
    ota_context.ota_record = [OTARecord(
        action_result=action,
        permission=RoundPermission(execution_mode="full"),
    )]
    context = AmphiContext(
        session=Session(SessionRecord(
            id="session-1",
            user_id="user-1",
            workspace_root="/tmp/session-1",
        )),
        invocations=FakeInvocations(),
        execution_mode="request",
    )

    async for _ in AmphiAgent().after_action(ota_context, context):
        pass

    assert ota_context.subagent_status is None
    assert len(calls) == 1
    parent_session_id, call = calls[0]
    assert parent_session_id == "session-1"
    assert (call.tool_call_id, call.goal, call.execution_mode) == (
        "call-child", "background task", "full",
    )
    assert ota_context.ota_record[0].action_result.results[0].tool_result == (
        f"Background sub-agent session `{call.session_id}` started. "
        "It will continue independently; do not wait for its result."
    )


async def test_subagent_scheduler_forwards_the_call_execution_mode(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    parent = await SessionRepository().load("session-1", "user-1")
    assert parent is not None
    call = SubAgentCall.create(
        "call-child",
        "delegated task",
        execution_mode="full",
    )
    child = SessionRecord(
        id=call.session_id,
        user_id="user-1",
        workspace_root=parent.workspace_root,
        parent_session_id=parent.id,
        parent_call_id=call.tool_call_id,
        subagent_mode=SubAgentMode.BLOCKING,
    )
    scheduled: list[tuple[str, str, str | None]] = []

    async def arun(session_id, user_input, *, execution_mode=None):
        scheduled.append((session_id, user_input, execution_mode))
        return None

    monkeypatch.setattr(invocation, "arun", arun)

    await invocation._schedule_subagents(parent, [(child, call)])

    assert scheduled == [(child.id, "delegated task", "full")]
    await invocation.shutdown()


async def test_parent_agent_folds_a_completed_subagent_batch() -> None:
    """An internal completion replaces every held tool result in the parent OTA."""
    action = ActionResult(results=[ActionStepResult(
        tool_id="call-child",
        tool_name="run_subagent",
        tool_arguments={"goal": "focused task"},
        tool_result="Sub-agent dispatch accepted. The parent Agent is waiting for it to finish.",
        success=True,
    )])
    parked = AmphiOTAContext(user_input="parent goal")
    parked.ota_record = [OTARecord(action_result=action)]
    parked.transition_subagents(AwaitingSubAgent(calls=[SubAgentCall(
        session_id="session-child",
        tool_call_id="call-child",
        goal="focused task",
    )]))

    session_record = SessionRecord(
        id="session-1",
        user_id="user-1",
        workspace_root="/tmp/session-1",
    )
    session_history = make_session_turns([(
        UserInput(text="parent goal", blocks=[]),
        parked.model_dump(mode="json", exclude={"stream", "tools"}),
    )])
    resumed = AmphiOTAContext(user_input=SubAgentsCompleted(
        results=[SubAgentResult(
            tool_call_id="call-child",
            status="completed",
            answer="child answer",
        )],
    ))
    resumed_context = AmphiContext(
        session=Session(session_record, turns=session_history),
    )
    await AmphiAgent().init_state(resumed, resumed_context)
    assert resumed.interaction_status is None
    assert resumed.subagent_status is None
    assert render_input(resumed.user_input) == "parent goal"
    folded = resumed.ota_record[0].action_result["results"][0]
    assert folded["tool_result"] == "Sub-agent completed successfully.\n\nchild answer"


async def test_invocation_runs_subagents_concurrently_and_rejoins_parent(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """The parent parks durably, Children run together, then its tail is replaced."""
    import src.amphi_agent._invocation as invocation_module

    real_agent = AmphiAgent()
    child_sessions = set()
    all_children_started = asyncio.Event()
    release_children = asyncio.Event()

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            if context.session.id != "session-1":
                child_sessions.add(context.session.id)
                if len(child_sessions) == 2:
                    all_children_started.set()
                await asyncio.wait_for(all_children_started.wait(), timeout=1)
                await asyncio.wait_for(release_children.wait(), timeout=1)
                return f"completed {render_input(ota_context.user_input)}"

            if isinstance(ota_context.user_input, SubAgentsCompleted):
                await real_agent.init_state(ota_context, context)
                return "joined child results"

            action = ActionResult(results=[
                ActionStepResult(
                    tool_id="call-a",
                    tool_name="run_subagent",
                    tool_arguments={"goal": "task a"},
                        tool_result="Sub-agent dispatch accepted.",
                    success=True,
                ),
                ActionStepResult(
                    tool_id="call-b",
                    tool_name="run_subagent",
                    tool_arguments={"goal": "task b"},
                        tool_result="Sub-agent dispatch accepted.",
                    success=True,
                ),
            ])
            ota_context.action_result = action
            ota_context.ota_record = [OTARecord(action_result=action)]
            waiting = AwaitingSubAgent(calls=[
                SubAgentCall(session_id="session-child-a", tool_call_id="call-a", goal="task a"),
                SubAgentCall(session_id="session-child-b", tool_call_id="call-b", goal="task b"),
            ])
            ota_context.transition_subagents(waiting)
            return waiting

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    parent_events = []
    parent_final = asyncio.Event()

    async def collect_parent_events() -> None:
        async for event in session_events.subscribe("session-1"):
            parent_events.append(event)
            if isinstance(event, FinalEvent):
                parent_final.set()

    collector = asyncio.create_task(collect_parent_events())
    await asyncio.sleep(0)

    task = await invocation.arun("session-1", "delegate both tasks")
    parked = await task
    assert parked.outcome.disposition is InvocationDisposition.AWAITING_SUBAGENTS
    await asyncio.sleep(0)
    assert not any(isinstance(event, FinalEvent) for event in parent_events)
    await asyncio.wait_for(all_children_started.wait(), timeout=1)
    parked_turn = await SessionTurnRepository().latest("session-1", "user-1")
    assert parked_turn is not None
    assert parked_turn.status is TurnStatus.AWAITING_SUBAGENTS
    parent_session = await SessionRepository().load("session-1", "user-1")
    assert parent_session is not None
    assert parent_session.status is SessionStatus.FINISH
    assert parked_turn.agent_state is not None
    waiting = AwaitingSubAgent.model_validate(parked_turn.agent_state.get("subagents"))
    assert {
        (call.tool_call_id, call.goal)
        for call in waiting.calls
    } == {("call-a", "task a"), ("call-b", "task b")}
    assert {call.session_id for call in waiting.calls} == child_sessions
    children = await SessionRepository().list_children("user-1", "session-1")
    assert {child.subagent_mode for child in children} == {SubAgentMode.BLOCKING}
    release_children.set()

    for _ in range(200):
        current = await SessionTurnRepository().latest("session-1", "user-1")
        if current is not None and current.status is TurnStatus.COMPLETED:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("parent did not resume after its Child batch completed")

    turns = await SessionTurnRepository().list_conversation("user-1", "session-1")
    assert len(turns) == 1
    assert turns[0].user_input.text == "delegate both tasks"
    assert turns[0].final_answer == "joined child results"
    assert (turns[0].agent_state or {}).get("subagents") is None
    results = turns[0].ota_context_dump()["ota_record"][0]["action_result"]["results"]
    assert {result["tool_result"] for result in results} == {
        "Sub-agent completed successfully.\n\ncompleted task a",
        "Sub-agent completed successfully.\n\ncompleted task b",
    }
    await asyncio.wait_for(parent_final.wait(), timeout=1)
    assert [
        event.answer for event in parent_events if isinstance(event, FinalEvent)
    ] == ["joined child results"]
    assert len((await SessionRepository().list_tree("user-1", "session-1"))[1:]) == 2
    collector.cancel()
    await asyncio.gather(collector, return_exceptions=True)
    await invocation.shutdown()


async def test_stopping_parent_with_two_running_children_does_not_race_join(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """Cancelling a parked parent suppresses concurrent Child join callbacks."""
    import src.amphi_agent._invocation as invocation_module

    child_sessions: set[str] = set()
    all_children_started = asyncio.Event()
    never_release_children = asyncio.Event()
    parent_resumed = asyncio.Event()

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            if context.session.id != "session-1":
                child_sessions.add(context.session.id)
                if len(child_sessions) == 2:
                    all_children_started.set()
                await never_release_children.wait()
                return "unexpected child completion"

            if isinstance(ota_context.user_input, SubAgentsCompleted):
                parent_resumed.set()
                raise AssertionError("a cancelled parent must not receive Child completion")

            action = ActionResult(results=[
                ActionStepResult(
                    tool_id="call-a",
                    tool_name="run_subagent",
                    tool_arguments={"goal": "task a"},
                    tool_result="Sub-agent dispatch accepted.",
                    success=True,
                ),
                ActionStepResult(
                    tool_id="call-b",
                    tool_name="run_subagent",
                    tool_arguments={"goal": "task b"},
                    tool_result="Sub-agent dispatch accepted.",
                    success=True,
                ),
            ])
            ota_context.action_result = action
            ota_context.ota_record = [OTARecord(action_result=action)]
            waiting = AwaitingSubAgent(calls=[
                SubAgentCall(
                    session_id="session-child-a",
                    tool_call_id="call-a",
                    goal="task a",
                ),
                SubAgentCall(
                    session_id="session-child-b",
                    tool_call_id="call-b",
                    goal="task b",
                ),
            ])
            ota_context.transition_subagents(waiting)
            return waiting

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    parent_task = await invocation.arun("session-1", "delegate then stop")
    parked = await parent_task
    assert parked.outcome.disposition is InvocationDisposition.AWAITING_SUBAGENTS
    await asyncio.wait_for(all_children_started.wait(), timeout=1)

    assert await invocation.cancel("session-1") is True
    await asyncio.sleep(0.05)

    parent_turn = await SessionTurnRepository().latest("session-1", "user-1")
    assert parent_turn is not None
    assert parent_turn.status is TurnStatus.CANCELLED
    assert not parent_resumed.is_set()
    assert not invocation.is_running("session-1")
    child_turns = await asyncio.gather(*(
        SessionTurnRepository().latest(child_id, "user-1")
        for child_id in child_sessions
    ))
    assert all(
        turn is not None and turn.status is TurnStatus.CANCELLED
        for turn in child_turns
    )
    await invocation.shutdown()


async def test_background_subagent_outlives_its_parent_turn(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A background Child keeps running after its parent returns normally."""
    import src.amphi_agent._invocation as invocation_module

    child_started = asyncio.Event()
    release_child = asyncio.Event()
    child_id = None

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            nonlocal child_id
            if context.session.id == "session-1":
                call = SubAgentCall(
                    session_id="session-background-child",
                    tool_call_id="call-child",
                    goal="background task",
                )
                child_id = await context.invocations.start_subagent("session-1", call)
                return "parent completed"
            child_started.set()
            await release_child.wait()
            return "background completed"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    parent_task = await invocation.arun("session-1", "start background work")
    parent = await parent_task
    await asyncio.wait_for(child_started.wait(), timeout=1)
    assert parent.outcome.answer == "parent completed"
    assert child_id is not None and invocation.is_running(child_id)
    parent_turn = await SessionTurnRepository().latest("session-1", "user-1")
    assert parent_turn is not None
    assert (parent_turn.agent_state or {}).get("subagents") is None

    child = await SessionRepository().load(child_id, "user-1")
    assert child is not None
    assert child.parent_session_id == "session-1"
    assert child.parent_call_id == "call-child"
    assert child.subagent_mode is SubAgentMode.BACKGROUND

    release_child.set()
    for _ in range(100):
        child_turn = await SessionTurnRepository().latest(child_id, "user-1")
        if child_turn is not None and child_turn.status is TurnStatus.COMPLETED:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("background Child did not complete")
    assert child_turn.final_answer == "background completed"
    await invocation.shutdown()


async def test_recover_resumes_a_parent_with_terminal_children(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """Startup recovery joins an already-terminal durable Child batch."""
    import src.amphi_agent._invocation as invocation_module

    child = await SessionRepository().create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    await UserRepository().set_execution_mode("user-1", "request")
    action = ActionResult(results=[ActionStepResult(
        tool_id="call-child",
        tool_name="run_subagent",
        tool_arguments={"goal": "recover child"},
        tool_result="Sub-agent dispatch accepted. The parent Agent is waiting for it to finish.",
        success=True,
    )])
    turns = SessionTurnRepository()
    await turns.append_result(
        "user-1",
        session_id="session-1",
        expected_tail_id=None,
        user_input=UserInput(text="delegate before restart"),
        ota_records=[OTARecord(action_result=action).model_dump(mode="json")],
        agent_state={
            "think": {"mode": "normal", "stage": "main"},
            "interaction": None,
            "subagents": AwaitingSubAgent(calls=[SubAgentCall(
                session_id=child.id,
                tool_call_id="call-child",
                goal="recover child",
            )]).model_dump(mode="json"),
        },
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_SUBAGENTS,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
        execution_mode="full",
    )
    await turns.append_result(
        "user-1",
        session_id=child.id,
        expected_tail_id=None,
        user_input=UserInput(text="recover child"),
        ota_records=[],
        agent_state={"think": {"mode": "normal", "stage": "main"}},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="child survived restart",
        error=None,
        input_tokens=1,
        output_tokens=1,
    )

    real_agent = AmphiAgent()

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            assert isinstance(ota_context.user_input, SubAgentsCompleted)
            assert context.execution_mode == "full"
            await real_agent.init_state(ota_context, context)
            return "parent recovered"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())
    await invocation.recover()

    for _ in range(100):
        parent_turn = await SessionTurnRepository().latest("session-1", "user-1")
        if parent_turn is not None and parent_turn.status is TurnStatus.COMPLETED:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("recovered parent did not resume")
    assert parent_turn.final_answer == "parent recovered"
    assert parent_turn.execution_mode == "full"
    assert (parent_turn.agent_state or {}).get("subagents") is None
    assert len(await turns.list_conversation("user-1", "session-1")) == 1
    await invocation.shutdown()


async def test_cancelling_a_parked_child_resumes_parent_when_batch_is_terminal(
    invocation_repo,
    session_events,
    monkeypatch,
) -> None:
    """A user-stopped parked Child becomes terminal and releases its parent."""
    import src.amphi_agent._invocation as invocation_module

    sessions = SessionRepository()
    turns = SessionTurnRepository()
    completed_child = await sessions.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-completed",
        subagent_mode=SubAgentMode.BLOCKING,
        title="completed child",
    )
    parked_child = await sessions.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-parked",
        subagent_mode=SubAgentMode.BLOCKING,
        title="parked child",
    )
    action = ActionResult(results=[
        ActionStepResult(
            tool_id="call-completed",
            tool_name="run_subagent",
            tool_arguments={"goal": "completed child"},
            tool_result="Sub-agent dispatch accepted.",
            success=True,
        ),
        ActionStepResult(
            tool_id="call-parked",
            tool_name="run_subagent",
            tool_arguments={"goal": "parked child"},
            tool_result="Sub-agent dispatch accepted.",
            success=True,
        ),
    ])
    waiting = AwaitingSubAgent(calls=[
        SubAgentCall(
            session_id=completed_child.id,
            tool_call_id="call-completed",
            goal="completed child",
        ),
        SubAgentCall(
            session_id=parked_child.id,
            tool_call_id="call-parked",
            goal="parked child",
        ),
    ])
    await turns.append_result(
        "user-1",
        session_id="session-1",
        expected_tail_id=None,
        user_input=UserInput(text="delegate"),
        ota_records=[OTARecord(action_result=action).model_dump(mode="json")],
        agent_state={
            "think": {"mode": "normal", "stage": "main"},
            "interaction": None,
            "subagents": waiting.model_dump(mode="json"),
        },
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_SUBAGENTS,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    await turns.append_result(
        "user-1",
        session_id=completed_child.id,
        expected_tail_id=None,
        user_input=UserInput(text="completed child"),
        ota_records=[],
        agent_state={"think": {"mode": "normal", "stage": "main"}},
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="finished result",
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    await turns.append_result(
        "user-1",
        session_id=parked_child.id,
        expected_tail_id=None,
        user_input=UserInput(text="parked child"),
        ota_records=[],
        agent_state={
            "think": {"mode": "normal", "stage": "main"},
            "interaction": {"questions": [{"question": "Need input"}]},
            "subagents": None,
        },
        browser_tool_loaded=False,
        workspace_tools_loaded=False,
        skills_tool_loaded=False,
        status=TurnStatus.AWAITING_HUMAN,
        final_answer=None,
        error=None,
        input_tokens=1,
        output_tokens=1,
    )

    real_agent = AmphiAgent()

    class FakeAgent:
        def __init__(self, max_rounds, verbose):
            pass

        async def generate_session_title(self, **kwargs):
            return None

        async def arun(self, *, llm, context, ota_context):
            assert isinstance(ota_context.user_input, SubAgentsCompleted)
            await real_agent.init_state(ota_context, context)
            return "parent resumed after cancellation"

    monkeypatch.setattr(invocation_module, "AmphiAgent", FakeAgent)
    invocation = AgentInvocation(FakeLlms(), session_events, SystemEventBroker())

    assert await invocation.cancel(parked_child.id) is True
    for _ in range(100):
        parent_turn = await turns.latest("session-1", "user-1")
        if parent_turn is not None and parent_turn.status is TurnStatus.COMPLETED:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("parent did not resume after the final parked Child was cancelled")

    cancelled_turn = await turns.latest(parked_child.id, "user-1")
    assert cancelled_turn is not None
    assert cancelled_turn.status is TurnStatus.CANCELLED
    assert (cancelled_turn.agent_state or {}).get("interaction") is None
    assert parent_turn.final_answer == "parent resumed after cancellation"
    results = parent_turn.ota_context_dump()["ota_record"][0]["action_result"]["results"]
    by_call = {result["tool_id"]: result for result in results}
    assert by_call["call-completed"]["success"] is True
    assert by_call["call-parked"]["success"] is False
    assert "cancelled" in by_call["call-parked"]["tool_result"]
    await invocation.shutdown()


async def test_remove_session_tree_deletes_active_workflow_space_and_preserves_terminal_results(
    invocation_repo,
    session_events,
    tmp_path,
    monkeypatch,
) -> None:
    """Deleting a Session tree removes only its Workspace-owned active Run."""
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    sessions = SessionRepository()
    child = await sessions.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.RPC,
        session_id="session-child",
    )
    owner = await sessions.load("session-1", "user-1")
    assert owner is not None
    _workspace, space = await _create_workspace_run(
        Path(owner.workspace_root),
        tmp_path / "workflow-source",
    )
    assert space.root == Path(owner.workspace_root) / ".work" / ".run"
    assert space.root.is_dir()
    result_id = "wfr_remove_completed"
    terminal_space = await _create_terminal_run(result_id)

    browser_host = _BrowserHostSpy()
    invocation = AgentInvocation(
        FakeLlms(), session_events, SystemEventBroker(), browser_host=browser_host,
    )
    assert await invocation.remove_session_tree("session-1") == 2
    assert len(browser_host.released) == 1
    assert set(browser_host.released[0]) == {"session-1", child.id}
    assert await sessions.load("session-1", "user-1") is None
    assert await sessions.load(child.id, "user-1") is None
    assert not space.root.exists()
    terminal = await WorkflowRunRepository().get("user-1", result_id)
    assert terminal is not None and terminal.status is WorkflowRunStatus.COMPLETED
    assert (terminal_space.result_dir / "result.txt").is_file()


async def test_deleting_child_session_preserves_run_owned_by_root(
    invocation_repo,
    session_events,
    tmp_path,
) -> None:
    sessions = SessionRepository()
    child = await sessions.create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.RPC,
        session_id="session-child",
    )
    root = await sessions.load("session-1", "user-1")
    assert root is not None
    _workspace, space = await _create_workspace_run(
        Path(root.workspace_root),
        tmp_path / "workflow-source",
    )

    browser_host = _BrowserHostSpy()
    invocation = AgentInvocation(
        FakeLlms(), session_events, SystemEventBroker(), browser_host=browser_host,
    )

    assert await invocation.remove_session_tree(child.id) == 1
    assert browser_host.released == [(child.id,)]
    assert space.root.is_dir()
    assert await sessions.load(root.id, "user-1") is not None


async def test_reset_session_deletes_active_workflow_space_and_preserves_terminal_results(
    invocation_repo,
    session_events,
    tmp_path,
    monkeypatch,
) -> None:
    """Reset deletes local Runs while preserving published global outcomes."""
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "published"))
    runs = WorkflowRunRepository()
    child = await SessionRepository().create_child(
        "user-1",
        parent_session_id="session-1",
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.RPC,
        session_id="session-child",
    )
    _workspace, active_space = await _create_workspace_run(
        tmp_path / "session-1",
        tmp_path / "workflow-source",
    )
    assert active_space.root == tmp_path / "session-1" / ".work" / ".run"
    assert active_space.root.is_dir()
    result_id = "wfr_reset_completed"
    completed_space = await _create_terminal_run(result_id)

    browser_host = _BrowserHostSpy()
    invocation = AgentInvocation(
        FakeLlms(), session_events, SystemEventBroker(), browser_host=browser_host,
    )
    assert await invocation.reset_session("session-1") is True
    assert len(browser_host.released) == 1
    assert set(browser_host.released[0]) == {"session-1", child.id}
    assert await SessionRepository().load("session-1", "user-1") is not None
    assert await SessionRepository().load(child.id, "user-1") is None
    completed = await runs.get("user-1", result_id)
    assert not active_space.root.exists()
    assert completed is not None and completed.status is WorkflowRunStatus.COMPLETED
    assert (completed_space.result_dir / "result.txt").is_file()


def test_subagent_tool_is_available() -> None:
    """The subagent tool is available to every invoked Agent."""
    ota_context = AmphiOTAContext(user_input="x")
    tools = {
        tool.tool_name for tool in MainThink().select_tools(ota_context, AmphiContext())
    }
    assert "run_subagent" in tools
    assert "start_subagent" in tools
