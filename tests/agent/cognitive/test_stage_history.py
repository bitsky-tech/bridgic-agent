"""Regression contracts for Session-wide storage and stage-owned prompt views."""

import json
from copy import deepcopy

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import ToolCallBlock, ToolResultBlock

from src.amphi_agent import AmphiAgent, AmphiOTAContext, MainThink
from src.amphi_agent._cognitive import _covered_rounds, _project_rounds
from src.amphi_agent._state import AgentState, BuildStageState, ContextCompactionState, NormalStageState
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_store import SessionTurnRecord, TurnStatus, UserInput
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


@pytest.mark.parametrize("mode,stage", [("normal", "main"), ("build", "verify"), ("run_workflow", "execute")])
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
    await worker._prepare_context_window(messages, next_turn.tools, next_turn, historical_context)
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


@pytest.mark.parametrize("mode,stage", [("normal", "main"), ("build", "clarify"), ("build", "verify"), ("run_workflow", "execute")])
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
    worker = MainThink()
    clarify = _serialized(await worker.assemble_messages(current, context))
    assert "CLARIFY SUMMARY" in clarify and "CLARIFY RECENT" in clarify
    assert "Need the missing decision" in clarify
    assert "CLARIFY COVERED" not in clarify and "EXPLORE PRIVATE" not in clarify and "NORMAL PRIVATE" not in clarify
    current.transition_think(BuildStageState(stage="explore"))
    explore = _serialized(await worker.assemble_messages(current, context))
    assert "EXPLORE PRIVATE" in explore and "CLARIFY SUMMARY" not in explore
    current.transition_think(BuildStageState(stage="clarify"))
    assert _serialized(await worker.assemble_messages(current, context)) == clarify
    assert current.model_dump(mode="json", exclude={"tools"}) == before


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
    covered = _covered_rounds(records, ("build", "clarify"), compaction.turn["build"]["clarify"])
    assert covered == {1, 2}
    assert [item.number for item in _project_rounds(records, ("build", "clarify")) if item.number not in covered] == [3]


@pytest.mark.parametrize("status", ["started", "resumed", "restarted", "pending"])
def test_workflow_entry_shares_resolution_not_normal_trace(status: str) -> None:
    record = _round("normal", "main", "PRIVATE NORMAL TRACE")
    record.action_result = {"results": [{
        "tool_name": "request_run_workflow", "success": True,
        "tool_arguments": {"reason": "Use the existing Run"},
        "tool_result": {"workflow_id": "workflow-a", "status": status},
    }]}
    projected = _project_rounds([record], ("run_workflow", "execute"))
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
    text = str(_project_rounds([record], ("build", "clarify"))[0].record)
    assert "Turn the earlier task into a reusable workflow" in text
    assert "PRIVATE NORMAL TRACE" not in text
