from collections import deque
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Message

from src.amphi_agent import (
    AmphiAgent,
    AmphiContext,
    AmphiOTAContext,
    ContextUsageBreakdown,
    ContextWindowExceededError,
    LlmProvider,
    MainThink,
    Session,
)
from src.amphi_agent._cognitive import ClarifyThink, ExploreThink, VerifyThink
from src.amphi_agent._state import BuildStageState, NormalStageState, WorkflowStageState
from src.amphi_agent.prompts.compaction import (
    render_session_compaction_prompt,
    render_turn_compaction_prompt,
)
from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


def test_summary_prompts_pin_the_note_language() -> None:
    """Final summary-language instruction:

    {
      "en_locale": "Write the note in English",
      "zh_locale": "Write the note in Chinese"
    }

    Checks:
    1. Both summary prompts name the active locale's language for the note — a summary
       re-enters later context as assistant history, and an unsteered summarizer mirrors
       the chunk's language, turning one polluted stretch of history into a durable
       language signal (the same pressure the Build-language fix removed).
    2. The quoted source material keeps its original form regardless of the note language.
    """
    for locale, expected, other in (("en", "English", "Chinese"), ("zh", "Chinese", "English")):
        with use_locale(locale):
            prompts = (
                render_session_compaction_prompt("prev note", "history chunk"),
                render_turn_compaction_prompt("prev note", "the request", "history chunk"),
            )
        for prompt in prompts:
            # Check 1: The note language follows the active locale.
            assert f"Write the note in {expected}" in prompt
            assert f"Write the note in {other}" not in prompt
            # Check 2: Quoted source material stays exact.
            assert "original language" in prompt


class SummaryLlm:
    """Record internal summary calls and return scripted text or failures."""

    def __init__(self, *responses: str | BaseException) -> None:
        self.responses = deque(responses)
        self.calls: list[list[Message]] = []

    async def stream_turn(self, messages, tools, *, publish, extra_body=None):
        assert tools is None
        self.calls.append(deepcopy(messages))
        response = self.responses.popleft()
        if isinstance(response, BaseException):
            raise response
        return StreamResult(
            tool_calls=[],
            content=response,
            usage=SimpleNamespace(input_tokens=5, output_tokens=2),
        )


