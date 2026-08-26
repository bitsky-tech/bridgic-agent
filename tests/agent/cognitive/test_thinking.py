from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Message, Role

from src.amphi_agent import AmphiContext, AmphiOTAContext, LlmProvider, MainThink
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
        "stage": "generate",
        "session_history": "all_stages"
      }
    }

    Checks:
    1. A provider retry removes stale visible output before replacement deltas arrive.
    2. The completed call returns its final content and Tool Call while retaining provider captures.
    3. Usage reaches the Turn totals, worker meter, and context event stream once.
    4. The open OTA record identifies its cognitive scope and Session-history policy.
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
            model_limits={"context": 100, "output": 20},
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
        "usable_tokens": 80,
        "percentage": 13.8,
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

    # Check 4: The open OTA record identifies its cognitive scope and Session-history policy.
    expected_scope = {
        "mode": "build",
        "stage": "generate",
        "session_history": "all_stages",
    }
    assert llm.scope_at_call == expected_scope
    assert record.think_scope == expected_scope


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
    worker = MainThink()
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time="2026-08-26 12:00 (UTC+08:00)",
    )
    context = AmphiContext(session=make_session(test_sandbox.sessions / "breakdown"))
    current_input = await worker.current_user_block(ota_context, context)
    messages = [
        Message.from_text("Stable persona\n\n<context>\nDynamic data\n</context>", role=Role.SYSTEM),
        Message.from_text("Earlier question", role=Role.USER),
        Message.from_text("Earlier answer", role=Role.AI),
        Message.from_text(current_input, role=Role.USER),
    ]

    breakdown = await worker._estimate_context_breakdown(
        messages, [{"name": "read_file"}], ota_context, context,
    )

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


async def test_context_threshold_enters_the_compaction_hook(test_sandbox: IsolatedPaths) -> None:
    """An over-threshold preflight invokes compaction without changing messages yet."""
    class ProbeThink(MainThink):
        compacted = False

        async def compact_messages(self, messages, tools, context):
            self.compacted = True
            return None

    worker = ProbeThink()
    context = AmphiContext(
        session=make_session(test_sandbox.sessions / "compaction-threshold"),
        llm_provider=LlmProvider(
            model_id="small-model",
            model_limits={"input": 1},
        ),
    )
    messages = await worker.assemble_messages(AmphiOTAContext(user_input="large request"), context)

    ota_context = AmphiOTAContext(user_input="large request")
    prepared, estimate = await worker._prepare_context_window(messages, [], ota_context, context)

    assert worker.compacted is True
    assert prepared == messages
    assert estimate > 1


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
