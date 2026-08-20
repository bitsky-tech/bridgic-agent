import pytest
from bridgic.core.model.types import Message, Role

from src.amphi_agent import AmphiContext, Session
from src.amphi_agent._thinking_debug import THINKING_DEBUG_ENV_VAR, write_thinking_debug
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


def test_debug_bundle(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final thinking diagnostics:

    {
      "disabled": "no files",
      "enabled": {
        "index": "ota-<timestamp>.md",
        "messages": ["system", "user"],
        "result": "answer and Tool Calls",
        "request": "tools and extra_body"
      }
    }

    Checks:
    1. Diagnostics disabled by default do not create a debug directory.
    2. Enabling diagnostics writes one navigable bundle with messages, result, and request data.
    """
    session_root = test_sandbox.sessions / "session-debug"
    session_root.mkdir(parents=True)
    context = AmphiContext(session=Session(SessionRecord(
        id="session-debug",
        user_id="local",
        workspace_root=str(session_root),
    ), []))
    messages = [
        Message.from_text("System guidance", role=Role.SYSTEM),
        Message.from_text("Create <report>", role=Role.USER),
    ]
    result = {
        "content": "Report created",
        "tool_calls": [{"name": "write_file", "arguments": {"file_path": "report.md"}}],
    }
    debug_root = session_root / "_msg_debug"

    # Check 1: The disabled diagnostic path has no observable filesystem effect.
    monkeypatch.delenv(THINKING_DEBUG_ENV_VAR, raising=False)
    assert write_thinking_debug(
        messages=messages,
        tools=[{"name": "write_file"}],
        result=result,
        extra_body={"reasoning_effort": "medium"},
        context=context,
    ) is None
    assert not debug_root.exists()

    # Check 2: One enabled call creates an index linked to complete message and result artifacts.
    monkeypatch.setenv(THINKING_DEBUG_ENV_VAR, "1")
    index = write_thinking_debug(
        messages=messages,
        tools=[{"name": "write_file"}],
        result=result,
        extra_body={"reasoning_effort": "medium"},
        context=context,
    )
    assert index is not None
    assert index.parent == debug_root
    index_text = index.read_text(encoding="utf-8")
    assert "message 001" in index_text
    assert "message 002" in index_text
    assert "Create &lt;report&gt;" in index_text
    assert "Report created" in index_text
    assert '"name": "write_file"' in index_text
    assert '"reasoning_effort": "medium"' in index_text

    message_files = sorted(debug_root.glob("ota-messages-*/*.md"))
    result_files = sorted(debug_root.glob("ota-result-*/result.md"))
    assert sorted(debug_root.glob("ota-*.md")) == [index]
    assert [path.name for path in message_files] == [
        "message-001-system.md",
        "message-002-user.md",
    ]
    assert len(result_files) == 1
    assert "System guidance" in message_files[0].read_text(encoding="utf-8")
    assert "Create <report>" in message_files[1].read_text(encoding="utf-8")
    assert "Report created" in result_files[0].read_text(encoding="utf-8")
