import asyncio
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Message, Role

from src.amphi_agent import AmphiContext, AmphiOTAContext, LlmProvider, MainThink
from src.amphi_agent._invocation import AgentInvocation
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.presentation.state import PresentationStageState
from src.amphi_agent.cognitive.state import ContextCompactionState
from src.amphi_agent.cognitive.workflow.state import WorkflowStageState
from src.amphi_service.protocol.llms._streaming import StreamResult
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive._harness import make_session


async def test_live_round(test_sandbox: IsolatedPaths) -> None:
    """Final live cognitive round:

    {
      "visible_checkpoint": {"content": "Fresh answer", "reasoning": "Fresh reasoning"},
      "returned": {"content": "Fresh answer", "tool": "read_file"},
      "usage": {"input_tokens": 11, "output_tokens": 3, "cached_input_tokens": 5, "spent_tokens": 14},
      "think_scope": {
        "mode": "build",
        "stage": "generate"
      }
    }

    Checks:
    1. A provider retry removes stale visible output before replacement deltas arrive.
    2. The completed call returns its final content and Tool Call while retaining provider captures.
    3. Usage reaches the Turn totals, worker meter, and context event stream once.
    4. The open OTA record identifies its cognitive scope without a legacy policy marker.
    """
    ota_context = AmphiOTAContext(
        user_input="Continue generating the workflow",
        state={"think": {"mode": "build", "stage": "generate"}},
        ota_record=[OTARecord()],
    )

    class EventStream:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, Any]]] = []

        def publish(self, event: str, **payload: Any) -> None:
            self.events.append((event, payload))

    class RetryingLlm:
        def __init__(self) -> None:
            self.after_retry: tuple[Any, str] | None = None
            self.scope_at_call: dict[str, Any] | None = None

        async def stream_turn(
            self,
            messages: list[Any],
            tools: list[Any] | None,
            *,
            publish: Any,
            extra_body: dict[str, Any] | None = None,
        ) -> StreamResult:
            self.scope_at_call = dict(ota_context.ota_record[-1].think_scope or {})
            publish("reasoning", text="Stale reasoning")
            publish("token", text="Stale answer")
            publish("model_retry")
            record = ota_context.ota_record[-1]
            self.after_retry = (record.think_result, record.reasoning_content)
            publish("reasoning", text="Fresh reasoning")
            publish("token", text="Fresh answer")
            return StreamResult(
                tool_calls=[{
                    "name": "read_file",
                    "arguments": {"file_path": "workflow/WORKFLOW.md"},
                    "call_id": "call-live",
                }],
                content="Fresh answer",
                usage=SimpleNamespace(
                    input_tokens=4,
                    output_tokens=3,
                    cache_creation_input_tokens=2,
                    cache_read_input_tokens=5,
                ),
                capture={"reasoning_items": [{"id": "reasoning-live"}]},
            )

    stream = EventStream()
    ota_context.stream = stream
    llm = RetryingLlm()
    worker = MainThink(llm)
    context = AmphiContext(
        session=make_session(test_sandbox.sessions / "live-round"),
        llm_provider=LlmProvider(
            model_id="test-model",
            model_limits={"input": 100_000},
        ),
    )

    calls, content = await worker.thinking(ota_context, context)
    record = ota_context.ota_record[-1]

    # Check 1: A provider retry removes stale visible output before replacement deltas arrive.
    assert llm.after_retry == (None, "")
    assert record.think_result == {
        "step_content": "Fresh answer",
        "tool_calls": [],
    }
    assert record.reasoning_content == "Fresh reasoning"

    # Check 2: The completed call returns its final content and Tool Call while retaining provider captures.
    assert content == "Fresh answer"
    assert calls == [{
        "name": "read_file",
        "arguments": {"file_path": "workflow/WORKFLOW.md"},
        "call_id": "call-live",
    }]
    assert record.reasoning_items == [{"id": "reasoning-live"}]

    # Check 3: Usage reaches the Turn totals, worker meter, and context event stream once.
    assert (
        ota_context.context_usage.input_tokens,
        ota_context.context_usage.output_tokens,
        ota_context.context_usage.cached_input_tokens,
    ) == (11, 3, 5)
    assert worker.spent_tokens == 14
    context_events = [payload for event, payload in stream.events if event == "context_usage"]
    assert len(context_events) == 1
    context_event = context_events[0]
    assert context_event | {"breakdown": None} == {
        "model_id": "test-model",
        "input_tokens": 11,
        "output_tokens": 3,
        "cached_input_tokens": 5,
        "used_tokens": 11,
        "usable_tokens": 100_000,
        "percentage": 0.0,
        "source": "provider",
        "breakdown": None,
    }
    assert sum(context_event["breakdown"].values()) == 11
    assert context_event["breakdown"]["system_prompt_tokens"] > 0
    assert context_event["breakdown"]["dynamic_context_tokens"] > 0
    assert context_event["breakdown"]["tool_schema_tokens"] > 0
    assert context_event["breakdown"]["session_history_tokens"] == 0
    assert context_event["breakdown"]["current_input_tokens"] > 0
    assert ota_context.context_usage.used_tokens == 11

    # Check 4: The open OTA record identifies its cognitive scope without a legacy policy marker.
    expected_scope = {
        "mode": "build",
        "stage": "generate",
        "browser_tool_loaded": False,
        "workspace_tools_loaded": False,
        "skills_tool_loaded": False,
        "prompt_time": ota_context.prompt_time,
    }
    assert llm.scope_at_call == expected_scope
    assert record.think_scope == expected_scope
    assert "prompt_context" not in record.model_dump(mode="json")


