from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from bridgic.amphibious import OTARecord, StepToolCall
from bridgic.amphibious._type import ThinkResult
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent.cognitive.state import CallVerdict, RoundPermission
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.security import Permission
from src.amphi_store import SessionRecord
from tests._support.sandbox import IsolatedPaths


@pytest.mark.parametrize("failed_ppt_rag", [False, True], ids=["ordinary-result", "failed-ppt-rag"])
async def test_large_tool_result(test_sandbox: IsolatedPaths, failed_ppt_rag: bool) -> None:
    """Final oversized output or error:

    {
      "inline_result": "file pointer",
      "stored_file": "inside the owning Session tool-result directory",
      "stored_content": "complete original output",
      "stream_output": "same bounded pointer"
    }

    Checks:
    1. An ordinary output and a failed PPT retrieval error use the generic spill path.
    2. The model-visible result becomes a file reference inside the owning Session.
    3. The stored file is complete and the live event exposes only the bounded reference.
    """
    payload = "report-line\n" * 2000

    async def large_report() -> str:
        if failed_ppt_rag:
            raise RuntimeError(payload)
        return payload

    tool_name = "ppt_rag" if failed_ppt_rag else "large_report"
    large_report.__name__ = tool_name
    events: list[tuple[str, dict[str, object]]] = []
    stream = SimpleNamespace(
        publish=lambda event, **data: events.append((event, data)),
    )
    call = StepToolCall(
        call_id="call-large",
        tool=tool_name,
        tool_arguments=[],
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
                arguments={},
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
        tools=[FunctionToolSpec.from_raw(large_report)],
        stream=stream,
    )

    result = await AmphiAgent().action_tool_call(ota_context, context)

    # Check 1: Execution preserves success or failure independently of the spill path.
    assert len(result.results) == 1
    step = result.results[0]
    assert step.tool_id == call.call_id
    assert step.tool_name == tool_name
    assert step.success is not failed_ppt_rag
    if failed_ppt_rag:
        assert step.tool_result is None

    # Check 2: The next model round receives a bounded pointer in this Session's directory.
    pointer = str(step.error if failed_ppt_rag else step.tool_result)
    assert "Tool result exceeded inline limit" in pointer
    assert payload not in pointer
    path_line = next(line for line in pointer.splitlines() if line.startswith("Path: "))
    stored_path = Path(path_line.removeprefix("Path: "))
    assert stored_path.is_relative_to(workspace.tool_result_dir.resolve())

    # Check 3: Disk preserves the full output while streaming publishes the same pointer.
    assert stored_path.read_text(encoding="utf-8") == payload
    result_events = [data for event, data in events if event == "tool_result"]
    assert len(result_events) == 1
    assert result_events[0]["error" if failed_ppt_rag else "output"] == pointer
    assert result_events[0]["success"] is not failed_ppt_rag
    assert payload not in str(result_events[0])
