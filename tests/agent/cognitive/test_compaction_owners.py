"""Contracts for dispatching shared-history compaction to its actual owners."""

import asyncio
from copy import deepcopy

import pytest
from bridgic.amphibious import AmphibiousAutoma, OTARecord, think_unit

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink
from src.amphi_agent.cognitive.base import BaseThink
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.state import ContextCompactionState, TurnCompactionState
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive.test_compaction import EventStream, SummaryLlm, _context


class _SharedReader(BaseThink):
    """Keep the real history machinery while excluding unrelated prompt blocks."""

    def history_scopes(self, ota_context, context):
        return [("normal", "main"), ("build", "clarify")]

    async def assemble_messages(self, ota_context, context):
        return [
            *await self.session_messages_block(ota_context, context),
            await self.current_user_message(ota_context, context),
            *self.turn_messages_block(ota_context, context),
        ]


def _owned_rounds() -> list[OTARecord]:
    records = []
    for mode, stage, marker in (("normal", "main", "NORMAL"), ("build", "clarify", "CLARIFY")):
        for index in range(6):
            record = OTARecord(think_result={
                "step_content": f"{marker} owned history {index}. " * 100,
                "tool_calls": [],
            })
            record.think_scope = {"mode": mode, "stage": stage}
            records.append(record)
    return records


@pytest.mark.parametrize("child,outcome", [(False, "success"), (False, "error"), (True, "cancel")])
async def test_arun_binds_actual_templates_and_restores_context(monkeypatch: pytest.MonkeyPatch, child: bool, outcome: str) -> None:
    """Runtime owner lookup respects subclass descriptors and the Session role."""
    main_template, child_template, clarify_template = BaseThink(), BaseThink(), BaseThink()

    class CustomAgent(AmphiAgent):
        main = think_unit(main_template)
        subagent = think_unit(child_template)
        clarify = think_unit(clarify_template)

    context = AmphiContext()
    context.session.parent_session_id = "parent" if child else None
    previous = {("outer", "stage"): BaseThink()}
    context._cognitive_workers = previous
    agent = CustomAgent()

    async def run_framework(self, **kwargs):
        assert self is agent and kwargs["context"] is context
        assert context._cognitive_workers[("normal", "main")] is (child_template if child else main_template)
        assert context._cognitive_workers[("build", "clarify")] is clarify_template
        assert "_cognitive_workers" not in context.model_dump()
        if outcome == "error":
            raise RuntimeError("Framework stopped")
        if outcome == "cancel":
            raise asyncio.CancelledError()
        self._agent_result = "Completed"

    monkeypatch.setattr(AmphibiousAutoma, "arun", run_framework)
    if outcome == "success":
        assert await agent.arun(context=context) == "Completed"
    else:
        exception = RuntimeError if outcome == "error" else asyncio.CancelledError
        with pytest.raises(exception):
            await agent.arun(context=context)
    assert context._cognitive_workers is previous