async def test_round_scope_keeps_step_before_assembly_and_later_transitions(test_sandbox: IsolatedPaths) -> None:
    """Persist each round's optional cursor without changing trace order or earlier scopes."""
    states = [
        NormalStageState(),
        PresentationStageState(stage="ppt_plan", step_index=0),
        PresentationStageState(stage="ppt_plan", step_index=1),
        BuildStageState(stage="clarify"),
        WorkflowStageState(workflow_id="workflow", generation="generation", step_index=3),
    ]
    expected_scopes = [
        {"mode": "normal", "stage": "main"},
        {"mode": "presentation", "stage": "ppt_plan", "step_index": 0},
        {"mode": "presentation", "stage": "ppt_plan", "step_index": 1},
        {"mode": "build", "stage": "clarify"},
        {"mode": "run_workflow", "stage": "execute", "workflow_id": "workflow", "generation": "generation", "step_index": 3},
    ]
    ota = AmphiOTAContext(user_input="Continue")

    class InspectingThink(MainThink):
        async def assemble_messages(self, ota_context, context):
            assert ota_context.ota_record[-1].think_scope == expected_scopes[len(ota_context.ota_record) - 1]
            return [Message.from_text("Round scope test", role=Role.SYSTEM)]

    class TestLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            content = f"response-{len(ota.ota_record)}"
            publish("token", text=content)
            return StreamResult(tool_calls=[], content=content)

    context = AmphiContext(
        session=make_session(test_sandbox.sessions / "scope-steps"),
        llm_provider=LlmProvider(model_id="test-model", model_limits={"input": 100_000}),
    )
    worker = InspectingThink(TestLlm())
    for state in states:
        ota.transition_think(state)
        ota.open_record()
        await worker.thinking(ota, context)

    serialized = ota.model_dump(mode="json", include={"ota_record"})["ota_record"]
    assert [record["think_scope"] for record in serialized] == [
        {**scope, "browser_tool_loaded": False, "workspace_tools_loaded": False,
         "skills_tool_loaded": False, "prompt_time": ota.prompt_time}
        for scope in expected_scopes
    ]
    assert [record["think_result"]["step_content"] for record in serialized] == [
        f"response-{index + 1}" for index in range(len(states))
    ]
    assert all("prompt_context" not in record for record in serialized)
    assert all("state" not in record["think_scope"] and "think" not in record["think_scope"] for record in serialized)


