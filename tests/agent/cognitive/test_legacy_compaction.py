"""Regression contracts for legacy summaries shared with another history owner."""

from copy import deepcopy

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import ToolCallBlock

from src.amphi_agent import AmphiOTAContext, MainThink
from src.amphi_agent.cognitive import ClarifyThink
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.state import AgentState, ContextCompactionState
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive.test_compaction import SummaryLlm, _context
from tests.agent.cognitive.test_stage_history import _turn


@pytest.fixture
def legacy_clarify_context(test_sandbox: IsolatedPaths):
    """Restore the six-round checkpoint produced by the pre-migration compactor.

    Its stage-local prefix was one Normal round and the first Clarify round;
    the remaining four Clarify rounds were protected. The old preflight accepted
    this checkpoint below the 18,000-token capacity after summarizing the prefix.
    """
    records = []
    layout = [("normal", "main", "LEGACY NORMAL PREFIX " * 4000)] + [
        ("build", "clarify", f"Clarify round {index}: short material fact") for index in range(5)
    ]
    for mode, stage, text in layout:
        record = OTARecord(think_result={"step_content": text, "tool_calls": []})
        record.think_scope = {"mode": mode, "stage": stage, "session_history": "all_stages"}
        records.append(record)
    checkpoint = {
        "session_summary": "",
        "session_through_ordinal": -1,
        "turn": {"build": {"clarify": {
            "turn_summary": "The earlier Normal requirements and first Clarify facts are complete.",
            "turn_through_round": 2,
        }}},
    }
    ota = AmphiOTAContext(user_input="Continue the workflow build", ota_record=records, state={
        "think": {"mode": "build", "stage": "clarify"},
        "context_compaction": checkpoint,
    })
    context = _context(str(test_sandbox.sessions / "legacy-clarify"), [], 18_000)
    context._cognitive_workers[("normal", "main")] = MainThink()
    return ota, context


async def test_legacy_clarify_prefix_stays_compressed_when_normal_is_shared(legacy_clarify_context) -> None:
    """A previously usable saved context must not reopen its 84,000-character prefix."""
    ota, context = legacy_clarify_context
    before = ota.model_dump(mode="json", exclude={"tools"})
    worker = ClarifyThink(SummaryLlm())

    messages = await worker.assemble_messages(ota, context)
    prepared = await worker.compact_messages(messages, [], ota, context)
    estimate = worker._estimate_request_tokens(prepared, [])

    text = str([message.content for message in prepared])
    assert "The earlier Normal requirements" in text
    assert "LEGACY NORMAL PREFIX" not in text
    assert "Clarify round 0" not in text
    assert all(f"Clarify round {index}" in text for index in range(1, 5))
    assert estimate < context.llm_provider.input_capacity()
    assert not worker._llm.calls
    assert ota.model_dump(mode="json", exclude={"tools"}) == before


async def test_legacy_raw_coverage_survives_recompaction_and_serialization(legacy_clarify_context) -> None:
    """Writing exact IDs must not forget that the old summary included raw Normal history."""
    ota, context = legacy_clarify_context
    for index in (2, 3):
        ota.ota_record[index].think_result["step_content"] += (
            "; The report must preserve account identifiers and reconcile the source totals before publishing." * 10
        )
    for index in (5, 6):
        record = OTARecord(think_result={"step_content": f"Clarify round {index}: later fact", "tool_calls": []})
        record.think_scope = {"mode": "build", "stage": "clarify", "session_history": "stage_scoped_v2"}
        ota.ota_record.append(record)
    before = deepcopy([record.model_dump(mode="json") for record in ota.ota_record])
    worker = ClarifyThink(SummaryLlm("Updated Clarify facts."))
    messages = await worker.assemble_messages(ota, context)
    assert worker._estimate_request_tokens(messages, []) < context.llm_provider.input_capacity()

    await worker.compact_messages(messages, [], ota, context, target=1)

    summary = ota.state.context_compaction.turn["build"]["clarify"]
    assert summary.turn_covered_rounds == [1, 2, 3, 4]
    assert summary.turn_covered_raw_rounds == [1, 2, 3, 4]
    assert set(ota.state.context_compaction.turn) == {"build"}
    assert len(worker._llm.calls) == 1
    assert "LEGACY NORMAL PREFIX" not in str(worker._llm.calls)
    assert [record.model_dump(mode="json") for record in ota.ota_record] == before

    restored = AmphiOTAContext(user_input=ota.user_input, ota_record=before, state=ota.state.model_dump(mode="json"))
    replay = ClarifyThink(SummaryLlm())
    prepared = await replay.compact_messages(await replay.assemble_messages(restored, context), [], restored, context)
    estimate = replay._estimate_request_tokens(prepared, [])
    text = str([message.content for message in prepared])
    assert "LEGACY NORMAL PREFIX" not in text
    assert "Updated Clarify facts." in text
    assert all(f"Clarify round {index}" in text for index in range(3, 7))
    assert estimate < context.llm_provider.input_capacity()
    assert not replay._llm.calls