@pytest.mark.parametrize("llm_source", ["clone", "template", "active"])
async def test_compaction_calls_each_owner_without_changing_active_stage(test_sandbox: IsolatedPaths, llm_source: str) -> None:
    """Custom clones own their summaries, configuration, and single-counted usage."""
    active_llm = SummaryLlm("Shared summary", "Active summary")
    template_llm = SummaryLlm("Template summary") if llm_source == "template" else None
    clone_llm = SummaryLlm("Clone summary") if llm_source == "clone" else None
    if llm_source == "clone":
        template_llm = SummaryLlm("Unused template summary")
    calls = []
    clones = []
    status = BuildStageState(stage="clarify")

    class Owner(MainThink):
        def _clone(self):
            clone = type(self)(clone_llm)
            clone.configuration = self.configuration
            clone.spent_tokens = 41
            clones.append(clone)
            return clone

        async def compact_history(self, ota_context, context, scope, candidate, *, read_scopes=None):
            assert self.configuration == "configured-source"
            assert ota_context.think_status is status
            assert list(read_scopes) == [("normal", "main"), ("build", "clarify")]
            calls.append((self, scope))
            await super().compact_history(ota_context, context, scope, candidate, read_scopes=read_scopes)
            assert set(candidate.turn) == {"normal"}

        async def thinking(self, ota_context, context=None):
            raise AssertionError("History compaction must not run source thinking")

    class Reader(_SharedReader):
        def history_scopes(self, ota_context, context):
            return [("normal", "main"), *super().history_scopes(ota_context, context)]

        async def compact_history(self, ota_context, context, scope, candidate, *, read_scopes=None):
            assert ota_context.think_status is status
            assert list(read_scopes) == [("normal", "main"), ("build", "clarify")]
            calls.append((self, scope))
            await super().compact_history(ota_context, context, scope, candidate, read_scopes=read_scopes)

    template = Owner(template_llm)
    template.configuration = "configured-source"
    template.spent_tokens = 123
    worker = Reader(active_llm)
    context = _context(str(test_sandbox.sessions / "owner-dispatch"), [], 200_000)
    context._cognitive_workers = {("normal", "main"): template, ("build", "clarify"): BaseThink()}
    ota = AmphiOTAContext(user_input="Continue", state={"think": status}, ota_record=_owned_rounds())
    status = ota.think_status
    records_before = deepcopy(ota.ota_record)
    messages = await worker.assemble_messages(ota, context)

    rebuilt = await worker.compact_messages(messages, [], ota, context, target=1)

    assert len(clones) == 1
    source = clones[0]
    expected_llm = clone_llm if clone_llm is not None else template_llm if template_llm is not None else active_llm
    assert source._llm is expected_llm
    assert calls == [(source, ("normal", "main")), (worker, ("build", "clarify"))]
    assert source is not template and source.spent_tokens == 48
    assert template.spent_tokens == 123
    assert worker.spent_tokens == 14
    assert (ota.context_usage.input_tokens, ota.context_usage.output_tokens) == (10, 4)
    assert ota.context_usage.stage_references == {}
    assert len(expected_llm.calls) == (2 if expected_llm is active_llm else 1)
    if llm_source == "clone":
        assert not template_llm.calls
    assert ota.state.context_compaction.turn["normal"]["main"].turn_covered_rounds == [1, 2]
    assert ota.state.context_compaction.turn["build"]["clarify"].turn_covered_rounds == [7, 8]
    assert ota.think_status is status and ota.ota_record == records_before
    assert worker._estimate_request_tokens(rebuilt, []) < worker._estimate_request_tokens(messages, [])
    source_prompt = str(expected_llm.calls[0])
    assert "NORMAL owned history" in source_prompt and "CLARIFY owned history" not in source_prompt


@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError])
async def test_late_source_failure_discards_all_candidates_but_keeps_usage(test_sandbox: IsolatedPaths, failure: type[BaseException]) -> None:
    """A paid source summary survives in billing, never as a partial checkpoint."""
    class FailingOwner(MainThink):
        async def compact_history(self, ota_context, context, scope, candidate, *, read_scopes=None):
            await super().compact_history(ota_context, context, scope, candidate, read_scopes=read_scopes)
            assert set(candidate.turn) == {"presentation", "build", "normal"}
            raise failure()

    class Reader(_SharedReader):
        def history_scopes(self, ota_context, context):
            return list(reversed(super().history_scopes(ota_context, context)))

    worker = Reader(SummaryLlm("Active summary"))
    template = FailingOwner(SummaryLlm("Source summary"))
    context = _context(str(test_sandbox.sessions / "owner-failure"), [], 200_000)
    context._cognitive_workers = {("normal", "main"): template}
    original = ContextCompactionState(turn={"presentation": {"ppt_brief": TurnCompactionState(turn_summary="Retained summary")}})
    ota = AmphiOTAContext(
        user_input="Continue", state={"think": BuildStageState(stage="clarify"), "context_compaction": original},
        ota_record=_owned_rounds(), stream=EventStream(), selected_skill_dirs=["stable"], prompt_time="fixed-clock",
    )
    original = ota.state.context_compaction
    state_before, records_before = deepcopy(ota.state), deepcopy(ota.ota_record)
    messages = await worker.assemble_messages(ota, context)

    with pytest.raises(failure):
        await worker.compact_messages(messages, [], ota, context, target=1)

    assert ota.state.context_compaction is original and ota.state == state_before
    assert ota.ota_record == records_before
    assert ota.selected_skill_dirs == ["stable"] and ota.prompt_time == "fixed-clock"
    assert worker.spent_tokens == 14 and template.spent_tokens == 0
    assert (ota.context_usage.input_tokens, ota.context_usage.output_tokens) == (10, 4)
    assert ota.stream.events == [("context_compaction", {"active": True}), ("context_compaction", {"active": False})]


