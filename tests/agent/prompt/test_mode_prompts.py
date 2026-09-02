from types import SimpleNamespace

from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Role

import src.amphi_agent._cognitive as legacy_cognitive
from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink, Session
from src.amphi_agent._cognitive import SubAgentThink
from src.amphi_agent.cognitive import (
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    ValidateThink,
    VerifyThink,
    WorkflowThink,
)
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput


USER_ID = "local"
SESSION_ID = "session-mode"
PROMPT_TIME = "2026-08-19 12:00 (UTC+08:00)"


def test_mode_workers_are_modular_with_legacy_import_compatibility() -> None:
    """Build and Workflow workers live in cognitive modules without breaking old imports."""
    assert ClarifyThink.__module__ == "src.amphi_agent.cognitive.build"
    assert WorkflowThink.__module__ == "src.amphi_agent.cognitive.workflow"
    assert legacy_cognitive.ClarifyThink is ClarifyThink
    assert legacy_cognitive.WorkflowThink is WorkflowThink


def _context(*, child: bool = False) -> AmphiContext:
    session = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root="/sessions/session-mode",
        parent_session_id="root-session" if child else None,
    )
    history = SessionTurnRecord(
        id="turn-past",
        user_id=USER_ID,
        session_id=SESSION_ID,
        session_ordinal=0,
        user_input=UserInput(text="Past request"),
        ota_records=[
            {"think_result": {"step_content": "Past answer", "tool_calls": []}}
        ],
        agent_state={},
        status=TurnStatus.COMPLETED,
    )
    return AmphiContext(session=Session(session, [history]))


async def test_message_scopes() -> None:
    """Final special-mode message scope:

    {
      "all_special_modes": ["System", "past User/AI", "current User", "current AI"]
    }

    Checks:
    1. Every special mode keeps Persona and dynamic Context in one leading System message.
    2. Every special mode replays Session history in native roles.
    3. Every mode retains the current input as User and current Turn activity as AI.
    """

    class ContextFreeWorkflowThink(WorkflowThink):
        async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[str]:
            return []

    class ContextFreeValidateThink(ValidateThink):
        async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[str]:
            return []

    async def assemble(worker: MainThink, state: dict[str, object], child: bool) -> tuple[list[Role], list[str]]:
        ota_context = AmphiOTAContext(
            user_input="Current build request",
            prompt_time=PROMPT_TIME,
            state={"think": state},
            ota_record=[
                OTARecord(
                    think_result={
                        "step_content": "Current Turn progress",
                        "tool_calls": [],
                    }
                )
            ],
        )
        messages = await worker.assemble_messages(ota_context, _context(child=child))
        return [message.role for message in messages], [message.content for message in messages]

    workflow_state = {
        "mode": "run_workflow",
        "workflow_id": "workflow-a",
        "generation": "generation-a",
        "step_index": 0,
    }
    cases = (
        (SubAgentThink(), {"mode": "normal", "stage": "main"}, True),
        (ClarifyThink(), {"mode": "build", "stage": "clarify"}, False),
        (ExploreThink(), {"mode": "build", "stage": "explore"}, False),
        (GenerateThink(), {"mode": "build", "stage": "generate"}, False),
        (VerifyThink(), {"mode": "build", "stage": "verify"}, False),
        (ContextFreeWorkflowThink(), {**workflow_state, "stage": "execute"}, False),
        (ContextFreeValidateThink(), {**workflow_state, "stage": "validate"}, False),
    )

    for worker, state, child in cases:
        roles, contents = await assemble(worker, state, child)

        # Check 1: Every special mode keeps Persona and dynamic Context in one leading System message.
        assert roles[0] is Role.SYSTEM
        assert roles.count(Role.SYSTEM) == 1
        assert "<context>" in contents[0]

        assert roles == [Role.SYSTEM, Role.USER, Role.AI, Role.USER, Role.AI]

        # Check 2: Every special mode replays Session history in native roles.
        assert contents[1:3] == ["Past request", "Past answer"]

        # Check 3: Every mode retains the current input as User and current Turn activity as AI.
        assert contents[-2].startswith("Current build request\n\n<current_time>")
        assert contents[-1] == "Current Turn progress"


