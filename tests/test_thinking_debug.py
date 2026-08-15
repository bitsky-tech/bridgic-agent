from __future__ import annotations

import re
from pathlib import Path

import pytest
from bridgic.core.model.types import Message, Role

from src.amphi_agent._cognitive import MainThink
from src.amphi_agent._thinking_debug import (
    THINKING_DEBUG_ENV_VAR,
    _THINKING_DEBUG_DIR,
    write_thinking_debug,
)
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._workspace import Workspace
from src.amphi_service.protocol.llms._streaming import StreamResult


def _context(tmp_path: Path) -> AmphiContext:
    session = Session()
    session.workspace_root = str(tmp_path)
    return AmphiContext(session=session)


def _debug_dir(root: Path) -> Path:
    return root / _THINKING_DEBUG_DIR


def test_thinking_debug_env_gate(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path)
    monkeypatch.delenv(THINKING_DEBUG_ENV_VAR, raising=False)

    assert write_thinking_debug(
        messages=[Message.from_text("hello", role=Role.USER)],
        tools=[{"type": "function", "name": "bash"}],
        result=StreamResult(tool_calls=[], content="done"),
        extra_body=None,
        context=context,
    ) is None

    assert not _debug_dir(Path(context.session.workspace_root)).exists()


def test_thinking_debug_writes_messages_tools_and_optional_extra_body(tmp_path, monkeypatch) -> None:
    context = _context(tmp_path)
    monkeypatch.setenv(THINKING_DEBUG_ENV_VAR, "1")
    messages = [
        Message.from_text("# heading\nplain\ncontent  ", role=Role.USER),
        Message.from_tool_call(
            {"id": "call_1", "name": "bash", "arguments": {"command": "pwd"}},
            text="I will run pwd.",
            extras={"reasoning_content": "kept"},
        ),
    ]
    tools = [{"type": "function", "name": "bash", "description": "run"}]
    result = StreamResult(
        tool_calls=[{"name": "bash", "arguments": {"command": "echo '<full result>' [ok]"}}],
        content=("x" * 160) + " [done]",
        usage={"prompt_tokens": 3, "completion_tokens": 2},
        capture={"reasoning_content": "complete result detail"},
    )

    path = write_thinking_debug(
        messages=messages,
        tools=tools,
        result=result,
        extra_body=None,
        context=context,
    )

    assert path is not None
    assert path.parent == _debug_dir(Path(context.session.workspace_root))
    assert path.name.startswith("ota-")
    assert path.suffix == ".md"
    timestamp = path.stem.removeprefix("ota-")
    assert re.fullmatch(r"\d{8}-\d{6}", timestamp)
    message_dir = path.parent / f"ota-messages-{timestamp}-"
    text = path.read_text(encoding="utf-8")
    assert "## messages" in text
    assert f"[message 001](ota-messages-{timestamp}-/message-001-user.md)" in text
    assert "preview: heading plain content" in text
    assert "preview: # heading" not in text
    assert f"[message 002](ota-messages-{timestamp}-/message-002-assistant.md)" in text
    assert "## messages" in text
    assert "## result" in text
    assert "## tools" in text
    assert text.index("## messages") < text.index("## result") < text.index("## tools")
    assert f"[result](ota-result-{timestamp}-/result.md)" in text
    assert text.index("content:") < text.index("tool_calls:")
    assert "\n- name: bash\n- arguments:" in text
    assert "&lt;full result&gt;" in text
    assert "\\[ok\\]" in text
    assert ("x" * 120) in text
    assert "\\[done\\]" in text
    assert "complete result detail" not in text
    assert '"name": "bash"' in text
    assert "## extra_body" not in text
    message_one = (message_dir / "message-001-user.md").read_text(encoding="utf-8")
    message_two = (message_dir / "message-002-assistant.md").read_text(encoding="utf-8")
    result_text = (path.parent / f"ota-result-{timestamp}-" / "result.md").read_text(encoding="utf-8")
    assert "role: user\n\n---\n\n# heading\nplain\ncontent  \n" in message_one
    assert '```\n\n---\n\n#### block 1 (text)' in message_two
    assert "content:" not in message_one
    assert "blocks:" not in message_two
    assert "#### block 1 (text)" in message_two
    assert "#### block 2 (tool_call)" in message_two
    assert '"command": "pwd"' in message_two
    assert '"reasoning_content": "kept"' in message_two
    assert result_text.startswith("# result")
    assert '"tool_calls": [' in result_text
    assert '"content": "' + ("x" * 160) + " [done]" + '"' in result_text
    assert '"usage": {' in result_text
    assert '"capture": {' in result_text
    assert "complete result detail" in result_text

    path_with_extra = write_thinking_debug(
        messages=messages,
        tools=tools,
        result=result,
        extra_body={},
        context=context,
    )

    assert path_with_extra is not None
    assert "## extra_body" in path_with_extra.read_text(encoding="utf-8")


def test_thinking_debug_uses_internal_sibling_of_workdir(tmp_path, monkeypatch) -> None:
    work = tmp_path / ".work"
    work.mkdir()
    workspace = Workspace("session", session_root=tmp_path)
    monkeypatch.setenv(THINKING_DEBUG_ENV_VAR, "1")

    path = write_thinking_debug(
        messages=[Message.from_text("hello", role=Role.USER)],
        tools=[],
        result=StreamResult(tool_calls=[], content="done"),
        extra_body=None,
        context=AmphiContext(workspace=workspace),
    )

    assert path is not None
    assert path.parent == _debug_dir(tmp_path)
    timestamp = path.stem.removeprefix("ota-")
    assert (path.parent / f"ota-messages-{timestamp}-").is_dir()
    assert (path.parent / f"ota-result-{timestamp}-" / "result.md").is_file()


@pytest.mark.asyncio
async def test_thinking_debug_is_written_from_thinking(tmp_path, monkeypatch) -> None:
    class FakeLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body):
            return StreamResult(tool_calls=[], content="done")

    context = _context(tmp_path)
    ota = AmphiOTAContext.model_validate({"user_input": "hi"})
    worker = MainThink()
    worker.allowed_tools = frozenset({"bash"})
    worker._llm = FakeLlm()
    monkeypatch.setenv(THINKING_DEBUG_ENV_VAR, "true")

    tool_calls, content = await worker.thinking(ota, context)

    assert tool_calls == []
    assert content == "done"
    files = list(_debug_dir(Path(context.session.workspace_root)).glob("ota-*.md"))
    assert len(files) == 1
    path = files[0]
    text = path.read_text(encoding="utf-8")
    assert "## messages" in text
    assert "## result" in text
    assert "content" in text
    assert "## tools" in text