async def test_foreign_binding_is_required_only_when_compaction_runs(test_sandbox: IsolatedPaths) -> None:
    """A standalone reader never silently replaces its source's configured policy."""
    worker = _SharedReader(SummaryLlm())
    context = _context(str(test_sandbox.sessions / "missing-owner"), [], 200_000)
    context._cognitive_workers = {}
    ota = AmphiOTAContext(user_input="Continue", state={"think": BuildStageState(stage="clarify")}, ota_record=_owned_rounds())
    messages = await worker.assemble_messages(ota, context)
    assert await worker.compact_messages(messages, [], ota, context) is messages
    with pytest.raises(RuntimeError, match="No history worker is bound for `normal/main`"):
        await worker.compact_messages(messages, [], ota, context, target=1)
    assert ota.state.context_compaction is None
    assert not worker._llm.calls


async def test_turn_compaction_keeps_shared_legacy_coverage_and_original_round_ids(test_sandbox: IsolatedPaths) -> None:
    """Clarify compacts its own visible rounds without reopening Normal's summarized raw trace."""
    legacy = [OTARecord(think_result={
        "step_content": f"COVERED LEGACY NORMAL RAW {index}. " * 100,
        "tool_calls": [],
    }) for index in range(6)]
    records = [*legacy, *_owned_rounds()[6:]]
    normal_summary = TurnCompactionState(
        turn_summary="Normal's retained effective history",
        turn_through_round=6,
        turn_covered_rounds=[1, 2, 3, 4, 5, 6],
        turn_covered_raw_rounds=[1, 2, 3, 4, 5, 6],
    )
    ota = AmphiOTAContext(
        user_input="Continue the clarified task",
        state={
            "think": BuildStageState(stage="clarify"),
            "context_compaction": ContextCompactionState(turn={"normal": {"main": normal_summary}}),
        },
        ota_record=records,
    )
    records_before = deepcopy(ota.ota_record)
    llm = SummaryLlm("Clarify's new owned summary")
    worker = _SharedReader(llm)
    context = _context(str(test_sandbox.sessions / "shared-turn-coverage"), [], 200_000)
    context._cognitive_workers = {("normal", "main"): MainThink()}
    messages = await worker.assemble_messages(ota, context)
    before_text = "\n".join(str(message.content) for message in messages)
    assert "COVERED LEGACY NORMAL RAW" not in before_text
    assert "Normal's retained effective history" in before_text

    rebuilt = await worker.compact_messages(messages, [], ota, context, target=1)

    assert len(llm.calls) == 1
    summary_input = "\n".join(str(message.content) for message in llm.calls[0])
    assert "COVERED LEGACY NORMAL RAW" not in summary_input
    assert "Normal's retained effective history" not in summary_input
    assert "CLARIFY owned history 0" in summary_input
    assert "CLARIFY owned history 1" in summary_input
    compaction = ota.state.context_compaction
    assert compaction.turn["normal"]["main"] == normal_summary
    assert compaction.turn["build"]["clarify"].turn_covered_rounds == [7, 8]
    assert compaction.turn["build"]["clarify"].turn_covered_raw_rounds == [7, 8]
    rebuilt_text = "\n".join(str(message.content) for message in rebuilt)
    assert "COVERED LEGACY NORMAL RAW" not in rebuilt_text
    assert "Normal's retained effective history" in rebuilt_text
    assert "Clarify's new owned summary" in rebuilt_text
    assert ota.ota_record == records_before
