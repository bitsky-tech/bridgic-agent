import asyncio

import pytest
from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent import _describe as describe_module
from src.amphi_agent._describe import describe_commands


class _ScriptedLlm:
    def __init__(self, result: str | Exception, delay: float = 0.0) -> None:
        self.result = result
        self.delay = delay
        self.calls: list[list[Message]] = []

    async def achat(self, messages: list[Message]) -> Response:
        self.calls.append(messages)
        if self.delay:
            await asyncio.sleep(self.delay)
        if isinstance(self.result, Exception):
            raise self.result
        return Response(message=Message.from_text(self.result, role=Role.AI))


async def test_descriptions() -> None:
    """Final approval descriptions:

    {
      "write_file": "Creates the requested report file.",
      "bash": "Shows the current repository status.",
      "llm_calls": 1
    }

    Checks:
    1. One LLM request contains every command with its stable batch index and arguments.
    2. Reordered summaries inside surrounding fenced JSON return in original command order.
    """
    items = [
        {
            "tool": "write_file",
            "arguments": {"file_path": "report.md", "content": "Weekly report"},
        },
        {"tool": "bash", "arguments": {"command": "git status"}},
    ]
    response = """Here are the descriptions:
```json
[
  {"index": 1, "summary": "Shows the current repository status."},
  {"index": 0, "summary": "Creates the requested report file."}
]
```
"""
    llm = _ScriptedLlm(response)

    descriptions = await describe_commands(llm, items)

    # Check 1: The complete indexed batch reaches the provider in one request.
    assert len(llm.calls) == 1
    assert [message.role for message in llm.calls[0]] == [Role.SYSTEM, Role.USER]
    user_prompt = llm.calls[0][1].content
    assert '"index": 0' in user_prompt
    assert '"tool": "write_file"' in user_prompt
    assert '"file_path": "report.md"' in user_prompt
    assert '"index": 1' in user_prompt
    assert '"tool": "bash"' in user_prompt
    assert '"command": "git status"' in user_prompt

    # Check 2: Provider order and surrounding prose do not change command alignment.
    assert descriptions == [
        "Creates the requested report file.",
        "Shows the current repository status.",
    ]


async def test_fallbacks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final approval fallback:

    {
      "no_llm": ["", ""],
      "non_json_response": ["", ""],
      "provider_error": ["", ""],
      "timeout": ["", ""]
    }

    Checks:
    1. Missing model configuration immediately returns one empty description per command.
    2. Non-JSON provider output falls back for the complete batch.
    3. A provider exception cannot block or partially describe an approval request.
    4. A provider timeout returns the same length-preserving fallback.
    """
    items = [
        {"tool": "write_file", "arguments": {"file_path": "report.md"}},
        {"tool": "bash", "arguments": {"command": "git status"}},
    ]
    fallback = ["", ""]

    # Check 1: No configured LLM still produces a frontend-safe batch shape.
    assert await describe_commands(None, items) == fallback

    # Check 2: Non-JSON output is discarded as a whole instead of shifting descriptions.
    malformed = _ScriptedLlm("Descriptions are unavailable.")
    assert await describe_commands(malformed, items) == fallback
    assert len(malformed.calls) == 1

    # Check 3: Provider failure returns the raw-command fallback for every pending call.
    failed = _ScriptedLlm(RuntimeError("provider unavailable"))
    assert await describe_commands(failed, items) == fallback
    assert len(failed.calls) == 1

    # Check 4: A slow provider is bounded and returns the same complete fallback.
    monkeypatch.setattr(describe_module, "_TIMEOUT_SECONDS", 0.01)
    slow = _ScriptedLlm("[]", delay=1.0)
    assert await describe_commands(slow, items) == fallback
    assert len(slow.calls) == 1
