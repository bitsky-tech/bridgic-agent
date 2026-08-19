from types import SimpleNamespace
from typing import Any

from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Role, ToolCallBlock, ToolResultBlock

from src.amphi_agent import AmphiContext, AmphiOTAContext, MainThink, Session
from src.amphi_agent._workspace import Workspace
from src.amphi_store import SessionMountRecord, SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-a"
PROMPT_TIME = "2026-08-19 12:00 (UTC+08:00)"


def _turn(
    turn_id: str,
    ordinal: int,
    text: str,
    ota_records: list[dict[str, Any]],
    status: TurnStatus = TurnStatus.COMPLETED,
    error: str | None = None,
) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=turn_id,
        user_id=USER_ID,
        session_id=SESSION_ID,
        session_ordinal=ordinal,
        user_input=UserInput(text=text),
        ota_records=ota_records,
        agent_state={},
        status=status,
        error=error,
    )


def _context(turns: list[SessionTurnRecord], workspace: Workspace | None = None) -> AmphiContext:
    record = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root="/sessions/session-a",
    )
    return AmphiContext(session=Session(record, turns), workspace=workspace)


async def test_message_order() -> None:
    """Final model input:

    {
      "roles": ["system", "user", "assistant", "user", "assistant", "tool", "user"],
      "system": "Persona + <context>",
      "session_history": ["Past question", "Past answer"],
      "current_input": "Current request + <current_time>",
      "turn_history": ["Inspect the file", "File contents", "Continue"]
    }

    Checks:
    1. Persona and dynamic Context occupy the first System message only.
    2. Previous Session Turns replay after System in their native roles.
    3. The current input is one User message after the Session history.
    4. Current Turn activity follows the input as paired Assistant, Tool, and observation messages.
    """
    history = [
        _turn(
            "turn-past",
            0,
            "Past question",
            [{"think_result": {"step_content": "Past answer", "tool_calls": []}}],
        )
    ]
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time=PROMPT_TIME,
        ota_record=[
            OTARecord(
                think_result={"step_content": "Inspect the file", "tool_calls": []},
                action_result=ActionResult(
                    results=[
                        ActionStepResult(
                            tool_id="call-current",
                            tool_name="read_file",
                            tool_arguments={"file_path": "README.md"},
                            tool_result="File contents",
                        )
                    ]
                ),
                observation_result="Continue",
            )
        ],
    )

    messages = await MainThink().assemble_messages(ota_context, _context(history))

    # Check 1: Persona and dynamic Context occupy the first System message only.
    assert [message.role for message in messages] == [
        Role.SYSTEM,
        Role.USER,
        Role.AI,
        Role.USER,
        Role.AI,
        Role.TOOL,
        Role.USER,
    ]
    assert "You are Bridgic Agent" in messages[0].content
    assert "<context>" in messages[0].content
    assert "</context>" in messages[0].content
    assert "Past question" not in messages[0].content
    assert "Current request" not in messages[0].content

    # Check 2: Previous Session Turns replay after System in their native roles.
    assert messages[1].content == "Past question"
    assert messages[2].content == "Past answer"

    # Check 3: The current input is one User message after the Session history.
    assert messages[3].content == (
        "Current request\n\n"
        f"<current_time>\n{PROMPT_TIME}\n</current_time>"
    )
    assert "Past answer" not in messages[3].content

    # Check 4: Current Turn activity follows the input as paired Assistant, Tool, and observation messages.
    current_call = next(block for block in messages[4].blocks if isinstance(block, ToolCallBlock))
    current_result = next(block for block in messages[5].blocks if isinstance(block, ToolResultBlock))
    assert messages[4].content == "Inspect the file"
    assert current_call.id == "call-current"
    assert current_call.name == "read_file"
    assert current_call.arguments == {"file_path": "README.md"}
    assert current_result.id == current_call.id
    assert current_result.content == "File contents"
    assert messages[6].content == "Continue"