@pytest.mark.parametrize("coverage", ["legacy_raw", "inferred_handoff", "explicit_handoff", "normal_raw"])
async def test_full_raw_coverage_does_not_confuse_an_incoming_handoff(test_sandbox: IsolatedPaths, coverage: str) -> None:
    """Summarizing a handoff must neither consume its source trace nor erase another handoff."""
    record = OTARecord(
        think_result={"step_content": "NORMAL SOURCE DETAIL", "tool_calls": []},
        action_result=ActionResult(results=[ActionStepResult(
            tool_id="build-entry", tool_name="request_build", tool_arguments={"goal": "Create a report", "mode": "start"},
            tool_result={"mode": "start", "goal": "Create a report", "message": "The requested Build was created."},
        )]),
    )
    record.think_scope = {"mode": "normal", "stage": "main"}
    projection = {"turn_summary": "ENTRY SUMMARY", "turn_through_round": 1}
    if coverage != "legacy_raw":
        projection["turn_covered_rounds"] = [1]
    if coverage in {"explicit_handoff", "normal_raw"}:
        projection["turn_covered_raw_rounds"] = [1] if coverage == "normal_raw" else []
    mode, stage = ("normal", "main") if coverage == "normal_raw" else ("build", "clarify")
    ota = AmphiOTAContext(user_input="Build", ota_record=[record], state={"think": {"mode": "build", "stage": "clarify"}})
    ota.state.context_compaction = ContextCompactionState(turn={mode: {stage: projection}})
    context = _context(str(test_sandbox.sessions / "handoff-coverage"), [], 100_000)

    raw = BaseThink._covered_raw_rounds(ota.ota_record, (mode, stage), ota.state.context_compaction.turn[mode][stage])
    messages = ClarifyThink().turn_messages_block(ota, context)

    text = str([message.content for message in messages])
    calls = [block for message in messages for block in message.blocks if isinstance(block, ToolCallBlock)]
    assert raw == ({1} if coverage in {"legacy_raw", "normal_raw"} else set())
    assert ("NORMAL SOURCE DETAIL" in text) == (coverage in {"inferred_handoff", "explicit_handoff"})
    assert len(calls) == (1 if coverage in {"inferred_handoff", "explicit_handoff"} else 0)
    assert ("[stage handoff]" in text) == (coverage == "normal_raw")
    assert "ENTRY SUMMARY" in text


@pytest.mark.parametrize("exact_coverage", [False, True])
async def test_legacy_raw_coverage_survives_session_compaction(legacy_clarify_context, exact_coverage: bool) -> None:
    """A newer Clarify Session boundary must not reopen its old mixed Turn summary."""
    ota, context = legacy_clarify_context
    if exact_coverage:
        summary = ota.state.context_compaction.turn["build"]["clarify"]
        summary.turn_covered_rounds = [1, 2]
        summary.turn_covered_raw_rounds = [1, 2]
    turns = [_turn(0, ota.ota_record, ota.state)]
    for ordinal in range(1, 5):
        record = OTARecord(think_result={"step_content": f"Retained Clarify turn {ordinal}", "tool_calls": []})
        record.think_scope = {"mode": "build", "stage": "clarify", "session_history": "stage_scoped_v2"}
        turns.append(_turn(ordinal, [record], ota.state.model_copy(update={"context_compaction": None})))
    context = _context(str(context.session.workspace_root), turns, 18_000)
    current = AmphiOTAContext(user_input="Continue", state={"think": {"mode": "build", "stage": "clarify"}})
    worker = ClarifyThink()
    before = str([message.content for message in await worker.session_messages_block(current, context)])
    assert "LEGACY NORMAL PREFIX" not in before

    current.state.context_compaction = ContextCompactionState.model_validate({"session": {"build": {"clarify": {
        "session_summary": "SESSION SUMMARY OF THE EARLIER REQUIREMENTS AND CLARIFY FACTS",
        "session_through_ordinal": 0,
    }}}})
    messages = await worker.session_messages_block(current, context)

    text = str([message.content for message in messages])
    assert "SESSION SUMMARY OF THE EARLIER REQUIREMENTS" in text
    assert "The earlier Normal requirements and first Clarify facts are complete." not in text
    assert "LEGACY NORMAL PREFIX" not in text
    assert all(f"Retained Clarify turn {ordinal}" in text for ordinal in range(1, 5))
    restored = AmphiOTAContext.model_validate(current.model_dump(mode="json", exclude={"tools"}))
    replayed = await worker.session_messages_block(restored, context)
    assert [message.model_dump(mode="json") for message in replayed] == [message.model_dump(mode="json") for message in messages]


