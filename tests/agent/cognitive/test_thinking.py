from types import SimpleNamespace
from typing import Any

from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord

from src.amphi_agent import AmphiContext, AmphiOTAContext, MainThink
from src.amphi_service.protocol.llms._streaming import StreamResult
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive._harness import make_session


async def test_live_round(test_sandbox: IsolatedPaths) -> None:
    """Final live cognitive round:

    {
      "visible_checkpoint": {"content": "Fresh answer", "reasoning": "Fresh reasoning"},
      "returned": {"content": "Fresh answer", "tool": "read_file"},
      "usage": {"input_tokens": 11, "output_tokens": 3, "spent_tokens": 14},
      "build_stage": "generate"
    }

    Checks:
    1. A provider retry removes stale visible output before replacement deltas arrive.
    2. The completed call returns its final content and Tool Call while retaining provider captures.
    3. Usage reaches the Turn totals, worker meter, and live event stream once.
    4. The open OTA record identifies the Build stage that produced it.
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

        async def stream_turn(
            self,
            messages: list[Any],
            tools: list[Any] | None,
            *,
            publish: Any,
            extra_body: dict[str, Any] | None = None,
        ) -> StreamResult:
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
    context = AmphiContext(session=make_session(test_sandbox.sessions / "live-round"))

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

    # Check 3: Usage reaches the Turn totals, worker meter, and live event stream once.
    assert (ota_context.input_tokens, ota_context.output_tokens) == (11, 3)
    assert worker.spent_tokens == 14
    assert [event for event in stream.events if event[0] == "usage"] == [
        ("usage", {"input_tokens": 11, "output_tokens": 3})
    ]

    # Check 4: The open OTA record identifies the Build stage that produced it.
    assert record.build_stage == "generate"


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