async def test_workflow_stage_message_scope() -> None:
    """Automatic Workflow stages keep only their own trace."""
    class ContextFreeWorkflowThink(WorkflowThink):
        async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[str]:
            return []

    class ContextFreeValidateThink(ValidateThink):
        async def context_blocks(self, ota_context: AmphiOTAContext, context: AmphiContext) -> list[str]:
            return []

    def record(stage: str, content: str) -> OTARecord:
        round_ = OTARecord(think_result={"step_content": content, "tool_calls": []})
        round_.think_scope = {"mode": "run_workflow", "stage": stage}
        return round_

    workflow_state = {
        "mode": "run_workflow",
        "workflow_id": "workflow-a",
        "generation": "generation-a",
    }
    validate_ota = AmphiOTAContext(
        user_input="Run the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {**workflow_state, "stage": "validate", "step_index": 0}},
        ota_record=[
            record("execute", "Older execution history"),
            record("execute", "Final execution handoff"),
            record("validate", "Validation progress"),
        ],
    )
    validate_messages = await ContextFreeValidateThink().assemble_messages(validate_ota, _context())
    validate_contents = [message.content for message in validate_messages]
    assert "Older execution history" not in validate_contents
    assert "Final execution handoff" not in validate_contents
    assert "Past request" in validate_contents
    assert "Past answer" in validate_contents
    assert "Validation progress" in validate_contents

    execute_ota = AmphiOTAContext(
        user_input="Run the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {**workflow_state, "stage": "execute", "step_index": 1}},
        ota_record=[
            record("execute", "First execution section"),
            record("execute", "Second execution section"),
        ],
    )
    execute_messages = await ContextFreeWorkflowThink().assemble_messages(execute_ota, _context())
    execute_contents = [message.content for message in execute_messages]
    assert "Past request" in execute_contents
    assert "Past answer" in execute_contents
    assert "First execution section" in execute_contents
    assert "Second execution section" in execute_contents


