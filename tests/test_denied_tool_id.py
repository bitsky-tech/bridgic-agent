"""Regression: denied tool calls must get UNIQUE tool_call_ids.

The old `_denied_step` hard-coded `tool_id=f"deny_{cv.tool}"`, so two denials of
the SAME tool in one history (e.g. two `edit_file`) collided on `deny_edit_file`,
and the LLM API rejected the request with:

    400 - Duplicate value for 'tool_call_id' of deny_edit_file in message[10]

Each denied step's id must instead be unique (and equal to its verdict's id, so
the synthesized assistant tool_call and its tool result pair correctly).
"""
from pathlib import Path

from bridgic.amphibious import StepToolCall, ToolArgument
from bridgic.amphibious._type import ThinkResult

from src.amphi_agent import AmphiContext, AmphiOTAContext
from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._state import CallVerdict
from src.amphi_agent._workspace import Workspace


def test_denied_steps_of_same_tool_get_unique_tool_ids():
    # The exact case that 400'd: two edit_file calls denied together.
    cv1 = CallVerdict(tool="edit_file", arguments={"path": "a"}, verdict="deny", reason="x")
    cv2 = CallVerdict(tool="edit_file", arguments={"path": "b"}, verdict="deny", reason="y")
    s1 = AmphiAgent._denied_step(cv1)
    s2 = AmphiAgent._denied_step(cv2)
    assert s1.tool_id != s2.tool_id


def test_denied_step_tool_id_equals_verdict_id():
    # Same id on both sides → assistant tool_call and its result pair up.
    cv = CallVerdict(tool="edit_file", verdict="deny", reason="x")
    assert AmphiAgent._denied_step(cv).tool_id == cv.id


async def test_denied_step_preserves_original_tool_call_id(tmp_path: Path):
    call = StepToolCall(
        call_id="call_original_123",
        tool="edit_file",
        tool_arguments=[
            ToolArgument(name="file_path", value="/etc/hosts"),
            ToolArgument(name="old_string", value="a"),
            ToolArgument(name="new_string", value="b"),
        ],
    )
    ota = AmphiOTAContext(user_input="x")
    ota.think_result = ThinkResult(step_content="", tool_calls=[call])
    context = AmphiContext(workspace=Workspace("session", session_root=tmp_path))

    verdict = (await AmphiAgent().permission_check(ota, context))[0]
    assert AmphiAgent._denied_step(verdict).tool_id == "call_original_123"
