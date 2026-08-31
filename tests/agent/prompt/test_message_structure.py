import json
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Role, ToolCallBlock, ToolResultBlock

from src.amphi_agent import AmphiContext, AmphiOTAContext, LlmProvider, MainThink, Session
from src.amphi_agent._cognitive import render_input
from src.amphi_agent._prompt import TURN_FAILED_MESSAGE
from src.amphi_agent._workspace import Workspace
from src.amphi_service.i18n import backend_i18n, use_locale
from src.amphi_service.protocol.llms._image_inputs import IMAGE_INPUTS_EXTRA, ImageInputUnsupportedError
from src.amphi_store import SessionMountRecord, SessionRecord, SessionTurnRecord, TurnStatus, UserInput
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-a"
PROMPT_TIME = "2026-08-19 12:00 (UTC+08:00)"
EXPECTED_TURN_FAILED_MESSAGE = (
    "<turn_failed>This Turn failed before completion. "
    "Its preceding Agent content may be incomplete.</turn_failed>"
)


def _turn(
    turn_id: str,
    ordinal: int,
    text: str,
    ota_records: list[dict[str, Any]],
    status: TurnStatus = TurnStatus.COMPLETED,
    error: str | None = None,
    blocks: list[dict[str, Any]] | None = None,
    agent_state: dict[str, Any] | None = None,
) -> SessionTurnRecord:
    return SessionTurnRecord(
        id=turn_id,
        user_id=USER_ID,
        session_id=SESSION_ID,
        session_ordinal=ordinal,
        user_input=UserInput(text=text, blocks=blocks or []),
        ota_records=ota_records,
        agent_state=agent_state or {},
        status=status,
        error=error,
    )


def _context(turns: list[SessionTurnRecord], workspace: Workspace | None = None, llm_provider: LlmProvider | None = None) -> AmphiContext:
    record = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root="/sessions/session-a",
    )
    return AmphiContext(
        session=Session(record, turns),
        workspace=workspace,
        llm_provider=llm_provider or LlmProvider(),
    )


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


async def test_historical_structured_input(test_sandbox: IsolatedPaths) -> None:
    """A persisted structured input is re-rendered like the current input."""
    mounted_root = test_sandbox.root / "historical-project"
    mount = SessionMountRecord(
        id="mount-historical",
        session_id=SESSION_ID,
        user_id=USER_ID,
        name="historical-project",
        abs_path=str(mounted_root),
        kind="folder",
    )
    workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID, mounts=[mount])
    history = _turn(
        "turn-structured",
        0,
        "/build Create report from @Project and @Removed",
        [{"think_result": {"step_content": "Historical structured answer", "tool_calls": []}}],
        blocks=[
            {"type": "slash", "id": "build", "label": "build", "resource": None},
            {"type": "text", "value": " Create report from "},
            {
                "type": "mention",
                "id": "mount-historical",
                "label": "Project",
                "group": "",
                "path": "spec.md",
            },
            {"type": "text", "value": " and "},
            {
                "type": "mention",
                "id": "removed-mount",
                "label": "Removed",
                "group": "",
                "path": "",
            },
        ],
    )

    messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME),
        _context([history], workspace),
    )

    assert [message.role for message in messages] == [
        Role.SYSTEM,
        Role.USER,
        Role.AI,
        Role.USER,
    ]
    assert messages[1].content.startswith(
        "I explicitly request that the following requirement be built into a reusable Workflow. "
        "Build requirement:"
    )
    assert f"Create report from Project({mounted_root / 'spec.md'}) and @Removed" in messages[1].content
    assert "removed-mount" not in messages[1].content
    assert "<current_time>" not in messages[1].content
    assert messages[2].content == "Historical structured answer"