async def test_build_stage_message_scope_uses_build_switch_policy() -> None:
    """Build stages resume their history and retain only explicit switch transitions."""
    def record(mode: str, stage: str, content: str, observation: str = "") -> OTARecord:
        round_ = OTARecord(
            think_result={"step_content": content, "tool_calls": []},
            observation_result=observation or None,
        )
        round_.think_scope = {"mode": mode, "stage": stage}
        return round_

    def switch_record(source_stage: str, target_stage: str, content: str, reason: str) -> OTARecord:
        call_id = f"call-{source_stage}-to-{target_stage}"
        round_ = record(
            "build",
            source_stage,
            content,
            f"[stage handoff] `build/{source_stage}` → `build/{target_stage}`\n{reason}",
        )
        round_.think_result = {
            "step_content": content,
            "tool_calls": [{
                "call_id": call_id,
                "tool": "switch",
                "tool_arguments": [
                    {"name": "stage", "value": target_stage},
                    {"name": "reason", "value": reason},
                ],
            }],
        }
        round_.action_result = ActionResult(results=[ActionStepResult(
            tool_id=call_id,
            tool_name="switch",
            tool_arguments={"stage": target_stage, "reason": reason},
            tool_result={"stage": target_stage, "reason": reason},
        )])
        return round_

    clarify_confirmation = record("build", "clarify", "Clarify confirmation history")
    clarify_confirmation.action_result = ActionResult(results=[ActionStepResult(
        tool_id="call-task-confirm",
        tool_name="request_human_task_confirm",
        tool_arguments={},
        tool_result={"status": "confirmed"},
    )])

    explore_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "explore"}},
        ota_record=[
            clarify_confirmation,
            record("build", "explore", "Explore progress"),
        ],
    )
    explore_contents = [
        message.content
        for message in await ExploreThink().assemble_messages(explore_ota, _context())
    ]
    assert "Clarify confirmation history" not in explore_contents
    assert "Past request" in explore_contents
    assert "Past answer" in explore_contents
    assert "Explore progress" in explore_contents

    explore_to_clarify = switch_record(
        "explore",
        "clarify",
        "Explore needs clarification",
        "A required decision is missing from task.md.",
    )
    clarify_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "clarify"}},
        ota_record=[
            explore_to_clarify,
            record("build", "clarify", "Clarify progress"),
        ],
    )
    clarify_contents = [
        message.content
        for message in await ClarifyThink().assemble_messages(clarify_ota, _context())
    ]
    assert "Past request" in clarify_contents
    assert "Past answer" in clarify_contents
    assert "Explore needs clarification" in clarify_contents
    assert "Clarify progress" in clarify_contents

    generate_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "generate"}},
        ota_record=[],
    )
    switch_reason = "The generated script mishandles empty input; fix that case and rerun validation."
    first_generation_handoff = switch_record(
        "generate",
        "verify",
        "Earlier generation history",
        "The first implementation is ready for verification.",
    )
    verification_round = switch_record("verify", "generate", "Verification history", switch_reason)
    generate_ota.ota_record = [
        first_generation_handoff,
        record("build", "verify", "Verification intermediate work"),
        verification_round,
        record("build", "generate", "Generate retry progress"),
    ]
    generate_messages = await GenerateThink().assemble_messages(generate_ota, _context())
    generate_contents = [message.content for message in generate_messages]
    assert "Earlier generation history" in generate_contents
    assert "Verification intermediate work" not in generate_contents
    assert "Verification history" in generate_contents
    assert any("mishandles empty input" in content for content in generate_contents)
    assert "Generate retry progress" in generate_contents
    switch_call = next(
        block
        for message in generate_messages
        for block in message.blocks
        if getattr(block, "id", None) == "call-verify-to-generate"
    )
    assert switch_call.id == "call-verify-to-generate"
    assert switch_call.arguments == {"stage": "generate", "reason": switch_reason}
    switch_result = next(
        block
        for message in generate_messages
        for block in message.blocks
        if getattr(block, "id", None) == "call-verify-to-generate" and hasattr(block, "content")
    )
    assert switch_reason in switch_result.content

    generation_handoff = switch_record(
        "generate",
        "verify",
        "Generate retry completed",
        "The corrected implementation is ready for verification.",
    )
    verify_again_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "verify"}},
        ota_record=[
            *generate_ota.ota_record,
            generation_handoff,
            record("build", "verify", "Second verification progress"),
        ],
    )
    verify_again_contents = [
        message.content
        for message in await VerifyThink().assemble_messages(verify_again_ota, _context())
    ]
    assert "Verification intermediate work" in verify_again_contents
    assert "Verification history" in verify_again_contents
    assert "Generate retry progress" not in verify_again_contents
    assert "Generate retry completed" in verify_again_contents
    assert "Second verification progress" in verify_again_contents


async def test_build_dispatch() -> None:
    """Final cognitive dispatch:

    {
      "before_switch": "clarify",
      "state_after_switch": {"mode": "build", "stage": "explore"},
      "next_think_unit": "explore"
    }

    Checks:
    1. A Build Turn initially dispatches to the stage stored in Agent state.
    2. A successful switch result changes the authoritative Build stage.
    3. The same Agent loop dispatches its next model round to the new stage.
    """
    agent = AmphiAgent()
    context = _context()
    ota_context = AmphiOTAContext(
        user_input="Continue the build",
        state={"think": {"mode": "build", "stage": "clarify"}},
        stream=SimpleNamespace(publish=lambda *_args, **_kwargs: None),
    )
    loop = agent.on_agent(ota_context, context)

    # Check 1: A Build Turn initially dispatches to the stage stored in Agent state.
    first = await anext(loop)
    assert first.name == "clarify"

    ota_context.ota_record.append(OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-switch",
            tool_name="switch",
            tool_arguments={"mode": "build", "stage": "explore"},
            tool_result={
                "mode": "build",
                "stage": "explore",
                "reason": "Requirements are settled.",
            },
        )
    ])))

    # Check 2: A successful switch result changes the authoritative Build stage.
    async for _ in agent.after_action(ota_context, context):
        raise AssertionError("after_action must not yield a visible value")
    assert ota_context.think_status.mode == "build"
    assert ota_context.think_status.stage == "explore"

    # Check 3: The same Agent loop dispatches its next model round to the new stage.
    second = await loop.asend("Clarify handoff complete")
    assert second.name == "explore"
    await loop.aclose()