class EventStream:
    """Collect transient compaction lifecycle events."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def publish(self, event: str, **payload: Any) -> None:
        self.events.append((event, payload))


def _turn(session_id: str, ordinal: int, content: str) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=f"turn-{ordinal}",
        user_id="local",
        session_id=session_id,
        session_ordinal=ordinal,
        user_input=UserInput(text=f"Session question {ordinal}: {content}"),
        ota_records=[{
            "think_result": {
                "step_content": f"Session answer {ordinal}: {content}",
                "tool_calls": [],
            },
        }],
        agent_state={},
        status=TurnStatus.COMPLETED,
    )


def _context(root: str, turns: list[SessionTurnRecord], capacity: int) -> AmphiContext:
    record = SessionRecord(
        id="session-compaction-policy",
        user_id="local",
        workspace_root=root,
    )
    return AmphiContext(
        session=Session(record, turns),
        llm_provider=LlmProvider(
            model_id="compaction-model",
            model_limits={"input": capacity},
        ),
    )


def _record_usage(worker: MainThink, ota: AmphiOTAContext, context: AmphiContext, counts: tuple[int, int]) -> None:
    provider_input, estimate = counts
    result = StreamResult(content="Completed round", tool_calls=[], usage=SimpleNamespace(input_tokens=provider_input, output_tokens=3))
    worker._record_model_usage(ota, context, result, estimate, ContextUsageBreakdown(dynamic_context_tokens=estimate))


def test_usage_references_follow_stage_visits_without_changing_display(test_sandbox: IsolatedPaths) -> None:
    """Each stage owns its calibration; visiting it does not rewrite the latest UI snapshot."""
    context = _context(str(test_sandbox.sessions / "usage-scopes"), [], 200_000)
    ota = AmphiOTAContext(stream=EventStream())
    worker = MainThink()
    visits = [
        (NormalStageState(), (150_000, 100_000), 30_000),
        (BuildStageState(stage="generate"), (190_000, 190_000), 20_000),
        (BuildStageState(stage="verify"), (80_000, 40_000), 40_000),
        (WorkflowStageState(workflow_id="workflow", generation="generation"), (100_000, 80_000), 25_000),
    ]
    for status, counts, expected in visits:
        ota.transition_think(status)
        assert worker._project_context_usage(ota, 20_000, context.llm_provider.model_id) == (20_000, "estimated")
        _record_usage(worker, ota, context, counts)
        assert worker._project_context_usage(ota, 20_000, context.llm_provider.model_id) == (expected, "provider")
    latest = ota.context_usage.model_dump(mode="json")
    events = deepcopy(ota.stream.events)
    for status, _, expected in visits:
        ota.transition_think(status)
        assert worker._project_context_usage(ota, 20_000, context.llm_provider.model_id) == (expected, "provider")
    assert ota.context_usage.model_dump(mode="json") == latest
    assert ota.stream.events == events
    assert len(events) == len(visits)
    assert ota.context_usage.input_tokens == sum(counts[0] for _, counts, _ in visits)
    assert ota.context_usage.output_tokens == 3 * len(visits)


@pytest.mark.parametrize("provider_input,old_estimate,new_estimate,expected", [
    (190_000, 190_000, 20_000, 20_000),
    (190_000, 100_000, 20_000, 38_000),
    (90_000, 100_000, 20_000, 20_000),
    (190_000, 100_000, 120_000, 228_000),
])
def test_usage_projection_tracks_growth_and_shrinkage(test_sandbox: IsolatedPaths, provider_input: int, old_estimate: int, new_estimate: int, expected: int) -> None:
    """Calibrate today's prompt size rather than retaining yesterday's absolute occupancy."""
    context = _context(str(test_sandbox.sessions / "usage-size"), [], 200_000)
    ota = AmphiOTAContext()
    worker = MainThink()
    _record_usage(worker, ota, context, (provider_input, old_estimate))
    assert worker._project_context_usage(ota, new_estimate, context.llm_provider.model_id) == (expected, "provider")
    assert ota.context_usage.used_tokens == provider_input


def test_missing_provider_usage_does_not_overwrite_a_measured_reference(test_sandbox: IsolatedPaths) -> None:
    """An estimated UI snapshot must not masquerade as a new provider calibration."""
    context = _context(str(test_sandbox.sessions / "missing-counter"), [], 200_000)
    ota = AmphiOTAContext()
    worker = MainThink()
    _record_usage(worker, ota, context, (80_000, 40_000))
    previous = ota.context_usage.model_dump(mode="json")
    result = StreamResult(content="No usage this time", tool_calls=[], usage=None)
    worker._record_model_usage(ota, context, result, 20_000, ContextUsageBreakdown(dynamic_context_tokens=20_000))
    assert ota.context_usage.source == "estimated"
    assert ota.context_usage.used_tokens == 20_000
    assert ota.context_usage.model_dump(mode="json")["stage_references"] == previous["stage_references"]
    assert worker._project_context_usage(ota, 10_000, context.llm_provider.model_id) == (20_000, "provider")
    assert ota.context_usage.input_tokens == previous["input_tokens"]
    assert ota.context_usage.output_tokens == previous["output_tokens"]


@pytest.mark.parametrize("reference", ["foreign_stage", "shrinking_stage", "legacy", "other_model", "zero_estimate"])
async def test_small_stage_does_not_compact_from_an_unrelated_high_water_mark(test_sandbox: IsolatedPaths, reference: str) -> None:
    """Both the preflight and compactor guard must reject a stale 95% trigger."""
    records = []
    for index in range(6):
        record = OTARecord(think_result={"step_content": f"Verify {index}: " + "Known verification facts. " * 100, "tool_calls": []})
        record.think_scope = {"mode": "build", "stage": "verify", "session_history": "stage_scoped_v2"}
        records.append(record)
    context = _context(str(test_sandbox.sessions / "small-stage"), [], 200_000)
    ota = AmphiOTAContext(user_input="Continue", ota_record=records, state={"think": {"mode": "build", "stage": "verify"}})
    llm = SummaryLlm("Unnecessary summary")
    worker = VerifyThink(llm)
    if reference == "foreign_stage":
        ota.transition_think(BuildStageState(stage="generate"))
    _record_usage(worker, ota, context, (190_000, 0 if reference == "zero_estimate" else 190_000))
    ota.transition_think(BuildStageState(stage="verify"))
    if reference == "legacy":
        # Old snapshots have no reliable owner: the final Think cursor may already have switched.
        dump = ota.context_usage.model_dump(mode="json")
        dump.pop("stage_references", None)
        ota.context_usage = type(ota.context_usage).model_validate(dump)
    elif reference == "other_model":
        context.llm_provider = LlmProvider(model_id="other-model", model_limits={"input": 200_000})
    messages = await worker.assemble_messages(ota, context)
    messages = await worker.append_runtime_state(messages, ota, context)
    tools = [spec.to_tool() for spec in ota.tools]
    estimate = worker._estimate_request_tokens(messages, tools)
    assert estimate < 100_000
    prepared, _ = await worker._prepare_context_window(messages, tools, ota, context)
    assert prepared == messages
    assert await worker.compact_messages(messages, tools, ota, context, target=120_000) == messages
    assert not llm.calls
    assert ota.state.context_compaction is None
    assert ota.context_usage.used_tokens == 190_000


async def test_current_stage_calibration_still_compacts_and_does_not_retrigger(test_sandbox: IsolatedPaths) -> None:
    """A real 95% same-stage reference triggers once; the smaller rebuilt request can fall below it."""
    records = []
    for index in range(6):
        record = OTARecord(think_result={"step_content": f"Verify {index}: " + "Known verification facts. " * 100, "tool_calls": []})
        record.think_scope = {"mode": "build", "stage": "verify", "session_history": "stage_scoped_v2"}
        records.append(record)
    context = _context(str(test_sandbox.sessions / "large-stage"), [], 200_000)
    ota = AmphiOTAContext(user_input="Continue", ota_record=records, state={"think": {"mode": "build", "stage": "verify"}})
    llm = SummaryLlm("Earlier verification facts")
    worker = VerifyThink(llm)
    messages = await worker.assemble_messages(ota, context)
    messages = await worker.append_runtime_state(messages, ota, context)
    tools = [spec.to_tool() for spec in ota.tools]
    estimate = worker._estimate_request_tokens(messages, tools)
    _record_usage(worker, ota, context, (190_000, estimate))
    references = deepcopy(ota.context_usage.stage_references)
    rebuilt, reduced_estimate = await worker._prepare_context_window(messages, tools, ota, context)
    assert len(llm.calls) == 1
    assert ota.state.context_compaction.turn["build"]["verify"].turn_covered_rounds == [1, 2]
    assert reduced_estimate < estimate
    assert worker._project_context_usage(ota, reduced_estimate, context.llm_provider.model_id)[0] < 190_000
    assert ota.context_usage.stage_references == references
    assert ota.context_usage.used_tokens == 190_000
    await worker._prepare_context_window(rebuilt, tools, ota, context)
    assert len(llm.calls) == 1


@pytest.mark.parametrize("status", [TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.CANCELLED])
async def test_stage_usage_references_survive_new_turns(test_sandbox: IsolatedPaths, status: TurnStatus) -> None:
    """Durable references survive terminal Turns while actual token totals still reset."""
    context = _context(str(test_sandbox.sessions / "usage-resume"), [], 200_000)
    ota = AmphiOTAContext()
    worker = MainThink()
    _record_usage(worker, ota, context, (150_000, 100_000))
    ota.transition_think(BuildStageState(stage="verify"))
    _record_usage(worker, ota, context, (80_000, 40_000))
    ota.transition_think(NormalStageState())
    previous = _turn(context.session.id, 0, "Previous turn")
    previous.status = status
    previous.agent_state = ota.state.model_dump(mode="json")
    previous.context_usage = ota.context_usage.model_dump(mode="json")
    context = _context(str(test_sandbox.sessions / "usage-resume"), [previous], 200_000)
    current = AmphiOTAContext(user_input="Continue")
    await AmphiAgent().init_state(current, context)
    assert current.context_usage.input_tokens == current.context_usage.output_tokens == 0
    assert worker._project_context_usage(current, 20_000, context.llm_provider.model_id) == (30_000, "provider")
    current.transition_think(BuildStageState(stage="verify"))
    assert worker._project_context_usage(current, 20_000, context.llm_provider.model_id) == (40_000, "provider")


async def test_compacts_session_and_turn_together_while_protecting_recent_suffixes(test_sandbox: IsolatedPaths) -> None:
    """One trigger summarizes both eligible prefixes and retains four raw units per scope."""
    content = "material history " * 200
    turns = [_turn("session-compaction-policy", index, content) for index in range(6)]
    records = [
        OTARecord(think_result={
            "step_content": f"Current round {index}: {content}",
            "tool_calls": [],
        })
        for index in range(6)
    ]
    llm = SummaryLlm("Compacted Session facts", "Compacted current-Turn progress")
    worker = MainThink(llm)
    stream = EventStream()
    ota_context = AmphiOTAContext(
        user_input="Continue the current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
        ota_record=records,
        stream=stream,
    )
    context = _context(str(test_sandbox.sessions / "both-scopes"), turns, 200_000)
    original = await worker.assemble_messages(ota_context, context)

    compacted = await worker.compact_messages(original, [], ota_context, context, target=1)

    state = ota_context.state.context_compaction
    assert state is not None
    assert state.session["normal"]["main"].session_summary == "Compacted Session facts"
    assert state.session["normal"]["main"].session_through_ordinal == 1
    turn_state = state.turn["normal"]["main"]
    assert turn_state.turn_summary == "Compacted current-Turn progress"
    assert turn_state.turn_through_round == 2
    assert turn_state.turn_covered_rounds == [1, 2]
    assert len(llm.calls) == 2
    assert all(call[0].content.startswith("You turn historical agent context") for call in llm.calls)
    assert all("substantially shorter" in call[0].content for call in llm.calls)
    assert all("Aim for at most" not in call[1].content for call in llm.calls)
    contents = [message.content for message in compacted]
    assert not any("Session question 0" in content for content in contents)
    assert not any("Session question 1" in content for content in contents)
    assert any("Session question 2" in content for content in contents)
    assert not any("Current round 0" in content for content in contents)
    assert not any("Current round 1" in content for content in contents)
    assert any("Current round 2" in content for content in contents)
    assert worker._estimate_request_tokens(compacted, []) > 1
    assert worker.spent_tokens == 14
    assert ota_context.context_usage.input_tokens == 10
    assert ota_context.context_usage.output_tokens == 4
    assert stream.events == [
        ("context_compaction", {"active": True}),
        ("context_compaction", {"active": False}),
    ]


async def test_turn_compaction_is_isolated_by_mode_and_stage(test_sandbox: IsolatedPaths) -> None:
    """Build stages retain independent summaries and projected round boundaries."""
    class ContextFreeExploreThink(ExploreThink):
        async def build_context_blocks(self, ota_context, context, *artifact_names):
            return []

    class ContextFreeClarifyThink(ClarifyThink):
        async def build_context_blocks(self, ota_context, context, *artifact_names):
            return []

    def record(stage: str, index: int) -> OTARecord:
        round_ = OTARecord(think_result={
            "step_content": f"{stage.title()} round {index}: " + "stage history " * 200,
            "tool_calls": [],
        })
        round_.think_scope = {"mode": "build", "stage": stage}
        return round_

    records = [
        *[record("clarify", index) for index in range(6)],
        *[record("explore", index) for index in range(6)],
    ]
    worker = ContextFreeExploreThink(SummaryLlm("Compacted Explore history"))
    ota_context = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
        ota_record=records,
        state={"think": {"mode": "build", "stage": "explore"}},
    )
    context = _context(str(test_sandbox.sessions / "stage-scopes"), [], 200_000)
    original = await worker.assemble_messages(ota_context, context)

    await worker.compact_messages(original, [], ota_context, context, target=1)

    compaction = ota_context.state.context_compaction
    assert compaction is not None
    assert set(compaction.turn) == {"build"}
    assert set(compaction.turn["build"]) == {"explore"}
    explore_state = compaction.turn["build"]["explore"]
    assert explore_state.turn_summary == "Compacted Explore history"
    assert explore_state.turn_through_round == 2
    assert explore_state.turn_covered_rounds == [7, 8]

    ota_context.ota_record.append(record("clarify", 6))
    ota_context.transition_think(BuildStageState(stage="clarify"))
    clarify_messages = await ContextFreeClarifyThink().assemble_messages(ota_context, context)
    clarify_contents = [message.content for message in clarify_messages]
    assert not any("Compacted Explore history" in content for content in clarify_contents)
    assert any("Clarify round 0" in content for content in clarify_contents)

    ota_context.ota_record.append(record("explore", 6))
    ota_context.transition_think(BuildStageState(stage="explore"))
    explore_messages = await worker.assemble_messages(ota_context, context)
    explore_contents = [message.content for message in explore_messages]
    assert any("Compacted Explore history" in content for content in explore_contents)
    assert not any("Explore round 0" in content for content in explore_contents)
    assert any("Explore round 2" in content for content in explore_contents)


async def test_initial_build_stage_compaction_boundary_survives_stage_reentry(test_sandbox: IsolatedPaths) -> None:
    """The first Build stage keeps one stable projected-round coordinate system."""
    class ContextFreeClarifyThink(ClarifyThink):
        async def build_context_blocks(self, ota_context, context, *artifact_names):
            return []

    def record(mode: str, stage: str, index: int) -> OTARecord:
        round_ = OTARecord(think_result={
            "step_content": f"{mode}/{stage} round {index}: " + "stage history " * 200,
            "tool_calls": [],
        })
        round_.think_scope = {"mode": mode, "stage": stage}
        return round_

    records = [
        record("normal", "main", 0),
        *[record("build", "clarify", index) for index in range(6)],
    ]
    llm = SummaryLlm("Compacted Clarify history")
    worker = ContextFreeClarifyThink(llm)
    ota_context = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
        ota_record=records,
        state={"think": {"mode": "build", "stage": "clarify"}},
    )
    context = _context(str(test_sandbox.sessions / "initial-stage-reentry"), [], 200_000)
    original = await worker.assemble_messages(ota_context, context)

    await worker.compact_messages(original, [], ota_context, context, target=1)

    compaction = ota_context.state.context_compaction
    assert compaction is not None
    clarify_state = compaction.turn["build"]["clarify"]
    assert clarify_state.turn_through_round == 2
    assert clarify_state.turn_covered_rounds == [2, 3]
    assert "normal/main round 0" not in llm.calls[0][1].content

    handoff = record("build", "explore", 0)
    handoff.action_result = ActionResult(results=[ActionStepResult(
        tool_id="call-explore-to-clarify",
        tool_name="switch",
        tool_arguments={"stage": "clarify"},
        tool_result={"stage": "clarify"},
    )])
    ota_context.ota_record.extend([handoff, record("build", "clarify", 6)])
    ota_context.transition_think(BuildStageState(stage="clarify"))

    messages = await worker.assemble_messages(ota_context, context)
    contents = [message.content for message in messages]
    assert any("Compacted Clarify history" in content for content in contents)
    assert not any("build/clarify round 0" in content for content in contents)
    assert not any("build/explore round 0" in content for content in contents)
    assert any("[stage handoff]" in content for content in contents)
    assert any("build/clarify round 2" in content for content in contents)


async def test_summary_input_is_bounded_when_one_atomic_turn_is_huge(test_sandbox: IsolatedPaths) -> None:
    """An oversized Turn is truncated as one marked unit before reaching the summary model."""
    huge = "X" * 200_000
    turns = [_turn("session-compaction-policy", 0, huge)] + [
        _turn("session-compaction-policy", index, "recent")
        for index in range(1, 5)
    ]
    llm = SummaryLlm("Bounded Session summary")
    worker = MainThink(llm)
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
    )
    context = _context(str(test_sandbox.sessions / "bounded-input"), turns, 20_000)
    original = await worker.assemble_messages(ota_context, context)

    await worker.compact_messages(original, [], ota_context, context, target=1)

    assert len(llm.calls) == 1
    assert worker._estimate_request_tokens(llm.calls[0], []) <= 10_000
    assert "bytes omitted during compaction" in llm.calls[0][1].content
    assert ota_context.state.context_compaction is not None
    assert ota_context.state.context_compaction.session["normal"]["main"].session_through_ordinal == 0


async def test_summary_failure_uses_a_bounded_fallback_and_advances(test_sandbox: IsolatedPaths) -> None:
    """A failed internal model call cannot leave the same eligible prefix stuck forever."""
    content = "recoverable history " * 200
    turns = [_turn("session-compaction-policy", index, content) for index in range(5)]
    worker = MainThink(SummaryLlm(RuntimeError("summary unavailable")))
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
    )
    context = _context(str(test_sandbox.sessions / "fallback"), turns, 100_000)
    original = await worker.assemble_messages(ota_context, context)

    compacted = await worker.compact_messages(original, [], ota_context, context, target=1)

    state = ota_context.state.context_compaction
    assert state is not None
    assert state.session["normal"]["main"].session_through_ordinal == 0
    assert state.session["normal"]["main"].session_summary
    assert worker._estimate_request_tokens(compacted, []) < worker._estimate_request_tokens(original, [])


async def test_protected_context_over_hard_capacity_fails_before_provider_call(test_sandbox: IsolatedPaths) -> None:
    """The soft target is best-effort, but the model's hard input capacity is enforced."""
    worker = MainThink()
    stream = EventStream()
    ota_context = AmphiOTAContext(user_input="Current request", stream=stream)
    context = _context(str(test_sandbox.sessions / "hard-capacity"), [], 500)
    messages = [Message.from_text("X" * 4_000)]

    with pytest.raises(ContextWindowExceededError) as raised:
        await worker.compact_messages(messages, [], ota_context, context, target=100)

    assert raised.value.input_capacity == 500
    assert raised.value.estimated_tokens > 500
    assert stream.events == [
        ("context_compaction", {"active": True}),
        ("context_compaction", {"active": False}),
    ]