async def test_image_mentions_become_multimodal_current_and_historical_messages(test_sandbox: IsolatedPaths) -> None:
    """Owned image mentions retain readable path text and add lightweight image metadata."""
    image_path = test_sandbox.root / "screenshot.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"image-payload")
    mount = SessionMountRecord(
        id="mount-image",
        session_id=SESSION_ID,
        user_id=USER_ID,
        name="screenshot.png",
        abs_path=str(image_path),
        kind="file",
    )
    workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID, mounts=[mount])
    image_blocks = [{
        "type": "mention",
        "id": "mount-image",
        "label": "screenshot.png",
        "group": "文件/文件夹",
    }]
    history = _turn(
        "turn-image",
        0,
        "@screenshot.png",
        [{"think_result": {"step_content": "Past image answer", "tool_calls": []}}],
        blocks=image_blocks,
    )
    provider = LlmProvider(model_id="gpt-5.6-sol", provider_id="openai-codex")
    current = UserInput(text="@screenshot.png", blocks=image_blocks)

    messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input=current, prompt_time=PROMPT_TIME),
        _context([history], workspace, provider),
    )

    historical_image = messages[1].extras[IMAGE_INPUTS_EXTRA][0]
    current_image = messages[3].extras[IMAGE_INPUTS_EXTRA][0]
    assert historical_image == current_image == {
        "path": str(image_path),
        "media_type": "image/png",
        "size_bytes": image_path.stat().st_size,
        "name": "screenshot.png",
    }
    assert f"screenshot.png({image_path})" in messages[1].content
    assert f"screenshot.png({image_path})" in messages[3].content
    assert "data" not in current_image


async def test_known_text_only_model_rejects_current_image_with_actionable_error(test_sandbox: IsolatedPaths) -> None:
    """Known text-only models fail before a provider request instead of dropping the image."""
    image_path = test_sandbox.root / "diagram.png"
    image_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"image-payload")
    mount = SessionMountRecord(
        id="mount-image",
        session_id=SESSION_ID,
        user_id=USER_ID,
        name="diagram.png",
        abs_path=str(image_path),
        kind="file",
    )
    workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID, mounts=[mount])
    user_input = UserInput(text="@diagram.png", blocks=[{
        "type": "mention",
        "id": "mount-image",
        "label": "diagram.png",
        "group": "文件/文件夹",
    }])
    provider = LlmProvider(model_id="deepseek-v4-pro", provider_id="deepseek")

    with pytest.raises(ImageInputUnsupportedError, match="deepseek-v4-pro"):
        await MainThink().assemble_messages(
            AmphiOTAContext(user_input=user_input, prompt_time=PROMPT_TIME),
            _context([], workspace, provider),
        )


async def test_unavailable_historical_image_does_not_block_a_new_text_turn(test_sandbox: IsolatedPaths) -> None:
    """Deleted old attachments degrade to their path text instead of poisoning the Session."""
    missing_path = test_sandbox.root / "removed.png"
    mount = SessionMountRecord(
        id="mount-removed-image",
        session_id=SESSION_ID,
        user_id=USER_ID,
        name="removed.png",
        abs_path=str(missing_path),
        kind="file",
    )
    workspace = Workspace(SESSION_ID, test_sandbox.sessions / SESSION_ID, mounts=[mount])
    history = _turn(
        "turn-removed-image",
        0,
        "@removed.png",
        [{"think_result": {"step_content": "Past answer", "tool_calls": []}}],
        blocks=[{
            "type": "mention",
            "id": "mount-removed-image",
            "label": "removed.png",
            "group": "文件/文件夹",
        }],
    )
    provider = LlmProvider(model_id="gpt-5.6-sol", provider_id="openai-codex")

    messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input="Continue with text", prompt_time=PROMPT_TIME),
        _context([history], workspace, provider),
    )

    assert IMAGE_INPUTS_EXTRA not in messages[1].extras
    assert f"removed.png({missing_path})" == messages[1].content
    assert messages[3].content.startswith("Continue with text")


