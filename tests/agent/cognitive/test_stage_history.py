"""Regression contracts for Session-wide storage and stage-owned prompt views."""

import asyncio
import json
from copy import deepcopy

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Message, ToolCallBlock, ToolResultBlock

from src.amphi_agent import AmphiAgent, AmphiOTAContext, MainThink
from src.amphi_agent.cognitive import ClarifyThink, ExploreThink, GenerateThink, PresentationBriefThink, PresentationThink, VerifyThink
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.presentation.state import PresentationStageState
from src.amphi_agent.cognitive.state import AgentState, ContextCompactionState
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools.ppt import RequestPresentation
from src.amphi_store import SessionMountRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive.test_compaction import SummaryLlm, _context


def _round(mode: str, stage: str, text: str) -> OTARecord:
    result = OTARecord(
        think_result={"step_content": text, "tool_calls": [{"tool": "read_file", "arguments": {"file_path": "history.txt"}}]},
        action_result=ActionResult(results=[ActionStepResult(tool_id="", tool_name="read_file", tool_arguments={"file_path": "history.txt"}, tool_result=text)]),
    )
    result.think_scope = {"mode": mode, "stage": stage, "session_history": "stage_scoped_v2"}
    return result


def _turn(ordinal: int, records: list[OTARecord], state: AgentState, status: TurnStatus = TurnStatus.COMPLETED) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=f"turn-{ordinal}", user_id="local", session_id="session-compaction-policy", session_ordinal=ordinal,
        user_input=UserInput(text=f"Request {ordinal}"), status=status,
        ota_records=[record.model_dump(mode="json") for record in records], agent_state=state.model_dump(mode="json"),
    )


def _serialized(messages) -> str:
    return str([message.model_dump(mode="json") for message in messages])


@pytest.mark.parametrize("mode,stage", [("normal", "main"), ("build", "verify"), ("run_workflow", "execute"), ("presentation", "ppt_review")])
@pytest.mark.parametrize("status", [TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.CANCELLED])
async def test_compacted_turn_tail_does_not_expand_in_session_history(test_sandbox: IsolatedPaths, mode: str, stage: str, status: TurnStatus) -> None:
    """A protected large-argument round keeps the same bounded replay in the next Turn."""
    think = {"mode": mode, "stage": stage}
    if mode == "run_workflow":
        think.update(workflow_id="workflow-a", generation="generation-a")
    state = AgentState.model_validate({"think": think, "context_compaction": {"turn": {mode: {stage: {
        "turn_summary": "EARLIER ROUND SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [1],
    }}}}})
    large = "x" * 120_000
    args = {"file_path": "generated.txt", "content": large}
    retained = _round(mode, stage, "Write the artifact")
    retained.think_result["tool_calls"] = [{"tool": "write_file", "arguments": args}]
    retained.action_result = ActionResult(results=[ActionStepResult(
        tool_id="write-result", tool_name="write_file", tool_arguments=args, tool_result="Wrote generated.txt",
    )])
    retained.reasoning_content = "Private reasoning must not enter Session history"
    current = AmphiOTAContext(user_input="Write", state=state, ota_record=[_round(mode, stage, "COVERED RAW"), retained])
    current.tools = TOOL_LIBRARY.select(["write_file"])
    context = _context(str(test_sandbox.sessions / "bounded-replay"), [], 50_000)
    llm = SummaryLlm()
    worker = MainThink(llm)
    live = worker.turn_messages_block(current, context)
    previous = _turn(0, current.ota_record, state, status)
    raw_before = deepcopy(previous.model_dump(mode="json"))
    historical_context = _context(str(test_sandbox.sessions / "bounded-replay"), [previous], 50_000)
    next_turn = AmphiOTAContext(user_input="Continue", state={"think": think})
    next_turn.tools = current.tools
    history = await worker.session_messages_block(next_turn, historical_context)
    replay = history[1:3]
    assert [message.blocks for message in replay] == [message.blocks for message in live]
    assert all(not message.extras for message in replay)
    assert large not in _serialized(history)
    assert "COVERED RAW" not in _serialized(history)
    assert "120000 characters" in _serialized(history)
    assert "Wrote generated.txt" in _serialized(history)
    assert previous.model_dump(mode="json") == raw_before
    # A new request must fit without trying to compact the protected last Turn.
    messages = await worker.assemble_messages(next_turn, historical_context)
    await worker.compact_messages(messages, next_turn.tools, next_turn, historical_context)
    assert not llm.calls


@pytest.mark.parametrize("case", ["safe", "oversized", "structured", "missing", "partial", "steps_only", "choice", "large_choice"])
async def test_session_tool_replay_matches_completed_action_steps(test_sandbox: IsolatedPaths, case: str) -> None:
    """Use executed arguments, preserve every completed pair, and omit old reasoning."""
    args = {"file_path": "actual.txt", "content": "small"}
    if case == "oversized":
        args["content"] = "x" * 1201
    elif case == "structured":
        args["content"] = {"nested": "x" * 1201}
    elif case == "missing":
        args.pop("file_path")
    tool_name = "write_file"
    if case in {"choice", "large_choice"}:
        question = {"header": "Choice", "question": "Choose an option", "options": [
            {"label": f"Option {i}", "description": "d" * (200 if case == "large_choice" else 1)} for i in range(3)
        ]}
        args = {"questions": json.dumps([question] * (3 if case == "large_choice" else 1)), "prompt": "Choose the next action"}
        tool_name = "request_human_choice"
    record = _round("normal", "main", "Executed tools")
    record.think_result["tool_calls"] = [
        {"tool": "write_file", "arguments": {"file_path": "unrepaired.txt", "content": "z" * 120_000}},
        {"tool": "read_file", "arguments": {"file_path": "actual.txt"}},
    ]
    record.action_result = ActionResult(results=[
        ActionStepResult(tool_id="write-id", tool_name=tool_name, tool_arguments=args, tool_result="" if "choice" in case else "written"),
        ActionStepResult(tool_id="read-id", tool_name="read_file", tool_arguments={"file_path": "actual.txt"}, tool_result=None, success=False, error="read failed"),
    ])
    if case == "partial":
        record.action_result.results.pop()
    elif case == "steps_only":
        record.think_result["tool_calls"] = []
    record.reasoning_content = "Private reasoning"
    record.thought_signatures = ["signature"] * len(record.action_result.results)
    current = AmphiOTAContext(user_input="Act", ota_record=[record])
    current.tools = TOOL_LIBRARY.select(["write_file", "read_file", "request_human_choice"])
    previous = _turn(0, [record], current.state)
    before = deepcopy(previous.model_dump(mode="json"))
    context = _context(str(test_sandbox.sessions / "same-tool-round"), [previous], 100_000)
    worker = MainThink()
    live = worker.turn_messages_block(current, context)
    history = (await worker.session_messages_block(current, context))[1:]
    assert [message.blocks for message in history] == [message.blocks for message in live]
    assert all(not message.extras for message in history)
    assert "unrepaired.txt" not in _serialized(history)
    assert previous.model_dump(mode="json") == before
    calls = [block for message in history for block in message.blocks if isinstance(block, ToolCallBlock)]
    results = [block for message in history for block in message.blocks if isinstance(block, ToolResultBlock)]
    assert [call.id for call in calls] == [result.id for result in results]
    assert len(calls) == (0 if case in {"oversized", "structured", "missing", "large_choice"} else 1 if case == "partial" else 2)