async def test_structured_input(test_sandbox: IsolatedPaths) -> None:
    """Final structured current inputs:

    {
      "build": "explicit intent + ordered text + resolved and unresolved mentions",
      "workflow": "explicit saved Workflow identity + run input",
      "message_role": "one User message before current Turn activity"
    }

    Checks:
    1. A Build slash block becomes an explicit Build intent in the current User message.
    2. Text and mention blocks retain order while only mounted paths resolve to absolute paths.
    3. A Workflow slash block preserves the selected Workflow name, id, and run input.
    4. Both structured requests remain one User message and retain the current-time suffix.
    """
    mounted_root = test_sandbox.root / "mounted-project"
    mount = SessionMountRecord(
        id="mount-project",
        session_id=SESSION_ID,
        user_id=USER_ID,
        name="mounted-project",
        abs_path=str(mounted_root),
        kind="folder",
    )
    workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID, mounts=[mount])
    context = _context([], workspace)
    build_input = SimpleNamespace(
        input="/build Create report from @Project and @Removed",
        blocks=[
            SimpleNamespace(type="slash", id="build", label="build", resource=None),
            SimpleNamespace(type="text", value=" Create report from "),
            SimpleNamespace(
                type="mention",
                id="mount-project",
                label="Project",
                group="",
                path="spec.md",
            ),
            SimpleNamespace(type="text", value=" and "),
            SimpleNamespace(
                type="mention",
                id="removed-mount",
                label="Removed",
                group="",
                path="",
            ),
        ],
    )
    workflow_input = SimpleNamespace(
        input="/workflow-a for the current week",
        blocks=[
            SimpleNamespace(
                type="slash",
                id="workflow-a",
                label="Weekly report",
                resource="workflow",
            ),
            SimpleNamespace(type="text", value=" for the current week"),
        ],
    )

    build_messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input=build_input, prompt_time=PROMPT_TIME),
        context,
    )
    workflow_messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input=workflow_input, prompt_time=PROMPT_TIME),
        context,
    )
    build_message = build_messages[1]
    workflow_message = workflow_messages[1]
    resolved_path = mounted_root / "spec.md"

    # Check 1: A Build slash block becomes an explicit Build intent in the current User message.
    assert build_message.content.startswith(
        "I explicitly request that the following requirement be built into a reusable Workflow. "
        "Build requirement:"
    )

    # Check 2: Text and mention blocks retain order while only mounted paths resolve to absolute paths.
    expected_request = f"Create report from Project({resolved_path}) and @Removed"
    assert expected_request in build_message.content
    assert "removed-mount" not in build_message.content

    # Check 3: A Workflow slash block preserves the selected Workflow name, id, and run input.
    assert workflow_message.content.startswith(
        "I explicitly request to run the saved Workflow “Weekly report” "
        "(workflow_id: `workflow-a`). Run input: for the current week"
    )

    # Check 4: Both structured requests remain one User message and retain the current-time suffix.
    for messages in (build_messages, workflow_messages):
        assert [message.role for message in messages] == [Role.SYSTEM, Role.USER]
        assert messages[1].content.endswith(f"<current_time>\n{PROMPT_TIME}\n</current_time>")


async def test_session_replay() -> None:
    """Final Session replay:

    {
      "completed": ["question", "assistant tool call", "tool result", "answer"],
      "interrupted": ["question", "visible assistant text"],
      "failed": ["question"],
      "dangling_tool_calls": 0
    }

    Checks:
    1. A completed historical tool call keeps its native Assistant and Tool pair.
    2. A completed Turn ends with its persisted final answer.
    3. An interrupted call falls back to visible text instead of a dangling Tool Call.
    4. A failed Turn keeps the user's question but withholds the failed Agent reply.
    """
    complete = _turn(
        "turn-complete",
        0,
        "Read the project file",
        [
            {
                "think_result": {
                    "step_content": "I will inspect it",
                    "tool_calls": [
                        {
                            "call_id": "provider-call",
                            "tool": "read_file",
                            "tool_arguments": [
                                {"name": "file_path", "value": "README.md"}
                            ],
                        }
                    ],
                },
                "action_result": {
                    "results": [
                        {
                            "tool_id": "history-call",
                            "tool_name": "read_file",
                            "tool_arguments": {"file_path": "README.md"},
                            "tool_result": "Project readme",
                            "success": True,
                            "error": None,
                        }
                    ]
                },
            },
            {"think_result": {"step_content": "Historical answer", "tool_calls": []}},
        ],
    )
    interrupted = _turn(
        "turn-interrupted",
        1,
        "Continue the interrupted task",
        [
            {
                "think_result": {
                    "step_content": "Visible progress before interruption",
                    "tool_calls": [
                        {
                            "tool": "read_file",
                            "tool_arguments": [
                                {"name": "file_path", "value": "missing.md"}
                            ],
                        }
                    ],
                }
            }
        ],
        status=TurnStatus.CANCELLED,
    )
    failed = _turn(
        "turn-failed",
        2,
        "Trigger the failed request",
        [{"think_result": {"step_content": "Unreliable failed reply", "tool_calls": []}}],
        status=TurnStatus.FAILED,
        error="Provider unavailable",
    )
    ota_context = AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME)

    messages = await MainThink().assemble_messages(
        ota_context,
        _context([complete, interrupted, failed]),
    )

    # Check 1: A completed historical tool call keeps its native Assistant and Tool pair.
    complete_call = next(block for block in messages[2].blocks if isinstance(block, ToolCallBlock))
    complete_result = next(block for block in messages[3].blocks if isinstance(block, ToolResultBlock))
    assert messages[1].content == "Read the project file"
    assert messages[2].content == "I will inspect it"
    assert complete_call.id == "history-call"
    assert complete_result.id == complete_call.id
    assert complete_result.content == "Project readme"

    # Check 2: A completed Turn ends with its persisted final answer.
    assert messages[4].role is Role.AI
    assert messages[4].content == "Historical answer"

    # Check 3: An interrupted call falls back to visible text instead of a dangling Tool Call.
    assert messages[5].content == "Continue the interrupted task"
    assert messages[6].role is Role.AI
    assert messages[6].content == "Visible progress before interruption"
    assert not any(isinstance(block, ToolCallBlock) for block in messages[6].blocks)

    # Check 4: A failed Turn keeps the user's question but withholds the failed Agent reply.
    assert messages[7].content == "Trigger the failed request"
    assert messages[8].content.startswith("Current request\n\n<current_time>")
    assert all("Unreliable failed reply" not in message.content for message in messages)


