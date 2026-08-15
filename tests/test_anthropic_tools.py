"""Regression: Anthropic tool-definition conversion.

``AnthropicLlm.stream_turn`` passes bridgic ``Tool`` objects
(``ToolSpec.to_tool()``) through ``convert_tools(..., "anthropic")``. An earlier
dict-only branch dropped every one of them, so ``protocol: anthropic`` sent ZERO
tools and the model fell back to emitting ``<tool_call>`` text + hallucinated
results. This pins that the flat-``Tool`` shape is recognised and mapped onto
Anthropic's ``input_schema``.
"""

from __future__ import annotations

from bridgic.core.agentic.tool_specs import FunctionToolSpec
from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms._streaming import convert_tools
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicLlm


def _sample_tool():
    async def run_command(command: str) -> str:
        """Run a shell command.

        Args:
            command: The command line to execute.
        """
        return command

    return FunctionToolSpec.from_raw(run_command).to_tool()


def test_tool_shape_conversion() -> None:
    """The flat bridgic ``Tool`` (the shape that actually flows through
    ``_stream_anthropic``) maps onto ``input_schema``; OpenAI envelopes and
    already-Anthropic dicts pass through; junk is skipped, never raises."""
    out = convert_tools([_sample_tool()], "anthropic")
    assert len(out) == 1
    entry = out[0]
    assert entry["name"] == "run_command"
    assert entry["description"]
    schema = entry["input_schema"]
    assert isinstance(schema, dict)
    assert "command" in schema.get("properties", {})

    openai_shape = {
        "type": "function",
        "function": {
            "name": "do_x",
            "description": "d",
            "parameters": {"type": "object", "properties": {}},
        },
    }
    anthropic_shape = {
        "name": "do_y",
        "description": "d",
        "input_schema": {"type": "object", "properties": {}},
    }
    out = convert_tools([openai_shape, anthropic_shape], "anthropic")
    assert [e["name"] for e in out] == ["do_x", "do_y"]

    assert convert_tools([object(), {"junk": 1}], "anthropic") == []


def test_extract_merges_consecutive_same_role() -> None:
    """Anthropic requires strict user/assistant alternation, so the adapter folds
    consecutive same-role messages into one — e.g. a failed turn that keeps the
    user's question with no reply leaves two user messages in a row."""
    llm = AnthropicLlm(api_key="test-key")
    system, api = llm._extract_system_and_messages([
        Message.from_text("sys", role=Role.SYSTEM),
        Message.from_text("ask", role=Role.USER),
        Message.from_text("answer", role=Role.AI),
        Message.from_text("package it", role=Role.USER),  # failed turn's question (no reply)
        Message.from_text("retry", role=Role.USER),        # next turn's input
    ])
    assert system == "sys"
    # The two trailing user messages fold into one — alternation preserved.
    assert [m["role"] for m in api] == ["user", "assistant", "user"]
    assert [b["text"] for b in api[-1]["content"] if b.get("type") == "text"] == [
        "package it", "retry",
    ]
