from types import SimpleNamespace

from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.core.model.types import Role

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, MainThink, Session
from src.amphi_agent._cognitive import (
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    SubAgentThink,
    ValidateThink,
    VerifyThink,
    WorkflowThink,
)
from src.amphi_store import SessionRecord, SessionTurnRecord, TurnStatus, UserInput


USER_ID = "local"
SESSION_ID = "session-mode"
PROMPT_TIME = "2026-08-19 12:00 (UTC+08:00)"


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
    """Validate drops Execute history while Execute sections retain their shared stage trace."""
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
            record("execute", "Execution history"),
            record("validate", "Validation progress"),
        ],
    )
    validate_messages = await ContextFreeValidateThink().assemble_messages(validate_ota, _context())
    validate_contents = [message.content for message in validate_messages]
    assert "Execution history" not in validate_contents
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


async def test_build_stage_message_scope_uses_generic_marker() -> None:
    """Build stage isolation uses think_scope while Main-to-Clarify retains its entry context."""
    def record(mode: str, stage: str, content: str) -> OTARecord:
        round_ = OTARecord(think_result={"step_content": content, "tool_calls": []})
        round_.think_scope = {"mode": mode, "stage": stage}
        return round_

    explore_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "explore"}},
        ota_record=[
            record("build", "clarify", "Clarify history"),
            record("build", "explore", "Explore progress"),
        ],
    )
    explore_contents = [
        message.content
        for message in await ExploreThink().assemble_messages(explore_ota, _context())
    ]
    assert "Clarify history" not in explore_contents
    assert "Past request" in explore_contents
    assert "Past answer" in explore_contents
    assert "Explore progress" in explore_contents

    clarify_ota = AmphiOTAContext(
        user_input="Build the workflow",
        prompt_time=PROMPT_TIME,
        state={"think": {"mode": "build", "stage": "clarify"}},
        ota_record=[
            record("build", "explore", "Explore history"),
            record("build", "clarify", "Clarify progress"),
        ],
    )
    clarify_contents = [
        message.content
        for message in await ClarifyThink().assemble_messages(clarify_ota, _context())
    ]
    assert "Past request" in clarify_contents
    assert "Past answer" in clarify_contents
    assert "Explore history" not in clarify_contents
    assert "Clarify progress" in clarify_contents


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