async def test_turn_fallback() -> None:
    """Final current Turn replay:

    {
      "safe_call": {"shape": "native", "result_paired": true},
      "oversized_call": {"shape": "assistant summary", "large_value_replayed": false}
    }

    Checks:
    1. A complete bounded call is replayed as a native Assistant and Tool pair.
    2. A call with an oversized argument is summarized without exposing an invalid Tool Call.
    3. Only native calls contribute Tool Result messages to the model input.
    """
    large_content = "x" * 1300
    ota_context = AmphiOTAContext(
        user_input="Update the files",
        prompt_time=PROMPT_TIME,
        ota_record=[
            OTARecord(
                think_result={"step_content": "Read the source", "tool_calls": []},
                action_result=ActionResult(
                    results=[
                        ActionStepResult(
                            tool_id="call-safe",
                            tool_name="read_file",
                            tool_arguments={"file_path": "source.py"},
                            tool_result="Source contents",
                        )
                    ]
                ),
            ),
            OTARecord(
                think_result={"step_content": "Write the generated file", "tool_calls": []},
                action_result=ActionResult(
                    results=[
                        ActionStepResult(
                            tool_id="call-large",
                            tool_name="write_file",
                            tool_arguments={
                                "file_path": "generated.txt",
                                "content": large_content,
                            },
                            tool_result="Wrote generated.txt",
                        )
                    ]
                ),
            ),
        ],
    )

    messages = await MainThink().assemble_messages(ota_context, _context([]))

    # Check 1: A complete bounded call is replayed as a native Assistant and Tool pair.
    safe_call = next(block for block in messages[2].blocks if isinstance(block, ToolCallBlock))
    safe_result = next(block for block in messages[3].blocks if isinstance(block, ToolResultBlock))
    assert safe_call.id == "call-safe"
    assert safe_call.arguments == {"file_path": "source.py"}
    assert safe_result.id == safe_call.id
    assert safe_result.content == "Source contents"

    # Check 2: A call with an oversized argument is summarized without exposing an invalid Tool Call.
    summary = messages[4]
    assert summary.role is Role.AI
    assert "Completed historical tool activity is summarized as text" in summary.content
    assert "`content` (1300 characters)" in summary.content
    assert "Wrote generated.txt" in summary.content
    assert large_content not in summary.content
    assert not any(isinstance(block, ToolCallBlock) for block in summary.blocks)

    # Check 3: Only native calls contribute Tool Result messages to the model input.
    tool_results = [
        block
        for message in messages
        for block in message.blocks
        if isinstance(block, ToolResultBlock)
    ]
    assert [result.id for result in tool_results] == ["call-safe"]


async def test_history_limit() -> None:
    """Final bounded Session replay:

    {
      "older_turn": "excluded_whole",
      "newer_turn": ["Recent question", "Recent answer"],
      "current_input": "Current request"
    }

    Checks:
    1. The newest complete Turn is retained when the OTA record budget is reached.
    2. An older Turn that would exceed the budget is removed as one complete unit.
    3. The retained history remains before the current User message.
    """
    older_records = [
        {"think_result": {"step_content": "", "tool_calls": []}}
        for _ in range(59)
    ]
    older_records.append(
        {"think_result": {"step_content": "Older answer", "tool_calls": []}}
    )
    newer_records = [
        {"think_result": {"step_content": "", "tool_calls": []}}
        for _ in range(49)
    ]
    newer_records.append(
        {"think_result": {"step_content": "Recent answer", "tool_calls": []}}
    )
    history = [
        _turn("turn-older", 0, "Older question", older_records),
        _turn("turn-newer", 1, "Recent question", newer_records),
    ]
    ota_context = AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME)

    messages = await MainThink().assemble_messages(ota_context, _context(history))

    # Check 1: The newest complete Turn is retained when the OTA record budget is reached.
    assert messages[1].content == "Recent question"
    assert messages[2].content == "Recent answer"

    # Check 2: An older Turn that would exceed the budget is removed as one complete unit.
    assert all("Older question" not in message.content for message in messages)
    assert all("Older answer" not in message.content for message in messages)

    # Check 3: The retained history remains before the current User message.
    assert [message.role for message in messages] == [
        Role.SYSTEM,
        Role.USER,
        Role.AI,
        Role.USER,
    ]
    assert messages[3].content.startswith("Current request\n\n<current_time>")