@pytest.mark.parametrize("cancelled", [False, True])
async def test_round_context_freezes_post_compaction_state_before_model_call(test_sandbox: IsolatedPaths, cancelled: bool) -> None:
    """Saved and cancelled rounds retain their own effective state, including false flags."""
    ota = AmphiOTAContext(user_input="Continue", prompt_time="2026-09-15 12:00 (UTC+08:00)")
    snapshots = []

    class CompactingThink(MainThink):
        async def compact_messages(self, messages, tools, ota_context, context, target=None):
            if len(ota_context.ota_record) == 2:
                ota_context.state.context_compaction = ContextCompactionState.model_validate({
                    "turn": {"normal": {"main": {
                        "turn_summary": "Round one summary", "turn_through_round": 1,
                        "turn_covered_rounds": [1], "turn_covered_raw_rounds": [1],
                    }}},
                })
                return await self.assemble_messages(ota_context, context)
            return messages

    class InspectingLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            snapshots.append(deepcopy(ota.ota_record[-1].think_scope))
            if len(snapshots) == 2:
                assert any("Round one summary" in message.content for message in messages)
                assert snapshots[-1]["context_compaction"]["turn"]["normal"]["main"]["turn_covered_rounds"] == [1]
                if cancelled:
                    raise asyncio.CancelledError()
            publish("token", text="Recorded answer")
            return StreamResult(tool_calls=[], content="Recorded answer")

    context = AmphiContext(session=make_session(test_sandbox.sessions / "round-context"))
    worker = CompactingThink(InspectingLlm())
    ota.open_record()
    await worker.thinking(ota, context)
    ota.browser_tool_loaded = ota.workspace_tools_loaded = ota.skills_tool_loaded = True
    ota.open_record()
    if cancelled:
        with pytest.raises(asyncio.CancelledError):
            await worker.thinking(ota, context)
    else:
        await worker.thinking(ota, context)

    # Later mutations must not overwrite the summary, cursor, clock or loading flags.
    summary = ota.state.context_compaction.turn["normal"]["main"]
    summary.turn_summary = "Later summary"
    summary.turn_covered_rounds.append(2)
    ota.transition_think(PresentationStageState(stage="ppt_plan", step_index=2))
    ota.prompt_time = "Later timestamp"
    ota.browser_tool_loaded = ota.workspace_tools_loaded = ota.skills_tool_loaded = False
    saved = AgentInvocation._ota_context_values(ota)["ota_records"]
    restored = AmphiOTAContext(ota_record=saved)
    assert [record.think_scope for record in restored.ota_record] == snapshots
    assert all("prompt_context" not in record for record in saved)
    assert "context_compaction" not in snapshots[0]
    for name in ("browser_tool_loaded", "workspace_tools_loaded", "skills_tool_loaded"):
        assert snapshots[0][name] is False
        assert snapshots[1][name] is True
    assert all(snapshot["prompt_time"] == "2026-09-15 12:00 (UTC+08:00)" for snapshot in snapshots)
    assert all((snapshot["mode"], snapshot["stage"]) == ("normal", "main") for snapshot in snapshots)
    assert snapshots[1]["context_compaction"]["turn"]["normal"]["main"]["turn_covered_rounds"] == [1]


@pytest.mark.parametrize(("usage", "expected"), [
    (
        {
            "prompt_tokens": 20,
            "completion_tokens": 4,
            "prompt_tokens_details": {"cached_tokens": 12},
        },
        (20, 4, 12),
    ),
    (
        SimpleNamespace(
            input_tokens=30,
            output_tokens=6,
            input_tokens_details=SimpleNamespace(cached_tokens=18),
        ),
        (30, 6, 18),
    ),
    (
        {"input_tokens": 9, "output_tokens": 2, "cached_input_tokens": 7},
        (9, 2, 7),
    ),
])
def test_usage_values_normalize_provider_cache_details(usage: Any, expected: tuple[int, int, int]) -> None:
    """Provider-specific cache details converge on one latest-call count."""
    assert MainThink._usage_values(usage) == expected


