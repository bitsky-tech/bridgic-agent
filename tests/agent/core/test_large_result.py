from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent import _agent
from src.amphi_agent._agent import TOOL_RESULT_INLINE_CHAR_LIMIT
from src.amphi_agent._state import CallVerdict, RoundPermission
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.security import Permission
from src.amphi_agent.tools._filesystem import READ_FILE_MAX_CHARS, read_file
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


@pytest.mark.parametrize("tool_name", ["large_report", "read_file"])
async def test_large_tool_result(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch, tool_name: str) -> None:
    """Real tool execution streams the same result given to the model; only ordinary tools spool."""
    payload = "report-line\n" * 2000

    async def large_report() -> str:
        return payload

    arguments = {}
    tool = large_report
    expected = payload
    if tool_name == "read_file":
        target = test_sandbox.root / "requirements.txt"
        target.write_text(payload, encoding="utf-8")
        arguments = {"file_path": str(target)}
        tool = read_file
        expected = await read_file(str(target))
        # Exercise the exemption through the full action path even if limits diverge.
        monkeypatch.setattr(_agent, "TOOL_RESULT_INLINE_CHAR_LIMIT", 1024)
        assert 1024 < len(expected) <= READ_FILE_MAX_CHARS

    events: list[tuple[str, dict[str, object]]] = []
    stream = SimpleNamespace(
        publish=lambda event, **data: events.append((event, data)),
    )
    call = StepToolCall(
        call_id="call-large",
        tool=tool_name,
        tool_arguments=[{"name": name, "value": value} for name, value in arguments.items()],
    )
    record = OTARecord(
        think_result=ThinkResult(
            step_content="Generate the complete report.",
            tool_calls=[call],
        ),
    )
    record.permission = RoundPermission(
        execution_mode="full",
        reviewed=True,
        verdicts=[
            CallVerdict(
                id=call.call_id,
                tool=call.tool,
                arguments=arguments,
                verdict=Permission.ALLOW.value,
            ),
        ],
    )
    session_root = test_sandbox.sessions / "large-result"
    session = SessionRecord(
        id="large-result",
        user_id="local",
        workspace_root=str(session_root),
    )
    workspace = Workspace(session.id, session_root=session_root)
    context = AmphiContext(
        session=Session(session, []),
        workspace=workspace,
        execution_mode="full",
    )
    ota_context = AmphiOTAContext(
        user_input="Generate a large report.",
        ota_record=[record],
        tools=[FunctionToolSpec.from_raw(tool)],
        stream=stream,
    )

    result = await AmphiAgent().action_tool_call(ota_context, context)

    # Both tools execute successfully and publish the same result exposed to the model.
    assert len(result.results) == 1
    step = result.results[0]
    assert step.tool_id == call.call_id
    assert step.success is True
    result_events = [data for event, data in events if event == "tool_result"]
    assert len(result_events) == 1
    assert result_events[0]["output"] == step.tool_result

    if tool_name == "read_file":
        assert step.tool_result == expected
        assert not list(workspace.tool_result_dir.rglob("*.txt"))
        return

    # Ordinary outputs keep a complete on-disk copy and return a bounded pointer.
    pointer = str(step.tool_result)
    assert "Tool result exceeded inline limit" in pointer
    assert payload not in pointer
    path_line = next(line for line in pointer.splitlines() if line.startswith("Path: "))
    stored_path = Path(path_line.removeprefix("Path: "))
    assert stored_path.is_relative_to(workspace.tool_result_dir.resolve())

    assert stored_path.read_text(encoding="utf-8") == payload
    assert payload not in str(result_events[0]["output"])


def test_read_file_is_exempt_in_mixed_results(test_sandbox: IsolatedPaths) -> None:
    """A read result stays inline even above the generic limit, without exempting its siblings."""
    payload = "x" * (TOOL_RESULT_INLINE_CHAR_LIMIT + 1)
    read = ActionStepResult(
        tool_id="read", tool_name="read_file", tool_arguments={}, tool_result=payload,
    )
    report = ActionStepResult(
        tool_id="report", tool_name="large_report", tool_arguments={}, tool_result=payload,
    )
    small = ActionStepResult(
        tool_id="small", tool_name="small_report", tool_arguments={}, tool_result="small result",
    )
    workspace = Workspace("mixed-results", session_root=test_sandbox.sessions / "mixed-results")
    context = AmphiContext(workspace=workspace)

    AmphiAgent._save_large_tool_results(ActionResult(results=[read, report, small]), context)

    assert read.tool_result == payload
    assert small.tool_result == "small result"
    assert "Tool result exceeded inline limit" in report.tool_result
    files = list(workspace.tool_result_dir.rglob("*.txt"))
    assert len(files) == 1
    assert files[0].name.startswith("large_report_")
    assert files[0].read_text(encoding="utf-8") == payload