@pytest.mark.parametrize("mode,stage", [("normal", "main"), ("build", "clarify"), ("build", "verify"), ("run_workflow", "execute"), ("presentation", "ppt_brief")])
@pytest.mark.parametrize("status", [TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.CANCELLED])
async def test_new_turn_keeps_stage_session_summary_and_compacted_tail(test_sandbox: IsolatedPaths, mode: str, stage: str, status: TurnStatus) -> None:
    """Terminal Turns start a fresh loop, retaining every stage's Session checkpoint."""
    think = {"mode": mode, "stage": stage}
    if mode == "run_workflow":
        think.update(workflow_id="workflow-a", generation="generation-a")
    state = AgentState.model_validate({
        "think": think,
        "context_compaction": {
            "session": {mode: {stage: {"session_summary": "OLDER STAGE SUMMARY", "session_through_ordinal": 0}}},
            "turn": {mode: {stage: {"turn_summary": "LATEST TURN SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [1]}}},
        },
    })
    turns = [
        _turn(0, [_round(mode, stage, "OLD RAW")], AgentState()),
        _turn(1, [_round(mode, stage, "COVERED RAW"), _round(mode, stage, "RETAINED RESULT")], state, status),
    ]
    context = _context(str(test_sandbox.sessions / "new-turn"), turns, 100_000)
    current = AmphiOTAContext(user_input="Continue")
    # Hydrating a Workflow requires its actual package; state propagation is
    # mode-independent, so isolate that filesystem binding from this contract.
    if mode == "run_workflow":
        turns[-1].agent_state["think"] = {"mode": "normal", "stage": "main"}
    await AmphiAgent().init_state(current, context)
    current.state.think = AgentState.model_validate({"think": think}).think
    assert current.ota_record == []
    assert current.state.context_compaction.turn == {}
    assert current.state.context_compaction.session == state.context_compaction.session
    worker = MainThink()
    messages = await worker.assemble_messages(current, context)
    text = _serialized(messages)
    assert "OLDER STAGE SUMMARY" in text
    assert "LATEST TURN SUMMARY" in text
    assert "RETAINED RESULT" in text
    assert "OLD RAW" not in text
    assert "COVERED RAW" not in text
    calls = [block for message in messages for block in message.blocks if isinstance(block, ToolCallBlock)]
    results = [block for message in messages for block in message.blocks if isinstance(block, ToolResultBlock)]
    assert len(calls) == len(results) == 1
    assert calls[0].id == results[0].id == "hist_call_1_1_0"
    current.ota_record.append(_round(mode, stage, "CURRENT ROUND"))
    assert "CURRENT ROUND" in _serialized(await worker.assemble_messages(current, context))


async def test_switch_restores_target_stage_without_reexpanding_foreign_rounds(test_sandbox: IsolatedPaths) -> None:
    records = [
        _round("normal", "main", "NORMAL PRIVATE"),
        _round("build", "clarify", "CLARIFY COVERED"),
        _round("build", "explore", "EXPLORE PRIVATE"),
        _round("build", "clarify", "CLARIFY RECENT"),
    ]
    records[2].observation_result = "[stage handoff] `build/explore` → `build/clarify`\nNeed the missing decision."
    current = AmphiOTAContext(user_input="Keep the original requirement", ota_record=records, state={
        "think": {"mode": "build", "stage": "clarify"},
        "context_compaction": {"turn": {"build": {"clarify": {
            "turn_summary": "CLARIFY SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [2],
        }}}},
    })
    context = _context(str(test_sandbox.sessions / "switch"), [], 100_000)
    before = current.model_dump(mode="json", exclude={"tools"})
    worker = ClarifyThink()
    clarify = _serialized(await worker.assemble_messages(current, context))
    assert "CLARIFY SUMMARY" in clarify and "CLARIFY RECENT" in clarify
    assert "Need the missing decision" in clarify
    assert "NORMAL PRIVATE" in clarify
    assert "CLARIFY COVERED" not in clarify and "EXPLORE PRIVATE" not in clarify
    current.transition_think(BuildStageState(stage="explore"))
    explore = _serialized(await ExploreThink().assemble_messages(current, context))
    assert "EXPLORE PRIVATE" in explore and "CLARIFY SUMMARY" not in explore
    current.transition_think(BuildStageState(stage="clarify"))
    assert _serialized(await worker.assemble_messages(current, context)) == clarify
    assert current.model_dump(mode="json", exclude={"tools"}) == before


@pytest.mark.parametrize("status", [TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.CANCELLED])
@pytest.mark.parametrize("normal_boundary,clarify_boundary", [(0, 1), (1, 0)])
async def test_clarify_reads_independently_compacted_normal_history(test_sandbox: IsolatedPaths, status: TurnStatus, normal_boundary: int, clarify_boundary: int) -> None:
    """Both Session and Turn checkpoints remain source-owned across terminal Turns."""
    state = AgentState.model_validate({
        "think": {"mode": "build", "stage": "clarify"},
        "context_compaction": {
            "session": {
                "normal": {"main": {"session_summary": "NORMAL SESSION SUMMARY", "session_through_ordinal": normal_boundary}},
                "build": {"clarify": {"session_summary": "CLARIFY SESSION SUMMARY", "session_through_ordinal": clarify_boundary}},
            },
            "turn": {
                "normal": {"main": {"turn_summary": "NORMAL TURN SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [1]}},
                "build": {"clarify": {"turn_summary": "CLARIFY TURN SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [2]}},
            },
        },
    })
    turns = [_turn(index, [
        _round("normal", "main", f"NORMAL PAST {index}"),
        _round("build", "clarify", f"CLARIFY PAST {index}"),
    ], AgentState()) for index in range(2)]
    records = [
        _round("normal", "main", "NORMAL COVERED"),
        _round("build", "clarify", "CLARIFY COVERED"),
        _round("normal", "main", "NORMAL RETAINED"),
        _round("build", "clarify", "CLARIFY RETAINED"),
        _round("build", "verify", "VERIFY PRIVATE"),
    ]
    for index, record in enumerate(records):
        record.action_result.results[0].tool_id = f"stable-call-{index}"
    current = AmphiOTAContext(user_input="Continue", state=state, ota_record=records)
    context = _context(str(test_sandbox.sessions / "shared-normal"), turns, 200_000)
    worker = ClarifyThink()
    await worker.assemble_messages(current, context)
    live = worker.turn_messages_block(current, context)
    previous = _turn(2, records, state, status)
    before = deepcopy(previous.model_dump(mode="json"))
    next_context = _context(str(test_sandbox.sessions / "shared-normal"), [*turns, previous], 200_000)
    next_turn = AmphiOTAContext(user_input="Continue again")
    await AmphiAgent().init_state(next_turn, next_context)
    await worker.assemble_messages(next_turn, next_context)
    history = await worker.session_messages_block(next_turn, next_context)
    text = _serialized(history)
    for marker in ("NORMAL SESSION SUMMARY", "CLARIFY SESSION SUMMARY", "NORMAL TURN SUMMARY", "CLARIFY TURN SUMMARY", "NORMAL RETAINED", "CLARIFY RETAINED"):
        assert marker in text
    for marker in ("NORMAL PAST 0", "CLARIFY PAST 0", "NORMAL COVERED", "CLARIFY COVERED", "VERIFY PRIVATE"):
        assert marker not in text
    assert ("NORMAL PAST 1" in text) == (normal_boundary == 0)
    assert ("CLARIFY PAST 1" in text) == (clarify_boundary == 0)
    assert sum(message.content == "Request 1" for message in history) == 1
    last_input = next(index for index, message in enumerate(history) if message.content == "Request 2")
    assert [message.blocks for message in history[last_input + 1:last_input + 1 + len(live)]] == [message.blocks for message in live]
    assert text.index("NORMAL RETAINED") < text.index("CLARIFY RETAINED")
    assert 'owner="normal/main"' in text and 'owner="build/clarify"' in text
    assert previous.model_dump(mode="json") == before
    assert next_turn.state.context_compaction.session == state.context_compaction.session
    assert next_turn.state.context_compaction.turn == {}


@pytest.mark.parametrize("cancel", [False, True])
async def test_clarify_delegates_each_history_to_its_owner_atomically(test_sandbox: IsolatedPaths, cancel: bool) -> None:
    """Normal and Clarify keep separate summaries while one coordinator commits both."""
    turns = []
    records = []
    for index in range(6):
        turns.extend([
            _turn(index * 2, [_round("normal", "main", f"NORMAL SESSION {index} " * 100)], AgentState()),
            _turn(index * 2 + 1, [_round("build", "clarify", f"CLARIFY SESSION {index} " * 100)], AgentState(think=BuildStageState(stage="clarify"))),
        ])
        records.extend([
            _round("normal", "main", f"NORMAL ROUND {index} " * 100),
            _round("build", "clarify", f"CLARIFY ROUND {index} " * 100),
        ])
    current = AmphiOTAContext(user_input="Continue", ota_record=records, state={
        "think": {"mode": "build", "stage": "clarify"},
        "context_compaction": {
            "session": {"normal": {"main": {"session_summary": "NORMAL SESSION CHECKPOINT", "session_through_ordinal": 0}}},
            "turn": {"normal": {"main": {"turn_summary": "NORMAL TURN CHECKPOINT", "turn_through_round": 1, "turn_covered_rounds": [1]}}},
        },
    })
    context = _context(str(test_sandbox.sessions / "shared-compaction"), turns, 200_000)
    llm = SummaryLlm("NORMAL SESSION SUMMARY", "NORMAL TURN SUMMARY", "CLARIFY SESSION SUMMARY", asyncio.CancelledError() if cancel else "CLARIFY TURN SUMMARY")
    worker = ClarifyThink(llm)
    original_state = current.state.model_dump(mode="json")
    original_records = deepcopy([record.model_dump(mode="json") for record in records])
    normal = current.model_copy(update={"state": current.state.model_copy(update={"think": NormalStageState()})})
    normal_before = _serialized(await MainThink().assemble_messages(normal, context))
    messages = await worker.assemble_messages(current, context)
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await worker.compact_messages(messages, [], current, context, target=1)
        assert current.state.model_dump(mode="json") == original_state
    else:
        rebuilt = await worker.compact_messages(messages, [], current, context, target=1)
        compaction = current.state.context_compaction
        assert compaction.session["build"]["clarify"].session_through_ordinal == 3
        assert compaction.turn["build"]["clarify"].turn_covered_rounds == [2, 4]
        assert compaction.session["normal"]["main"].session_through_ordinal == 2
        assert compaction.turn["normal"]["main"].turn_covered_rounds == [1, 3]
        text = _serialized(rebuilt)
        assert "NORMAL SESSION 1" not in text and "NORMAL ROUND 1" not in text
        assert "NORMAL SESSION 2" in text and "NORMAL ROUND 2" in text
        assert "CLARIFY SESSION 0" not in text and "CLARIFY ROUND 0" not in text
        assert "CLARIFY SESSION 2" in text and "CLARIFY ROUND 2" in text
    assert len(llm.calls) == 4
    assert all("CLARIFY" not in _serialized(call) for call in llm.calls[:2])
    assert all("NORMAL" not in _serialized(call) for call in llm.calls[2:])
    assert "NORMAL SESSION 1" in _serialized(llm.calls[0])
    assert "NORMAL ROUND 1" in _serialized(llm.calls[1])
    assert "CLARIFY SESSION 0" in _serialized(llm.calls[2])
    assert "CLARIFY ROUND 0" in _serialized(llm.calls[3])
    normal.state = current.state.model_copy(update={"think": NormalStageState()})
    assert (_serialized(await MainThink().assemble_messages(normal, context)) == normal_before) is cancel
    assert [record.model_dump(mode="json") for record in records] == original_records


async def test_clarify_compacts_normal_when_shared_history_exceeds_capacity(test_sandbox: IsolatedPaths) -> None:
    current = AmphiOTAContext(user_input="Clarify", state={"think": {"mode": "build", "stage": "clarify"}}, ota_record=[
        _round("normal", "main", f"NORMAL LARGE {index} " * 2_000) for index in range(8)
    ])
    context = _context(str(test_sandbox.sessions / "shared-overflow"), [], 200_000)
    llm = SummaryLlm(*["Earlier Normal requirements." for _ in range(8)])
    worker = ClarifyThink(llm)
    messages = await worker.assemble_messages(current, context)
    assert worker._estimate_request_tokens(messages, []) > 200_000
    rebuilt = await worker.compact_messages(messages, [], current, context)
    assert llm.calls
    assert worker._estimate_request_tokens(rebuilt, []) < 200_000
    assert current.think_status == BuildStageState(stage="clarify")
    assert current.state.context_compaction.turn["normal"]["main"].turn_covered_rounds == [1, 2, 3, 4]
    assert "build" not in current.state.context_compaction.turn
    calls = len(llm.calls)
    await worker.compact_messages(rebuilt, [], current, context)
    assert len(llm.calls) == calls


@pytest.mark.parametrize("mode,stage", [("normal", "main"), ("build", "explore"), ("build", "generate"), ("build", "verify"), ("run_workflow", "execute")])
async def test_clarify_sharing_does_not_change_other_stage_views(test_sandbox: IsolatedPaths, mode: str, stage: str) -> None:
    records = [_round("normal", "main", "NORMAL ONLY"), _round("build", "clarify", "CLARIFY ONLY")]
    context = _context(str(test_sandbox.sessions / "one-way-sharing"), [_turn(0, records, AgentState())], 100_000)
    think = {"mode": mode, "stage": stage}
    if mode == "run_workflow":
        think.update(workflow_id="workflow", generation="generation")
    current = AmphiOTAContext(user_input="Continue", ota_record=records, state={"think": think})
    worker = MainThink()
    text = _serialized([*await worker.session_messages_block(current, context), *worker.turn_messages_block(current, context)])
    assert "CLARIFY ONLY" not in text
    assert ("NORMAL ONLY" in text) == (mode == "normal")


@pytest.mark.parametrize("compacted", [False, True])
async def test_clarify_sharing_does_not_duplicate_or_reexpand_unscoped_legacy_rounds(test_sandbox: IsolatedPaths, compacted: bool) -> None:
    record = OTARecord(action_result=ActionResult(results=[ActionStepResult(tool_id="legacy-call", tool_name="read_file", tool_arguments={"file_path": "old.txt"}, tool_result="LEGACY OUTPUT")]))
    state = AgentState(think=BuildStageState(stage="clarify"))
    if compacted:
        state.context_compaction = ContextCompactionState(turn={"normal": {"main": {"turn_summary": "LEGACY SUMMARY", "turn_through_round": 1}}})
    current = AmphiOTAContext(user_input="Continue", state=state, ota_record=[record])
    context = _context(str(test_sandbox.sessions / "legacy-sharing"), [], 100_000)
    messages = ClarifyThink().turn_messages_block(current, context)
    calls = [block for message in messages for block in message.blocks if isinstance(block, ToolCallBlock)]
    assert len(calls) == (0 if compacted else 1)
    assert ("LEGACY OUTPUT" in _serialized(messages)) is not compacted
    assert ("LEGACY SUMMARY" in _serialized(messages)) is compacted


@pytest.mark.parametrize("summary_owner", [None, "normal", "clarify"])
async def test_clarify_keeps_owned_handoff_alongside_shared_normal_result(test_sandbox: IsolatedPaths, summary_owner: str | None) -> None:
    """Sharing adds the Normal view without replacing Clarify's existing handoff."""
    record = _round("normal", "main", "NORMAL ENTRY")
    record.action_result = ActionResult(results=[ActionStepResult(
        tool_id="build-entry", tool_name="request_build", tool_arguments={"goal": "Create the report workflow", "mode": "start"},
        tool_result={"mode": "start", "goal": "Create the report workflow", "message": "A new Build was created."},
    )])
    current = AmphiOTAContext(user_input="Build", state={"think": {"mode": "build", "stage": "clarify"}}, ota_record=[record])
    if summary_owner:
        mode, stage = ("normal", "main") if summary_owner == "normal" else ("build", "clarify")
        current.state.context_compaction = ContextCompactionState(turn={mode: {stage: {
            "turn_summary": "SOURCE SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [1],
        }}})
    worker = ClarifyThink()
    context = _context(str(test_sandbox.sessions / "shared-handoff"), [], 100_000)
    await worker.assemble_messages(current, context)
    live = worker.turn_messages_block(current, context)
    calls = [block for message in live for block in message.blocks if isinstance(block, ToolCallBlock)]
    results = [block for message in live for block in message.blocks if isinstance(block, ToolResultBlock)]
    assert len(calls) == len(results) == (0 if summary_owner == "normal" else 1)
    assert sum("[stage handoff]" in message.content for message in live) == (0 if summary_owner == "clarify" else 1)
    previous = _turn(0, [record], current.state)
    context = _context(str(test_sandbox.sessions / "shared-handoff"), [previous], 100_000)
    history = (await worker.session_messages_block(current, context))[1:]
    assert [message.blocks for message in history] == [message.blocks for message in live]


@pytest.mark.parametrize("legacy_checkpoint", [False, True])
async def test_clarify_does_not_reopen_unscoped_turns_covered_by_normal_session_summary(test_sandbox: IsolatedPaths, legacy_checkpoint: bool) -> None:
    record = OTARecord(think_result={"step_content": "COVERED LEGACY RAW", "tool_calls": []})
    previous = _turn(0, [record], AgentState())
    summary = {"session_summary": "NORMAL SESSION CHECKPOINT", "session_through_ordinal": 0}
    compaction = summary if legacy_checkpoint else {"session": {"normal": {"main": summary}}}
    current = AmphiOTAContext(user_input="Clarify", state={"think": {"mode": "build", "stage": "clarify"}, "context_compaction": compaction})
    context = _context(str(test_sandbox.sessions / "legacy-session-sharing"), [previous], 100_000)
    messages = await ClarifyThink().session_messages_block(current, context)
    assert len(messages) == 1
    assert "NORMAL SESSION CHECKPOINT" in messages[0].content
    assert "COVERED LEGACY RAW" not in _serialized(messages)
    assert "Request 0" not in _serialized(messages)
    if not legacy_checkpoint:
        # A known Clarify round in the same Turn still belongs to Clarify.
        previous.ota_records.append(_round("build", "clarify", "CLARIFY RETAINED").model_dump(mode="json"))
        messages = await ClarifyThink().session_messages_block(current, context)
        assert "CLARIFY RETAINED" in _serialized(messages)
        assert "COVERED LEGACY RAW" not in _serialized(messages)
        assert sum(message.content == "Request 0" for message in messages) == 1


async def test_normal_receives_build_exit_and_artifact_paths_not_build_logs(test_sandbox: IsolatedPaths) -> None:
    current = AmphiOTAContext(user_input="Build and report the result", ota_record=[
        _round("normal", "main", "NORMAL COVERED"),
        _round("build", "generate", "HUGE BUILD LOG " * 200),
        _round("build", "verify", "PRIVATE VERIFY TRACE"),
    ], state={"context_compaction": {"turn": {
        "normal": {"main": {"turn_summary": "NORMAL SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [1]}},
        "build": {"generate": {"turn_summary": "BUILD SUMMARY", "turn_through_round": 1, "turn_covered_rounds": [2]}},
    }}})
    AmphiAgent._stamp_mode_exit(current, BuildStageState(stage="verify"), "Validated successfully; report completion.")
    AmphiAgent._stamp_published_directory_handoff(
        current, publication="Workflow published", published_directory=test_sandbox.root / "published",
        relative_paths="workflow/WORKFLOW.md", temporary_workspace=".build",
    )
    context = _context(str(test_sandbox.sessions / "normal-return"), [], 100_000)
    text = _serialized(await MainThink().assemble_messages(current, context))
    assert "NORMAL SUMMARY" in text and "Validated successfully" in text
    assert "workflow/WORKFLOW.md" in text and str(test_sandbox.root / "published") in text
    assert "HUGE BUILD LOG" not in text and "PRIVATE VERIFY TRACE" not in text and "BUILD SUMMARY" not in text


async def test_session_retention_and_compaction_are_independent_per_stage(test_sandbox: IsolatedPaths) -> None:
    turns = []
    for index in range(12):
        stage = "clarify" if index % 2 == 0 else "explore"
        turns.append(_turn(index, [_round("build", stage, f"{stage.upper()} HISTORY {index} " * 100)], AgentState()))
    context = _context(str(test_sandbox.sessions / "session-scopes"), turns, 200_000)
    llm = SummaryLlm("CLARIFY SESSION SUMMARY", "EXPLORE SESSION SUMMARY")
    worker = MainThink(llm)
    current = AmphiOTAContext(user_input="Continue", state={"think": {"mode": "build", "stage": "clarify"}})
    before = deepcopy([turn.model_dump(mode="json") for turn in turns])
    original = await worker.assemble_messages(current, context)
    await worker.compact_messages(original, [], current, context, target=1)
    first = current.state.context_compaction.session["build"]["clarify"].model_copy(deep=True)
    assert first.session_through_ordinal == 2
    assert "CLARIFY HISTORY 0" in llm.calls[0][1].content and "CLARIFY HISTORY 2" in llm.calls[0][1].content
    assert "CLARIFY HISTORY 4" not in llm.calls[0][1].content and "EXPLORE HISTORY" not in llm.calls[0][1].content
    current.transition_think(BuildStageState(stage="explore"))
    original = await worker.assemble_messages(current, context)
    await worker.compact_messages(original, [], current, context, target=1)
    assert current.state.context_compaction.session["build"]["clarify"] == first
    assert current.state.context_compaction.session["build"]["explore"].session_through_ordinal == 3
    current.transition_think(BuildStageState(stage="clarify"))
    text = _serialized(await worker.assemble_messages(current, context))
    assert "CLARIFY SESSION SUMMARY" in text and "EXPLORE SESSION SUMMARY" not in text
    assert "CLARIFY HISTORY 0" not in text and "CLARIFY HISTORY 4" in text
    assert [turn.model_dump(mode="json") for turn in turns] == before


async def test_incremental_compaction_keeps_exact_interleaved_coverage(test_sandbox: IsolatedPaths) -> None:
    records = []
    for index in range(6):
        records.extend([_round("normal", "main", f"FOREIGN {index}"), _round("build", "verify", f"VERIFY {index} " * 200)])
    current = AmphiOTAContext(user_input="Verify", ota_record=records, state={"think": {"mode": "build", "stage": "verify"}})
    llm = SummaryLlm("First verify summary", "Second verify summary")
    worker = MainThink(llm)
    context = _context(str(test_sandbox.sessions / "incremental"), [], 200_000)
    original = await worker.assemble_messages(current, context)
    await worker.compact_messages(original, [], current, context, target=1)
    assert current.state.context_compaction.turn["build"]["verify"].turn_covered_rounds == [2, 4]
    current.ota_record.extend([_round("normal", "main", "FOREIGN LATER"), _round("build", "verify", "VERIFY LATER")])
    original = await worker.assemble_messages(current, context)
    await worker.compact_messages(original, [], current, context, target=1)
    assert current.state.context_compaction.turn["build"]["verify"].turn_covered_rounds == [2, 4, 6]
    assert "First verify summary" in llm.calls[1][1].content
    assert "VERIFY 0" not in llm.calls[1][1].content and "VERIFY 2" in llm.calls[1][1].content
    assert all("FOREIGN" not in call[1].content for call in llm.calls)


async def test_foreign_session_summary_is_not_reused_for_target_stage(test_sandbox: IsolatedPaths) -> None:
    turn = _turn(0, [_round("build", "verify", "RECOVER VERIFICATION")], AgentState())
    context = _context(str(test_sandbox.sessions / "legacy"), [turn], 100_000)
    current = AmphiOTAContext(user_input="Verify", state={
        "think": {"mode": "build", "stage": "verify"},
        "context_compaction": {"session_summary": "MIXED LEGACY SUMMARY", "session_through_ordinal": 0},
    })
    text = _serialized(await MainThink().assemble_messages(current, context))
    assert "MIXED LEGACY SUMMARY" not in text and "RECOVER VERIFICATION" in text


def test_legacy_compaction_uses_original_projection_coordinates() -> None:
    records = [_round("normal", "main", "entry"), _round("build", "clarify", "covered"), _round("build", "clarify", "keep")]
    compaction = ContextCompactionState(turn={"build": {"clarify": {"turn_summary": "Legacy", "turn_through_round": 2}}})
    covered = BaseThink._covered_rounds(records, ("build", "clarify"), compaction.turn["build"]["clarify"])
    assert covered == {1, 2}
    assert [item.number for item in BaseThink._project_rounds(records, ("build", "clarify")) if item.number not in covered] == [3]


@pytest.mark.parametrize("stage,expected_coverage", [("ppt_brief", {1, 2}), ("ppt_plan", {3, 4})])
async def test_legacy_presentation_summary_maps_local_indices_before_replay(test_sandbox: IsolatedPaths, stage: str, expected_coverage: set[int]) -> None:
    """Old PPT summaries cover their original local projection, including entry handoffs."""
    records = [
        _round("normal", "main", "NORMAL ENTRY"),
        _round("presentation", "ppt_brief", "BRIEF COVERED"),
        _round("presentation", "ppt_brief", "BRIEF HANDOFF"),
        _round("presentation", "ppt_plan", "PLAN COVERED"),
        _round("presentation", "ppt_compose", "COMPOSE PRIVATE"),
        _round("presentation", "ppt_plan", "PLAN RETAINED"),
    ]
    for index, record in enumerate(records):
        record.action_result.results[0].tool_id = f"ppt-history-{index}"
    records[2].action_result = ActionResult(results=[ActionStepResult(
        tool_id="enter-plan", tool_name="switch", tool_arguments={"stage": "ppt_plan", "reason": "The brief is ready."},
        tool_result={"stage": "ppt_plan", "reason": "The brief is ready."},
    )])
    state = AgentState(think=PresentationStageState(stage=stage), context_compaction=ContextCompactionState(turn={
        "presentation": {stage: {"turn_summary": "LEGACY PPT SUMMARY", "turn_through_round": 2}},
    }))
    summary = state.context_compaction.turn["presentation"][stage]
    assert summary.turn_covered_rounds is None
    assert BaseThink._covered_rounds(records, ("presentation", stage), summary) == expected_coverage
    current = AmphiOTAContext(user_input="Continue", ota_record=records, state=state)
    previous = _turn(0, records, state)
    before = deepcopy(previous.model_dump(mode="json"))
    context = _context(str(test_sandbox.sessions / "legacy-presentation"), [previous], 100_000)
    worker = PresentationThink()
    live = worker.turn_messages_block(current, context)
    historical = (await worker.session_messages_block(current, context))[1:]
    assert [message.blocks for message in historical] == [message.blocks for message in live]
    text = _serialized(live)
    assert "LEGACY PPT SUMMARY" in text
    assert "COMPOSE PRIVATE" not in text
    if stage == "ppt_plan":
        assert "PLAN COVERED" not in text and "PLAN RETAINED" in text
        assert "The brief is ready." not in text
    else:
        assert "BRIEF COVERED" not in text and "BRIEF HANDOFF" in text
    assert previous.model_dump(mode="json") == before
    assert summary.turn_covered_rounds is None


async def test_custom_history_policy_delegates_to_each_source(test_sandbox: IsolatedPaths) -> None:
    """Any declared read source participates in compaction through its own worker."""
    class SharedHistoryThink(BaseThink):
        def history_scopes(self, ota_context, context):
            return (("build", "explore"), *super().history_scopes(ota_context, context))

        async def assemble_messages(self, ota_context, context):
            return [
                *await self.session_messages_block(ota_context, context),
                Message.from_text(str(ota_context.user_input)),
                *self.turn_messages_block(ota_context, context),
            ]

    turns = []
    records = []
    for index in range(6):
        turns.extend([
            _turn(index * 2, [_round("build", "explore", f"FOREIGN SESSION {index} " * 100)], AgentState()),
            _turn(index * 2 + 1, [_round("presentation", "ppt_review", f"OWN SESSION {index} " * 100)], AgentState()),
        ])
        records.extend([
            _round("build", "explore", f"FOREIGN ROUND {index} " * 100),
            _round("presentation", "ppt_review", f"OWN ROUND {index} " * 100),
        ])
    current = AmphiOTAContext(user_input="Review", ota_record=records, state={
        "think": {"mode": "presentation", "stage": "ppt_review"},
        "context_compaction": {
            "session": {"build": {"explore": {"session_summary": "FOREIGN SESSION CHECKPOINT", "session_through_ordinal": 0}}},
            "turn": {"build": {"explore": {"turn_summary": "FOREIGN TURN CHECKPOINT", "turn_through_round": 1, "turn_covered_rounds": [1]}}},
        },
    })
    context = _context(str(test_sandbox.sessions / "custom-history-policy"), turns, 200_000)
    original_records = deepcopy([record.model_dump(mode="json") for record in records])
    original_turns = deepcopy([turn.model_dump(mode="json") for turn in turns])
    llm = SummaryLlm("FOREIGN SESSION SUMMARY", "FOREIGN TURN SUMMARY", "OWN SESSION SUMMARY", "OWN TURN SUMMARY")
    worker = SharedHistoryThink(llm)
    messages = await worker.assemble_messages(current, context)
    assert "FOREIGN SESSION CHECKPOINT" in _serialized(messages)
    assert "FOREIGN ROUND 1" in _serialized(messages)
    assert "FOREIGN" not in _serialized([
        *await PresentationThink().session_messages_block(current, context),
        *PresentationThink().turn_messages_block(current, context),
    ])

    rebuilt = await worker.compact_messages(messages, [], current, context, target=1)

    compaction = current.state.context_compaction
    assert compaction.session["build"]["explore"].session_through_ordinal == 2
    assert compaction.turn["build"]["explore"].turn_covered_rounds == [1, 3]
    assert compaction.session["presentation"]["ppt_review"].session_through_ordinal == 3
    assert compaction.turn["presentation"]["ppt_review"].turn_covered_rounds == [2, 4]
    assert len(llm.calls) == 4
    assert all("OWN" not in _serialized(call) for call in llm.calls[:2])
    assert all("FOREIGN" not in _serialized(call) for call in llm.calls[2:])
    text = _serialized(rebuilt)
    assert "FOREIGN SESSION 1" not in text and "FOREIGN ROUND 1" not in text
    assert "FOREIGN SESSION 2" in text and "FOREIGN ROUND 2" in text
    assert "OWN SESSION 0" not in text and "OWN ROUND 0" not in text
    assert "OWN SESSION 2" in text and "OWN ROUND 2" in text
    assert [record.model_dump(mode="json") for record in records] == original_records
    assert [turn.model_dump(mode="json") for turn in turns] == original_turns


async def test_interrupted_presentation_entry_retains_original_request_and_attachment(test_sandbox: IsolatedPaths) -> None:
    """Cancellation before Brief's first call must preserve its incoming request in history."""
    session_root = test_sandbox.sessions / "interrupted-presentation"
    context = _context(str(session_root), [], 100_000)
    attachment = test_sandbox.root / "quarterly-revenue.csv"
    attachment.write_text("quarter,revenue\nQ1,125\n", encoding="utf-8")
    mount = SessionMountRecord(
        id="presentation-input", session_id=context.session.id, user_id="local",
        name=attachment.name, abs_path=str(attachment), kind="file",
    )
    context.workspace = Workspace(context.session.id, session_root, mounts=[mount])
    requirement = "Prepare twelve slides for the executive committee using "
    user_input = UserInput(text=requirement + "@quarterly-revenue.csv", blocks=[
        {"type": "text", "value": requirement},
        {"type": "mention", "id": mount.id, "label": attachment.name, "group": ""},
    ])
    prior = _round("normal", "main", "PRIVATE NORMAL TOOL TRACE")
    entry = _round("normal", "main", "PRIVATE NORMAL ENTRY THOUGHT")
    goal = "Create an earnings presentation"
    entry.action_result = ActionResult(results=[ActionStepResult(
        tool_id="presentation-entry", tool_name="request_presentation",
        tool_arguments={"goal": goal}, tool_result=RequestPresentation(goal),
    )])
    current = AmphiOTAContext(user_input=user_input, ota_record=[prior, entry])
    await MainThink().handle_action_result(current, context, AmphiAgent())
    assert current.think_status == PresentationStageState(goal=goal)
    assert all(record.think_scope["mode"] == "normal" for record in current.ota_record)
    assert not current.ota_record[0].observation_result
    entry_note = current.ota_record[-1].observation_result
    assert "[stage handoff] `normal/main` → `presentation/ppt_brief`" in entry_note
    assert f"Presentation goal: {goal}" in entry_note

    worker = PresentationBriefThink()
    live_handoff = worker.turn_messages_block(current, context)
    handoff_text = _serialized(live_handoff)
    assert "[stage handoff]" in handoff_text and goal in handoff_text
    assert "PRIVATE NORMAL" not in handoff_text
    assert not any(isinstance(block, (ToolCallBlock, ToolResultBlock)) for message in live_handoff for block in message.blocks)

    previous = _turn(0, current.ota_record, current.state, TurnStatus.CANCELLED)
    previous.user_input = user_input
    saved = deepcopy(previous.model_dump(mode="json"))
    resumed_context = _context(str(session_root), [previous], 100_000)
    resumed_context.workspace = context.workspace
    resumed = AmphiOTAContext(user_input="Continue")
    await AmphiAgent().init_state(resumed, resumed_context)
    assert resumed.think_status == current.think_status
    assert resumed.ota_record == []

    history = await worker.session_messages_block(resumed, resumed_context)
    text = _serialized(history)
    assert requirement.strip() in text and str(attachment) in text
    assert goal in text and "[stage handoff]" in text
    assert "PRIVATE NORMAL" not in text
    assert [message.blocks for message in history[1:]] == [message.blocks for message in live_handoff]
    assert previous.model_dump(mode="json") == saved


@pytest.mark.parametrize("stage,worker_type", [("explore", ExploreThink), ("generate", GenerateThink), ("verify", VerifyThink)])
async def test_legacy_unstamped_build_entry_retains_only_original_user_input(test_sandbox: IsolatedPaths, stage: str, worker_type: type[BaseThink]) -> None:
    """A saved target cursor retains the entry request even before its first owned round."""
    session_root = test_sandbox.sessions / "legacy-edit-entry"
    attachment = test_sandbox.root / "revised-requirements.md"
    attachment.write_text("# Requirements\nKeep the original output columns.\n", encoding="utf-8")
    requirement = "Update the retained workflow without changing its output columns using "
    original_input = UserInput(text=requirement + "@revised-requirements.md", blocks=[
        {"type": "text", "value": requirement},
        {"type": "mention", "id": "edit-input", "label": attachment.name, "group": ""},
    ])
    entry = _round("normal", "main", "PRIVATE NORMAL EDIT REASONING")
    entry.action_result = ActionResult(results=[ActionStepResult(
        tool_id="legacy-edit", tool_name="edit_workflow", tool_arguments={"workflow_id": "workflow-a"},
        tool_result={"workflow_id": "workflow-a", "workflow_name": "Retained Workflow", "message": "The requested Workflow is already the active editable Build."},
    )])
    previous = _turn(0, [entry], AgentState(think=BuildStageState(stage=stage, workflow_id="workflow-a")), TurnStatus.CANCELLED)
    previous.user_input = original_input
    saved = deepcopy(previous.model_dump(mode="json"))
    context = _context(str(session_root), [previous], 100_000)
    mount = SessionMountRecord(
        id="edit-input", session_id=context.session.id, user_id="local", name=attachment.name,
        abs_path=str(attachment), kind="file",
    )
    context.workspace = Workspace(context.session.id, session_root, mounts=[mount])
    current = AmphiOTAContext(user_input="Continue the edit", state={"think": {"mode": "build", "stage": stage}})

    history = await worker_type().session_messages_block(current, context)

    assert len(history) == 1
    assert requirement.strip() in history[0].content and str(attachment) in history[0].content
    assert "PRIVATE NORMAL" not in _serialized(history)
    assert not any(isinstance(block, (ToolCallBlock, ToolResultBlock)) for message in history for block in message.blocks)
    assert previous.model_dump(mode="json") == saved
    for other_stage in {"explore", "generate", "verify"} - {stage}:
        other = current.model_copy(update={"state": AgentState(think=BuildStageState(stage=other_stage))})
        assert await worker_type().session_messages_block(other, context) == []
    for missing_think in ({}, {"think": {"mode": "build"}}, {"think": {"stage": stage}}):
        previous.agent_state = missing_think
        assert await worker_type().session_messages_block(current, context) == []


@pytest.mark.parametrize("outcome", ["entered", "failed", "error", "wrong_mode", "wrong_stage", "proposed"])
def test_presentation_handoff_requires_applied_entry_and_targets_only_brief(outcome: str) -> None:
    """An unsuccessful or unapplied request must not expose Normal history to PPT."""
    record = _round("normal", "main", "PRIVATE NORMAL TRACE")
    result = {"mode": "presentation", "stage": "ppt_brief", "goal": "Prepare the earnings deck"}
    if outcome == "wrong_mode":
        result["mode"] = "normal"
    elif outcome == "wrong_stage":
        result["stage"] = "ppt_plan"
    elif outcome == "proposed":
        result = {"goal": result["goal"]}
    record.action_result = ActionResult(results=[ActionStepResult(
        tool_id="presentation-entry", tool_name="request_presentation",
        tool_arguments={"goal": "Prepare the earnings deck"}, tool_result=result,
        success=outcome != "failed", error="Entry failed" if outcome == "error" else None,
    )])
    for stage in ("ppt_brief", "ppt_plan", "ppt_compose", "ppt_review"):
        projected = BaseThink._project_rounds([record], ("presentation", stage))
        if outcome != "entered" or stage != "ppt_brief":
            assert projected == []
            continue
        assert len(projected) == 1
        assert "Prepare the earnings deck" in str(projected[0].record)
        assert "PRIVATE NORMAL TRACE" not in str(projected[0].record)
        assert "action_result" not in projected[0].record
        assert projected[0].record["think_result"]["tool_calls"] == []


@pytest.mark.parametrize("status", ["started", "resumed", "restarted", "pending"])
def test_workflow_entry_shares_resolution_not_normal_trace(status: str) -> None:
    record = _round("normal", "main", "PRIVATE NORMAL TRACE")
    record.action_result = {"results": [{
        "tool_name": "request_run_workflow", "success": True,
        "tool_arguments": {"reason": "Use the existing Run"},
        "tool_result": {"workflow_id": "workflow-a", "status": status},
    }]}
    projected = BaseThink._project_rounds([record], ("run_workflow", "execute"))
    if status == "pending":
        assert projected == []
    else:
        text = str(projected[0].record)
        assert "Use the existing Run" in text and f"{status}." in text
        assert "PRIVATE NORMAL TRACE" not in text
        assert "action_result" not in projected[0].record


def test_confirmed_build_entry_keeps_proposed_goal() -> None:
    record = _round("normal", "main", "PRIVATE NORMAL TRACE")
    record.action_result = {"results": [{
        "tool_name": "request_build", "success": True,
        "tool_result": {"mode": "ask", "status": "confirmed", "goal": "Turn the earlier task into a reusable workflow"},
    }]}
    text = str(BaseThink._project_rounds([record], ("build", "clarify"))[0].record)
    assert "Turn the earlier task into a reusable workflow" in text
    assert "PRIVATE NORMAL TRACE" not in text


@pytest.mark.parametrize("status,action,target_stage", [
    ("resolved", "keep", "verify"),
    ("resolved", "merge", "clarify"),
    ("resolved", "replace", "clarify"),
    ("not_answered", "not_answered", "verify"),
    ("pending", None, None),
    ("cancelled", None, None),
])
def test_build_entry_hands_resolved_choice_to_actual_stage(status: str, action: str | None, target_stage: str | None) -> None:
    record = _round("normal", "main", "PRIVATE NORMAL TRACE")
    record.action_result = {"results": [{
        "tool_name": "request_build", "success": True,
        "tool_result": {
            "mode": "ask", "status": status, "action": action, "existing_stage": "verify",
            "goal": "COMPETING WORKFLOW GOAL", "message": "The user resolved the Build request.",
            "response": "the second option", "reason": "Choose how to handle the unfinished Build.",
            "questions": [{"question": "How should the new request affect this Build?", "options": [
                {"label": "Keep", "preview": "PRIVATE FULL CARD"}, {"label": "Merge requirements"}, {"label": "Replace"},
            ]}],
        },
    }]}
    before = record.model_dump(mode="json")
    for stage in ("clarify", "explore", "generate", "verify"):
        projected = BaseThink._project_rounds([record], ("build", stage))
        if stage != target_stage:
            assert projected == []
            continue
        text = projected[0].record["think_result"]["step_content"]
        assert "The user resolved the Build request." in text and "the second option" in text
        assert ("COMPETING WORKFLOW GOAL" in text) == (action in {"merge", "replace"})
        assert "PRIVATE NORMAL TRACE" not in text and "PRIVATE FULL CARD" not in text
        if status == "not_answered":
            assert "Context: Choose how to handle the unfinished Build." in text
            assert "Question: How should the new request affect this Build?" in text
            assert "Options: 1. Keep; 2. Merge requirements; 3. Replace" in text
        assert "action_result" not in projected[0].record
    assert record.model_dump(mode="json") == before