@pytest.mark.parametrize("legacy_flat", [False, True])
@pytest.mark.parametrize("turn_count", [6, 8])
async def test_clarify_compaction_uses_effective_normal_session_history(test_sandbox: IsolatedPaths, legacy_flat: bool, turn_count: int) -> None:
    """Shared history stays in its owner's summary, including coverage advanced in this call."""
    turns = []
    for ordinal in range(turn_count):
        if ordinal < 2:
            text = f"HIDDEN NORMAL RAW {ordinal} " * 300
        elif ordinal < turn_count - 4:
            text = f"UNCOVERED NORMAL RAW {ordinal} " * 100
        else:
            text = f"RETAINED NORMAL RAW {ordinal}"
        record = OTARecord(think_result={"step_content": text, "tool_calls": []})
        turns.append(_turn(ordinal, [record], AgentState()))
    normal_summary = {"session_summary": "EXISTING NORMAL SESSION SUMMARY", "session_through_ordinal": 1}
    compaction = normal_summary if legacy_flat else {"session": {"normal": {"main": normal_summary}}}
    records = []
    for index in range(6):
        record = OTARecord(think_result={"step_content": f"Current Clarify material {index} " * 100, "tool_calls": []})
        record.think_scope = {"mode": "build", "stage": "clarify", "session_history": "stage_scoped_v2"}
        records.append(record)
    current = AmphiOTAContext(user_input="Continue", ota_record=records, state={
        "think": {"mode": "build", "stage": "clarify"}, "context_compaction": compaction,
    })
    context = _context(str(test_sandbox.sessions / "effective-normal-history"), turns, 27_000)
    responses = ["UPDATED NORMAL SESSION SUMMARY"] if turn_count == 8 else []
    llm = SummaryLlm(*responses, "CURRENT CLARIFY SUMMARY")
    worker = ClarifyThink(llm)
    saved_turns = deepcopy([turn.model_dump(mode="json") for turn in turns])
    before = await worker.assemble_messages(current, context)
    before_text = str([message.content for message in before])
    assert "HIDDEN NORMAL RAW" not in before_text
    assert "EXISTING NORMAL SESSION SUMMARY" in before_text
    assert worker._estimate_request_tokens(before, []) >= context.llm_provider.input_capacity() * 0.90

    prepared = await worker.compact_messages(before, [], current, context)

    requests = [str([message.content for message in request]) for request in llm.calls]
    assert len(requests) == (2 if turn_count == 8 else 1)
    assert all("HIDDEN NORMAL RAW" not in request for request in requests)
    if turn_count == 8:
        assert "EXISTING NORMAL SESSION SUMMARY" in requests[0]
        assert all(f"UNCOVERED NORMAL RAW {ordinal}" in requests[0] for ordinal in (2, 3))
        assert "Current Clarify material" not in requests[0]
    assert "Current Clarify material 0" in requests[-1]
    assert "Current Clarify material 1" in requests[-1]
    assert "NORMAL RAW" not in requests[-1]
    assert "NORMAL SESSION SUMMARY" not in requests[-1]
    state = current.state.context_compaction
    normal = BaseThink._session_projection(state, turns, ("normal", "main"))
    assert normal.session_through_ordinal == turn_count - 5
    assert normal.session_summary == ("UPDATED NORMAL SESSION SUMMARY" if turn_count == 8 else "EXISTING NORMAL SESSION SUMMARY")
    clarify = state.session.get("build", {}).get("clarify")
    assert clarify is None or not clarify.session_summary
    text = str([message.content for message in prepared])
    assert text.count(normal.session_summary) == 1
    assert "HIDDEN NORMAL RAW" not in text
    assert "UNCOVERED NORMAL RAW" not in text
    assert all(f"RETAINED NORMAL RAW {ordinal}" in text for ordinal in range(turn_count - 4, turn_count))
    assert "CURRENT CLARIFY SUMMARY" in text
    assert worker._estimate_request_tokens(prepared, []) < context.llm_provider.input_capacity()
    assert [turn.model_dump(mode="json") for turn in turns] == saved_turns
    restored = AmphiOTAContext.model_validate(current.model_dump(mode="json", exclude={"tools"}))
    replayed = await worker.session_messages_block(restored, context)
    assert "HIDDEN NORMAL RAW" not in str([message.content for message in replayed])
    assert all(f"RETAINED NORMAL RAW {ordinal}" in str([message.content for message in replayed]) for ordinal in range(turn_count - 4, turn_count))