def test_intent_language_falls_back_to_the_client_locale() -> None:
    """Final intent-sentence language:

    {
      "slash_only_under_en": "English",
      "slash_only_under_zh": "Chinese",
      "prose_present": "the user's own prose still decides",
      "cjk_labels_under_en": "English"
    }

    Checks:
    1. A slash carrying no readable prose renders its intent in the client's locale, not
       in the product default — an English client must never be handed a Chinese request
       it did not write.
    2. The same input under a Chinese client renders the Chinese intent.
    3. Prose the user actually typed still decides the language, whatever the locale is.
    4. Slash and mention labels are not prose and never decide the language.
    """
    # Only text blocks count as prose, so a slash-only turn — a bare /build, or a
    # Workflow run with nothing typed after it — carries no language of its own.
    build_only = SimpleNamespace(
        input="/build",
        blocks=[SimpleNamespace(type="slash", id="build", label="build", resource=None)],
    )
    workflow_only = SimpleNamespace(
        input="/Daily Digest",
        blocks=[
            SimpleNamespace(type="slash", id="wf-a", label="Daily Digest", resource="workflow")
        ],
    )
    workflow_with_prose = SimpleNamespace(
        input="/Daily Digest for the current week",
        blocks=[
            SimpleNamespace(type="slash", id="wf-a", label="Daily Digest", resource="workflow"),
            SimpleNamespace(type="text", value=" for the current week"),
        ],
    )

    def expected(message_id: str, locale: str) -> str:
        return backend_i18n.text(message_id, locale=locale, label="Daily Digest", workflow_id="wf-a")

    # Check 1: A slash carrying no readable prose renders its intent in the client's locale.
    with use_locale("en"):
        assert render_input(build_only) == expected("agent.input.build_intent", "en")
        assert render_input(workflow_only) == expected("agent.input.workflow_run_intent", "en")

    # Check 2: The same input under a Chinese client renders the Chinese intent.
    with use_locale("zh"):
        assert render_input(build_only) == expected("agent.input.build_intent", "zh")
        assert render_input(workflow_only) == expected("agent.input.workflow_run_intent", "zh")

    # Check 3: Prose the user actually typed still decides the language, whatever the locale.
    with use_locale("zh"):
        assert render_input(workflow_with_prose) == (
            expected("agent.input.workflow_run_intent", "en") + " for the current week"
        )

    # Check 4: A label is not prose. Whoever named the Workflow or the folder does not get
    # to pick the language of a request the user did not write — the CJK data below is the
    # point of the case, not display copy.
    cjk_workflow = SimpleNamespace(
        input="/生成报告",
        blocks=[SimpleNamespace(type="slash", id="wf-b", label="生成报告", resource="workflow")],
    )
    cjk_mention = SimpleNamespace(
        input="/build @项目",
        blocks=[
            SimpleNamespace(type="slash", id="build", label="build", resource=None),
            SimpleNamespace(type="mention", id="m-1", label="项目", group="", path=""),
        ],
    )
    with use_locale("en"):
        assert render_input(cjk_workflow) == backend_i18n.text(
            "agent.input.workflow_run_intent", locale="en", label="生成报告", workflow_id="wf-b"
        )
        assert render_input(cjk_mention).startswith(
            backend_i18n.text("agent.input.build_intent", locale="en")
        )


async def test_session_replay() -> None:
    """Final Session replay:

    {
      "completed": ["question", "assistant tool call", "tool result", "answer"],
      "interrupted": ["question", "visible assistant text"],
      "failed": ["question", "agent reply", "failure marker"],
      "dangling_tool_calls": 0
    }

    Checks:
    1. A completed historical tool call keeps its native Assistant and Tool pair.
    2. A completed Turn ends with its persisted final answer.
    3. An interrupted call falls back to visible text instead of a dangling Tool Call.
    4. A failed Turn keeps both sides, then ends with a sanitized failure marker.
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

    # Check 4: A failed Turn keeps both sides and marks the incomplete outcome without its raw error.
    assert messages[7].content == "Trigger the failed request"
    assert messages[8].role is Role.AI
    assert messages[8].content == "Unreliable failed reply"
    assert messages[9].role is Role.AI
    assert TURN_FAILED_MESSAGE == EXPECTED_TURN_FAILED_MESSAGE
    assert messages[9].content == EXPECTED_TURN_FAILED_MESSAGE
    assert [message.content for message in messages].count(EXPECTED_TURN_FAILED_MESSAGE) == 1
    assert messages[10].content.startswith("Current request\n\n<current_time>")
    serialized_messages = json.dumps(
        [message.model_dump(mode="json") for message in messages],
        ensure_ascii=False,
    )
    assert "Provider unavailable" not in serialized_messages


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


async def test_session_history_has_no_record_limit() -> None:
    """Final untruncated Session replay:

    {
      "older_turn": ["Older question", "Older answer"],
      "newer_turn": ["Recent question", "Recent answer"],
      "current_input": "Current request"
    }

    Checks:
    1. Session history exceeding 100 OTA records is replayed in full.
    2. Every historical Turn remains in chronological order.
    3. The complete history remains before the current User message.
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
    assert len(older_records) + len(newer_records) > 100
    history = [
        _turn("turn-older", 0, "Older question", older_records),
        _turn("turn-newer", 1, "Recent question", newer_records),
    ]
    ota_context = AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME)

    messages = await MainThink().assemble_messages(ota_context, _context(history))

    # Check 1: Session history exceeding 100 OTA records is replayed in full.
    assert messages[1].content == "Older question"
    assert messages[2].content == "Older answer"

    # Check 2: Every historical Turn remains in chronological order.
    assert messages[3].content == "Recent question"
    assert messages[4].content == "Recent answer"

    # Check 3: The complete history remains before the current User message.
    assert [message.role for message in messages] == [
        Role.SYSTEM,
        Role.USER,
        Role.AI,
        Role.USER,
        Role.AI,
        Role.USER,
    ]
    assert messages[5].content.startswith("Current request\n\n<current_time>")


