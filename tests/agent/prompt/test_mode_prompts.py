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
      "child_clarify_workflow": ["System", "past User/AI", "current User", "current AI"],
      "explore_generate_verify": ["System", "current User", "current AI"]
    }

    Checks:
    1. Every special mode keeps Persona and dynamic Context in one leading System message.
    2. Child, Clarify, Execute, and Validate replay Session history in native roles.
    3. Explore, Generate, and Verify crop earlier Session messages completely.
    4. Every mode retains the current input as User and current Turn activity as AI.
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
        (SubAgentThink(), {"mode": "normal", "stage": "main"}, True, True),
        (ClarifyThink(), {"mode": "build", "stage": "clarify"}, False, True),
        (ExploreThink(), {"mode": "build", "stage": "explore"}, False, False),
        (GenerateThink(), {"mode": "build", "stage": "generate"}, False, False),
        (VerifyThink(), {"mode": "build", "stage": "verify"}, False, False),
        (ContextFreeWorkflowThink(), {**workflow_state, "stage": "execute"}, False, True),
        (ContextFreeValidateThink(), {**workflow_state, "stage": "validate"}, False, True),
    )

    for worker, state, child, includes_history in cases:
        roles, contents = await assemble(worker, state, child)

        # Check 1: Every special mode keeps Persona and dynamic Context in one leading System message.
        assert roles[0] is Role.SYSTEM
        assert roles.count(Role.SYSTEM) == 1
        assert "<context>" in contents[0]

        expected = [Role.SYSTEM]
        if includes_history:
            expected.extend([Role.USER, Role.AI])
        expected.extend([Role.USER, Role.AI])
        assert roles == expected

        # Check 2: Child, Clarify, Execute, and Validate replay Session history in native roles.
        if includes_history:
            assert contents[1:3] == ["Past request", "Past answer"]

        # Check 3: Explore, Generate, and Verify crop earlier Session messages completely.
        else:
            assert "Past request" not in contents
            assert "Past answer" not in contents

        # Check 4: Every mode retains the current input as User and current Turn activity as AI.
        assert contents[-2].startswith("Current build request\n\n<current_time>")
        assert contents[-1] == "Current Turn progress"


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