async def test_shared_normal_coverage_keeps_clarify_material_in_mixed_turns(test_sandbox: IsolatedPaths) -> None:
    """A covered Normal prefix must not discard another owner's records in the same Turns."""
    def record(text: str, scope: tuple[str, str] | None = None) -> OTARecord:
        item = OTARecord(
            think_result={"step_content": "Read the historical material", "tool_calls": []},
            action_result=ActionResult(results=[ActionStepResult(
                tool_id="", tool_name="read_file", tool_arguments={"file_path": "history.txt"}, tool_result=text,
            )]),
        )
        if scope is not None:
            item.think_scope = {"mode": scope[0], "stage": scope[1], "session_history": "all_stages"}
        return item

    turns = []
    for ordinal in range(6):
        hidden = "HIDDEN" if ordinal < 2 else "RETAINED"
        turns.append(_turn(ordinal, [
            record(f"{hidden} UNSCOPED MATERIAL {ordinal} " * 40),
            record(f"{hidden} NORMAL MATERIAL {ordinal} " * 40, ("normal", "main")),
            record(f"CLARIFY MATERIAL {ordinal} " * 80, ("build", "clarify")),
        ], AgentState()))
    current = AmphiOTAContext(user_input="Continue", state={
        "think": {"mode": "build", "stage": "clarify"},
        "context_compaction": {"session": {"normal": {"main": {
            "session_summary": "NORMAL CHECKPOINT", "session_through_ordinal": 1,
        }}}},
    })
    context = _context(str(test_sandbox.sessions / "mixed-effective-history"), turns, 100_000)
    llm = SummaryLlm("CLARIFY CHECKPOINT")
    worker = ClarifyThink(llm)
    saved_turns = deepcopy([turn.model_dump(mode="json") for turn in turns])
    before = await worker.assemble_messages(current, context)
    before_text = str([message.model_dump(mode="json") for message in before])
    assert "HIDDEN" not in before_text
    assert all(f"RETAINED NORMAL MATERIAL {ordinal}" in before_text for ordinal in range(2, 6))
    assert all(f"CLARIFY MATERIAL {ordinal}" in before_text for ordinal in range(6))

    prepared = await worker.compact_messages(before, [], current, context, target=1)

    assert len(llm.calls) == 1
    request = str([message.content for message in llm.calls[0]])
    assert "HIDDEN" not in request
    assert "NORMAL CHECKPOINT" not in request
    assert all(f"CLARIFY MATERIAL {ordinal}" in request for ordinal in (0, 1))
    assert all(f"Request {ordinal}" in request for ordinal in (0, 1))
    assert "CLARIFY MATERIAL 2" not in request
    assert current.state.context_compaction.session["normal"]["main"].session_summary == "NORMAL CHECKPOINT"
    assert current.state.context_compaction.session["build"]["clarify"].session_through_ordinal == 1
    text = str([message.model_dump(mode="json") for message in prepared])
    assert "HIDDEN" not in text
    assert text.count("NORMAL CHECKPOINT") == 1
    assert "CLARIFY CHECKPOINT" in text
    assert all(f"RETAINED NORMAL MATERIAL {ordinal}" in text for ordinal in range(2, 6))
    assert all(f"CLARIFY MATERIAL {ordinal}" in text for ordinal in range(2, 6))
    assert [turn.model_dump(mode="json") for turn in turns] == saved_turns
    restored = AmphiOTAContext.model_validate(current.model_dump(mode="json", exclude={"tools"}))
    expected_history = await worker.session_messages_block(current, context)
    restored_history = await worker.session_messages_block(restored, context)
    assert [message.model_dump(mode="json") for message in restored_history] == [message.model_dump(mode="json") for message in expected_history]