async def test_session_compaction_replays_its_summary_and_full_completed_turns() -> None:
    """Session summaries replace covered Turns while completed Turns replay their durable raw trace."""
    history = [
        _turn(
            "turn-covered",
            0,
            "Covered question",
            [{"think_result": {"step_content": "Covered answer", "tool_calls": []}}],
        ),
        _turn(
            "turn-partial",
            1,
            "Partially compacted question",
            [
                {"think_result": {"step_content": "Covered round", "tool_calls": []}},
                {"think_result": {"step_content": "Uncovered round", "tool_calls": []}},
            ],
            agent_state={
                "context_compaction": {
                    "turn": {
                        "build": {
                            "clarify": {
                                "turn_summary": "Earlier work in this Turn",
                                "turn_through_round": 1,
                            },
                        },
                    },
                },
            },
        ),
        _turn(
            "turn-recent",
            2,
            "Recent question",
            [{"think_result": {"step_content": "Recent answer", "tool_calls": []}}],
        ),
    ]
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time=PROMPT_TIME,
        state={
            "context_compaction": {
                "session_summary": "Earlier Session work",
                "session_through_ordinal": 0,
            },
        },
    )

    messages = await MainThink().assemble_messages(ota_context, _context(history))
    contents = [message.content for message in messages]

    assert "Covered question" not in contents
    assert "Covered answer" not in contents
    assert contents[1] == (
        '<session_history_summary through_ordinal="0">\n'
        "Earlier Session work\n"
        "</session_history_summary>"
    )
    assert "Earlier work in this Turn" not in contents
    assert contents[2:4] == [
        "Partially compacted question",
        "Uncovered round",
    ]
    assert contents[4:6] == ["Recent question", "Recent answer"]
    assert contents[6].startswith("Current request\n\n<current_time>")


async def test_completed_normal_turn_reuses_its_global_compaction() -> None:
    """A normal-mode Turn summary remains a safe projection of its complete OTA timeline."""
    history = [
        _turn(
            "turn-normal-compacted",
            0,
            "Normal question",
            [
                {"think_result": {"step_content": "Covered round", "tool_calls": []}},
                {"think_result": {"step_content": "Uncovered round", "tool_calls": []}},
            ],
            agent_state={
                "context_compaction": {
                    "turn": {
                        "normal": {
                            "main": {
                                "turn_summary": "Earlier normal work",
                                "turn_through_round": 1,
                            },
                        },
                    },
                },
            },
        ),
    ]
    ota_context = AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME)

    messages = await MainThink().assemble_messages(ota_context, _context(history))
    contents = [message.content for message in messages]

    assert contents[1:4] == [
        "Normal question",
        '<turn_history_summary through_round="1">\nEarlier normal work\n</turn_history_summary>',
        "Uncovered round",
    ]
    assert contents[4].startswith("Current request\n\n<current_time>")


async def test_current_turn_compaction_keeps_only_uncovered_rounds() -> None:
    """The current Turn renders its summary before rounds beyond the persisted boundary."""
    ota_context = AmphiOTAContext(
        user_input="Current request",
        prompt_time=PROMPT_TIME,
        ota_record=[
            OTARecord(think_result={"step_content": "Covered round one", "tool_calls": []}),
            OTARecord(think_result={"step_content": "Covered round two", "tool_calls": []}),
            OTARecord(think_result={"step_content": "Uncovered round", "tool_calls": []}),
        ],
        state={
            "context_compaction": {
                "turn": {
                    "normal": {
                        "main": {
                            "turn_summary": "Earlier work in the current Turn",
                            "turn_through_round": 2,
                        },
                    },
                },
            },
        },
    )

    messages = await MainThink().assemble_messages(ota_context, _context([]))
    contents = [message.content for message in messages]

    assert "Covered round one" not in contents
    assert "Covered round two" not in contents
    assert contents[2:] == [
        '<turn_history_summary through_round="2">\n'
        "Earlier work in the current Turn\n"
        "</turn_history_summary>",
        "Uncovered round",
    ]