async def test_context_breakdown_classifies_the_final_request(test_sandbox: IsolatedPaths) -> None:
    """The persisted components distinguish tools from other dynamic input."""
    class BreakdownLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            assert tools
            assert any(message.content == "Earlier question" for message in messages)
            return StreamResult(tool_calls=[], content="Answer", usage=None)

    class BreakdownThink(MainThink):
        async def assemble_messages(self, ota_context, context):
            ota_context.tools = self.select_tools(ota_context, context)
            current_input = await self.current_user_block(ota_context, context)
            return [
                Message.from_text("Stable persona\n\n<context>\nDynamic data\n</context>", role=Role.SYSTEM),
                Message.from_text("Earlier question", role=Role.USER),
                Message.from_text("Earlier answer", role=Role.AI),
                Message.from_text(current_input, role=Role.USER),
            ]

    worker = BreakdownThink(BreakdownLlm())
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
        ota_record=[OTARecord()],
    )
    context = AmphiContext(session=make_session(test_sandbox.sessions / "breakdown"))
    await worker.thinking(ota_context, context)

    breakdown = ota_context.context_usage.breakdown
    assert breakdown.system_prompt_tokens > 0
    assert breakdown.dynamic_context_tokens > 0
    assert breakdown.tool_schema_tokens > 0
    assert breakdown.session_history_tokens > 0
    assert breakdown.current_input_tokens > 0


async def test_context_usage_falls_back_to_a_conservative_estimate(test_sandbox: IsolatedPaths) -> None:
    """Missing provider usage still produces an estimated context snapshot."""
    class MissingUsageLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            return StreamResult(tool_calls=[], content="Estimated answer", usage=None)

    class EventStream:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, Any]]] = []

        def publish(self, event: str, **payload: Any) -> None:
            self.events.append((event, payload))

    stream = EventStream()
    ota_context = AmphiOTAContext(user_input="Estimate this", stream=stream, ota_record=[OTARecord()])
    worker = MainThink(MissingUsageLlm())
    context = AmphiContext(
        session=make_session(test_sandbox.sessions / "estimated-usage"),
        llm_provider=LlmProvider(
            model_id="usage-less-model",
            model_limits={"input": 1_000_000},
        ),
    )

    await worker.thinking(ota_context, context)

    events = [payload for event, payload in stream.events if event == "context_usage"]
    assert len(events) == 1
    assert events[0]["source"] == "estimated"
    assert events[0]["model_id"] == "usage-less-model"
    assert events[0]["input_tokens"] > 0
    assert events[0]["output_tokens"] > 0
    assert events[0]["used_tokens"] == events[0]["input_tokens"]
    assert sum(events[0]["breakdown"].values()) == events[0]["input_tokens"]
    assert ota_context.context_usage.input_tokens == 0
    assert ota_context.context_usage.output_tokens == 0
    assert ota_context.context_usage.occupied_input_tokens == events[0]["input_tokens"]
    assert ota_context.context_usage.occupied_output_tokens == events[0]["output_tokens"]
    assert ota_context.context_usage.stage_references == {}


@pytest.mark.parametrize(("source", "estimate"), [
    ("provider", 95),
    ("estimated", 90),
])
async def test_context_threshold_enters_the_compaction_hook(test_sandbox: IsolatedPaths, source: str, estimate: int) -> None:
    """Provider and estimated preflights compact at their configured late thresholds."""
    class ProbeLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            return StreamResult(tool_calls=[], content="Answer", usage=None)

    class ProbeThink(MainThink):
        compacted = False
        request_estimate = estimate - 1

        async def assemble_messages(self, ota_context, context):
            return [Message.from_text("Large request")]

        def _estimate_request_tokens(self, messages, tools):
            return self.request_estimate

        async def compact_history(self, ota_context, context, scope, candidate, *, read_scopes=None):
            self.compacted = True

    worker = ProbeThink(ProbeLlm())
    context = AmphiContext(
        session=make_session(test_sandbox.sessions / f"compaction-threshold-{source}"),
        llm_provider=LlmProvider(
            model_id="small-model",
            model_limits={"input": 100},
        ),
    )
    usage = (
        {
            "model_id": "small-model",
            "source": "provider",
            "used_tokens": estimate,
            "estimated_occupied_tokens": estimate,
            "stage_references": {"normal": {"main": {
                "model_id": "small-model",
                "input_tokens": estimate,
                "estimated_input_tokens": estimate,
            }}},
        }
        if source == "provider"
        else {}
    )
    ota_context = AmphiOTAContext(user_input="large request", context_usage=usage, ota_record=[OTARecord()])
    await worker.thinking(ota_context, context)
    assert worker.compacted is False

    worker.request_estimate = estimate
    await worker.thinking(ota_context, context)

    assert worker.compacted is True
    assert ota_context.context_usage.estimated_occupied_tokens == estimate


