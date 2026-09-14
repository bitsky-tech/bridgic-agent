from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall
from bridgic.amphibious._type import ThinkResult
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent import _agent
from src.amphi_agent._agent import TOOL_RESULT_INLINE_CHAR_LIMIT
from src.amphi_agent.cognitive.state import CallVerdict, RoundPermission
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.security import Permission
from src.amphi_agent.tools._filesystem import READ_FILE_MAX_CHARS, read_file
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


@pytest.mark.parametrize("scenario", ["large_report", "ppt_rag", "read_file", "failed_read_file"], ids=["ordinary-result", "failed-ppt-rag", "bounded-read-file", "failed-read-file"])
async def test_large_tool_result(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch, scenario: str) -> None:
    """Stream the model-visible result, retaining successful bounded reads and spooling oversized outputs or errors."""
    payload = "report-line\n" * 2000
    tool_name = "read_file" if scenario == "failed_read_file" else scenario
    failed = scenario in {"ppt_rag", "failed_read_file"}

    async def large_report() -> str:
        if scenario == "ppt_rag":
            raise RuntimeError(payload)
        return payload

    large_report.__name__ = tool_name
    arguments = {}
    tool = large_report
    expected = payload
    if scenario == "read_file":
        target = test_sandbox.root / "requirements.txt"
        target.write_text(payload, encoding="utf-8")
        arguments = {"file_path": str(target)}
        tool = read_file
        expected = await read_file(str(target))
        # Exercise the exemption through real execution even if the limits diverge.
        monkeypatch.setattr(_agent, "TOOL_RESULT_INLINE_CHAR_LIMIT", 1024)
        assert 1024 < len(expected) <= READ_FILE_MAX_CHARS
    elif scenario == "failed_read_file":
        target = test_sandbox.root / ("x" * 20_000)
        arguments = {"file_path": str(target)}
        tool = read_file
        payload = f"File does not exist: {target}"
        assert len(payload) > TOOL_RESULT_INLINE_CHAR_LIMIT

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
    workspace.work_dir.mkdir(parents=True)
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

    # Bind the runtime Workspace and read tracker used by the real filesystem tool.
    token = current_agent.set(SimpleNamespace(ctx=context, _read_tracker={}))
    try:
        result = await AmphiAgent().action_tool_call(ota_context, context)
    finally:
        current_agent.reset(token)

    # Check 1: Execution preserves success or failure independently of the spill path.
    assert len(result.results) == 1
    step = result.results[0]
    assert step.tool_id == call.call_id
    assert step.tool_name == tool_name
    assert step.success is not failed
    if failed:
        assert step.tool_result is None

    result_events = [data for event, data in events if event == "tool_result"]
    assert len(result_events) == 1
    assert result_events[0]["error" if failed else "output"] == (step.error if failed else step.tool_result)
    assert result_events[0]["success"] is not failed
    if scenario == "read_file":
        assert step.tool_result == expected
        assert not list(workspace.tool_result_dir.rglob("*.txt"))
        return

    # Check 2: The next model round receives a bounded pointer in this Session's directory.
    pointer = str(step.error if failed else step.tool_result)
    assert "Tool result exceeded inline limit" in pointer
    assert len(pointer) <= TOOL_RESULT_INLINE_CHAR_LIMIT
    assert payload not in pointer
    path_line = next(line for line in pointer.splitlines() if line.startswith("Path: "))
    stored_path = Path(path_line.removeprefix("Path: "))
    assert stored_path.is_relative_to(workspace.tool_result_dir.resolve())

    # Check 3: Disk preserves the full output while streaming publishes the same pointer.
    assert stored_path.read_text(encoding="utf-8") == payload
    assert result_events[0]["error" if failed else "output"] == pointer
    assert payload not in str(result_events[0])


def test_read_file_is_exempt_in_mixed_results(test_sandbox: IsolatedPaths) -> None:
    """Keep a read result inline above the generic limit without exempting sibling results."""
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