def test_reasoning_replay(test_sandbox: IsolatedPaths) -> None:
    """Final provider continuation data:

    {
      "openai": ["reasoning_content", "reasoning_items", "reasoning_details"],
      "anthropic": ["captured_thinking_blocks_only"],
      "google": ["thought_signatures"]
    }

    Checks:
    1. OpenAI-compatible reasoning captures survive on the exact Assistant Tool Call message.
    2. Later OpenAI Tool Call messages retain the empty reasoning carrier required by that wire.
    3. Anthropic replays only signed captures, while Google signatures remain aligned.
    """
    worker = MainThink()
    context = AmphiContext(session=make_session(test_sandbox.sessions / "reasoning-replay"))

    def action(call_id: str) -> ActionResult:
        return ActionResult(results=[ActionStepResult(
            tool_id=call_id,
            tool_name="read_file",
            tool_arguments={"file_path": f"{call_id}.md"},
            tool_result=f"{call_id} contents",
        )])

    openai_context = AmphiOTAContext(
        user_input="Continue the OpenAI-compatible turn",
        ota_record=[
            OTARecord(
                think_result={"step_content": "Inspect first", "tool_calls": []},
                action_result=action("call-openai-1"),
                reasoning_content="Reasoning one",
                reasoning_items=[{"id": "item-one"}],
                reasoning_details=[{"type": "summary", "text": "Detail one"}],
            ),
            OTARecord(
                think_result={"step_content": "Inspect second", "tool_calls": []},
                action_result=action("call-openai-2"),
            ),
        ],
    )
    openai_messages = worker.turn_messages_block(openai_context, context)

    # Check 1: OpenAI-compatible reasoning captures survive on the exact Assistant Tool Call message.
    assert openai_messages[0].extras == {
        "reasoning_content": "Reasoning one",
        "reasoning_items": [{"id": "item-one"}],
        "reasoning_details": [{"type": "summary", "text": "Detail one"}],
    }

    # Check 2: Later Tool Call messages retain the empty reasoning carrier required by the active mode.
    assert openai_messages[2].extras == {"reasoning_content": ""}

    anthropic_context = AmphiOTAContext(
        user_input="Continue the Anthropic turn",
        ota_record=[
            OTARecord(
                think_result={"step_content": "Inspect first", "tool_calls": []},
                action_result=action("call-anthropic-1"),
                thinking_blocks=[{
                    "type": "thinking",
                    "thinking": "Reasoning one",
                    "signature": "anthropic-signature",
                }],
            ),
            OTARecord(
                think_result={"step_content": "Inspect second", "tool_calls": []},
                action_result=action("call-anthropic-2"),
            ),
        ],
    )
    anthropic_messages = worker.turn_messages_block(anthropic_context, context)

    # Check 3: Anthropic thinking blocks and Google Tool Call signatures remain aligned for replay.
    assert anthropic_messages[0].extras["thinking_blocks"] == [{
        "type": "thinking",
        "thinking": "Reasoning one",
        "signature": "anthropic-signature",
    }]
    assert "thinking_blocks" not in anthropic_messages[2].extras

    google_context = AmphiOTAContext(
        user_input="Continue the Google turn",
        ota_record=[OTARecord(
            think_result={"step_content": "Inspect first", "tool_calls": []},
            action_result=action("call-google-1"),
            thought_signatures=["signature-one"],
        )],
    )
    google_messages = worker.turn_messages_block(google_context, context)
    assert google_messages[0].extras == {"thought_signatures": ["signature-one"]}
