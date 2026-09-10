"""Cognitive batch policy stays effective through admission, execution, and approval replay."""

from unittest.mock import AsyncMock

import pytest
from bridgic.amphibious import StepToolCall

from src.amphi_agent import AmphiOTAContext, Session
from src.amphi_agent._invocation import AgentInvocation
from src.amphi_agent.cognitive.state import AwaitingFeedback, AwaitingPermission, AwaitingSubAgent, RoundPermission
from src.amphi_agent.cognitive.build.state import BuildStageState
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.presentation.state import PresentationStageState
from src.amphi_agent.security import PermissionEngine
from tests.agent.core.test_action_boundary import _call, _invoke, _ota
from tests.agent.core.test_orchestration import (
    _Harness,
    _prepare_build,
    _save_workflow,
    _start_run,
    orchestration as orchestration_fixture,
)


orchestration = orchestration_fixture


STAGES = [
    "main", "subagent", "clarify", "explore", "generate", "verify",
    "ppt_brief", "ppt_plan", "ppt_compose", "ppt_review", "execute",
]


def _human_call() -> StepToolCall:
    return _call(
        "choice", "request_human_choice",
        questions='[{"question":"Continue?","options":[{"label":"Yes"},{"label":"No"}]}]',
        prompt="Choose how to continue",
    )


async def _stage_round(harness: _Harness, stage: str, calls: list[StepToolCall]) -> AmphiOTAContext:
    ota_context = _ota(calls, [])
    if stage == "subagent":
        harness.context.session = Session(harness.record.model_copy(update={"parent_session_id": "parent"}), [])
    elif stage in {"clarify", "explore", "generate", "verify"}:
        await _prepare_build(harness, stage)
        ota_context.transition_think(BuildStageState(stage=stage))
    elif stage.startswith("ppt_"):
        ota_context.transition_think(PresentationStageState(
            stage=stage,
            step_index=2 if stage == "ppt_plan" else 0,
            outline_confirmed=stage == "ppt_plan",
        ))
    elif stage == "execute":
        saved = await _save_workflow(harness, "batch-policy")
        started = await _start_run(harness, saved.workflow_id, "Create the requested report")
        ota_context.transition_think(started.think_status)
    ota_context.tools = harness.agent._select_current_tools(ota_context, harness.context)
    assert {call.tool for call in calls} <= {tool.tool_name for tool in ota_context.tools}
    return ota_context


@pytest.mark.parametrize("stage", STAGES)
async def test_one_human_call_runs_alone_in_every_stage(orchestration: _Harness, stage: str) -> None:
    """Every registered worker preserves the common human handoff and denies accompanying I/O."""
    calls = [_call("ordinary", "read_file", path="unused.txt"), _human_call()]
    ota_context = await _stage_round(orchestration, stage, calls)
    agent, context = orchestration.agent, orchestration.context

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert [call.call_id for call in admitted.tool_calls] == ["choice"]
    gate = ota_context.ota_record[-1].permission
    assert [verdict.verdict for verdict in gate.verdicts] == ["deny", "allow"]
    assert "must run alone" in gate.verdicts[0].reason
    ota_context.think_result = admitted
    ota_context.action_result = await agent.action_tool_call(ota_context, context)
    await _invoke(agent.after_action(ota_context, context))

    assert isinstance(ota_context.interaction_status, AwaitingFeedback)
    results = {step.tool_id: step for step in ota_context.action_result.results}
    assert results["choice"].success is True
    assert results["ordinary"].success is False
    assert "control-flow rejected" in results["ordinary"].error
    assert ota_context.subagent_status is None


@pytest.mark.parametrize(("stage", "tool"), [
    ("main", "request_build"),
    ("main", "edit_workflow"),
    ("main", "request_presentation"),
    ("main", "request_run_workflow"),
    ("clarify", "request_human_task_confirm"),
    ("verify", "request_human_workflow_confirm"),
    ("ppt_plan", "ppt_rag"),
    ("ppt_compose", "report_presentation_step"),
    ("execute", "report_workflow_step"),
])
async def test_stage_control_is_exclusive_across_inherited_rules(orchestration: _Harness, stage: str, tool: str) -> None:
    """A mode-owned control wins alone; adding Base's human control rejects the complete batch."""
    arguments = {
        "request_build": {"mode": "start", "goal": "Create a report"},
        "request_presentation": {"goal": "Explain the report"},
        "request_human_workflow_confirm": {"prompt": "Review the verified Workflow"},
        "report_presentation_step": {"summary": "Created the slide shells"},
        "report_workflow_step": {"status": "success", "summary": "Created the report"},
    }.get(tool, {})
    control = _call("control", tool, **arguments)
    ordinary = _call("ordinary", "read_file", path="unused.txt")
    calls = [ordinary, control]
    ota_context = await _stage_round(orchestration, stage, calls)
    if tool in {"edit_workflow", "request_run_workflow"}:
        workflow_id = (await _save_workflow(orchestration, "control-target")).workflow_id
        arguments = {"workflow_id": workflow_id}
        if tool == "request_run_workflow":
            arguments["action"] = "start"
        control = _call("control", tool, **arguments)
        calls = [ordinary, control]
        updated = _ota(calls, ota_context.tools)
        updated.transition_think(ota_context.think_status)
        ota_context = updated
    agent, context = orchestration.agent, orchestration.context

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert [call.call_id for call in admitted.tool_calls] == ["control"]
    assert [verdict.verdict for verdict in ota_context.ota_record[-1].permission.verdicts] == ["deny", "allow"]

    mixed = _ota([ordinary, control, _human_call()], ota_context.tools)
    mixed.transition_think(ota_context.think_status)
    admitted = await _invoke(agent.before_action(mixed, context))

    assert admitted.tool_calls == []
    assert all(verdict.verdict == "deny" for verdict in mixed.ota_record[-1].permission.verdicts)
    assert all("control-flow rejected" in verdict.reason for verdict in mixed.ota_record[-1].permission.verdicts)


async def test_cognitive_rules_preserve_system_denials_and_permission_metadata(orchestration: _Harness) -> None:
    """Business validation cannot upgrade or overwrite a permission or ToolSurface rejection."""
    calls = [_human_call(), _call("denied", "read_file", path="denied.txt"), _call("asked", "read_file", path="asked.txt")]
    ota_context = await _stage_round(orchestration, "main", calls)
    verdicts = ota_context.ota_record[-1].permission.verdicts
    for verdict, decision in zip(verdicts[1:], ["deny", "ask"]):
        verdict.verdict = decision
        verdict.reason = f"Original policy {decision}"
        verdict.rule = "Custom policy rule"
        verdict.label_id = "security.label.read_file"
        verdict.capability = "read"
        verdict.boundary = "outside_workspace"
        verdict.sensitive = True
    original = [verdict.model_dump() for verdict in verdicts]
    agent, context = orchestration.agent, orchestration.context

    resolved = await agent.legality_check(ota_context, context, calls, verdicts)

    assert resolved[0].model_dump() == original[0]
    assert resolved[1].model_dump() == original[1]
    assert resolved[2].verdict == "deny"
    assert "control-flow rejected" in resolved[2].reason
    assert resolved[2].model_copy(update={"verdict": original[2]["verdict"], "reason": original[2]["reason"]}).model_dump() == original[2]
    expected_denials = [verdict.model_dump() for verdict in resolved[1:]]
    assert [verdict.model_dump() for verdict in verdicts] == original
    ota_context.tools = [tool for tool in ota_context.tools if tool.tool_name != "request_human_choice"]
    resolved = await agent.legality_check(ota_context, context, calls, verdicts)
    assert resolved[0].verdict == "deny"
    assert "not available" in resolved[0].reason
    assert [verdict.model_dump() for verdict in resolved[1:]] == expected_denials


async def test_human_control_does_not_ask_for_an_excluded_network_call(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Both permission entry points receive only the surviving human call, never the rejected network call."""
    calls = [_human_call(), _call("network", "web_fetch", url="https://example.invalid/report")]
    ota_context = await _stage_round(orchestration, "main", calls)
    ota_context.ota_record[-1].permission = RoundPermission(execution_mode="request")
    agent, context = orchestration.agent, orchestration.context
    permission_batches: list[list[dict]] = []
    engine_batches: list[list[dict]] = []
    original_permission_check = agent.permission_check
    original_evaluate = PermissionEngine.evaluate

    async def permission_check(current_ota, current_context, evaluated_calls, *, execution_mode=None):
        permission_batches.append([call.model_dump() for call in evaluated_calls])
        return await original_permission_check(current_ota, current_context, evaluated_calls, execution_mode=execution_mode)

    async def evaluate(engine: PermissionEngine, evaluated_calls: list[StepToolCall], *args, **kwargs):
        engine_batches.append([call.model_dump() for call in evaluated_calls])
        return await original_evaluate(engine, evaluated_calls, *args, **kwargs)

    monkeypatch.setattr(agent, "permission_check", permission_check)
    monkeypatch.setattr(PermissionEngine, "evaluate", evaluate)

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert [call.call_id for call in admitted.tool_calls] == ["choice"]
    assert permission_batches == [[calls[0].model_dump()]]
    assert engine_batches == permission_batches
    assert ota_context.think_result.tool_calls == calls
    assert ota_context.interaction_status is None
    assert [verdict.verdict for verdict in ota_context.ota_record[-1].permission.verdicts] == ["allow", "deny"]
    ota_context.think_result = admitted
    ota_context.action_result = await agent.action_tool_call(ota_context, context)
    await _invoke(agent.after_action(ota_context, context))
    assert isinstance(ota_context.interaction_status, AwaitingFeedback)
    results = {step.tool_id: step for step in ota_context.action_result.results}
    assert results["choice"].success is True
    assert results["network"].success is False
    assert "control-flow rejected" in results["network"].error


async def test_conflicting_controls_are_denied_without_template_approval(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Conflicting controls are rejected without invoking permission evaluation or approval."""
    calls = [_human_call(), _call("templates", "ppt_rag")]
    ota_context = await _stage_round(orchestration, "ppt_plan", calls)
    ota_context.ota_record[-1].permission = RoundPermission(execution_mode="request")
    agent, context = orchestration.agent, orchestration.context
    permission_check = AsyncMock(side_effect=AssertionError("An entirely rejected batch must not enter permission evaluation."))
    monkeypatch.setattr(agent, "permission_check", permission_check)

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert admitted.tool_calls == []
    permission_check.assert_not_awaited()
    assert ota_context.interaction_status is None
    assert [verdict.verdict for verdict in ota_context.ota_record[-1].permission.verdicts] == ["deny", "deny"]
    ota_context.think_result = admitted
    await _invoke(agent.after_action(ota_context, context))
    assert all(not step.success for step in ota_context.action_result.results)
    assert all("control-flow rejected" in step.error for step in ota_context.action_result.results)
    assert ota_context.interaction_status is None


async def test_eligible_ask_keeps_its_original_approval_index(orchestration: _Harness) -> None:
    """One eligible ASK still parks the complete batch with its original call identity and metadata."""
    calls = [
        _call("read", "read_file", file_path=str(orchestration.workspace.work_dir / "report.txt")),
        _call("network", "web_fetch", url="https://example.invalid/report"),
    ]
    ota_context = await _stage_round(orchestration, "main", calls)
    ota_context.ota_record[-1].permission = RoundPermission(execution_mode="request")
    agent, context = orchestration.agent, orchestration.context

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert admitted.tool_calls == []
    assert isinstance(ota_context.interaction_status, AwaitingPermission)
    permission = ota_context.interaction_status.permission
    assert permission["calls"] == [call.model_dump() for call in calls]
    assert permission["verdicts"] == ["allow", "ask"]
    assert len(permission["items"]) == 1
    item = permission["items"][0]
    assert item["call_index"] == 1
    assert item["tool"] == "web_fetch"
    assert item["arguments"] == {"url": "https://example.invalid/report"}
    assert item["capability"] == "network"
    assert item["label_id"] == "security.label.network_access"
    assert ota_context.action_result is None


@pytest.mark.parametrize(("decision", "instruction"), [
    ("deny", None),
    ("allow", "Explain the plan before proceeding"),
], ids=["deny", "replan"])
async def test_approval_replay_preserves_existing_denial_and_permission_metadata(orchestration: _Harness, decision: str, instruction: str | None, monkeypatch: pytest.MonkeyPatch) -> None:
    """A remaining ASK keeps its index while replay retains another call's original system denial."""
    calls = [
        _call("hidden", "read_file", file_path=str(orchestration.workspace.work_dir / "report.txt")),
        _call("network", "web_fetch", url="https://example.invalid/report"),
    ]
    ota_context = await _stage_round(orchestration, "main", calls)
    ota_context.tools = [tool for tool in ota_context.tools if tool.tool_name != "read_file"]
    ota_context.ota_record[-1].permission = RoundPermission(execution_mode="request")
    agent, context = orchestration.agent, orchestration.context
    permission_batches: list[list[dict]] = []
    original_permission_check = agent.permission_check

    async def permission_check(current_ota, current_context, evaluated_calls, *, execution_mode=None):
        permission_batches.append([call.model_dump() for call in evaluated_calls])
        return await original_permission_check(current_ota, current_context, evaluated_calls, execution_mode=execution_mode)

    monkeypatch.setattr(agent, "permission_check", permission_check)
    admitted = await _invoke(agent.before_action(ota_context, context))

    assert admitted.tool_calls == []
    assert isinstance(ota_context.interaction_status, AwaitingPermission)
    permission = ota_context.interaction_status.permission
    assert permission_batches == [[calls[1].model_dump()]]
    assert permission["calls"] == [call.model_dump() for call in calls]
    assert permission["verdicts"] == ["deny", "ask"]
    assert [item["call_index"] for item in permission["items"]] == [1]
    original = ota_context.ota_record[-1].permission.verdicts
    assert "not available" in original[0].reason
    assert original[0].id == "hidden"
    assert original[0].tool == "read_file"
    assert original[0].arguments == {"file_path": str(orchestration.workspace.work_dir / "report.txt")}
    assert original[1].capability == "network"
    original_dump = [verdict.model_dump() for verdict in original]
    ota_context.think_result = admitted
    await _invoke(agent.after_action(ota_context, context))
    assert ota_context.action_result is None
    assert [verdict.model_dump() for verdict in ota_context.ota_record[-1].permission.verdicts] == original_dump
    rounds = [record.model_dump(mode="json") for record in ota_context.ota_record]
    ota_context.user_input = {
        "type": "permission_answer",
        "answers": [{"call_index": 1, "decision": decision, "instruction": instruction}],
    }

    await agent._resume_permission(ota_context, context, permission, rounds, "Inspect the report")

    assert permission_batches == [[calls[1].model_dump()]]
    resolved = ota_context.ota_record[-1].permission.verdicts
    assert resolved[0].model_dump() == original[0].model_dump()
    reason = "Denied by the user." if decision == "deny" else None
    assert resolved[1].model_dump() == original[1].model_copy(update={"verdict": decision, "reason": reason}).model_dump()
    assert ota_context.ota_record[-1].permission.items[0]["call_index"] == 1
    assert ota_context.ota_record[-1].permission.items[0]["decision"] == decision
    if instruction:
        assert ota_context.action_result is None
        assert instruction in ota_context.ota_record[-1].observation_result
    else:
        results = {step.tool_id: step for step in ota_context.action_result.results}
        assert all(not step.success for step in results.values())
        assert results["hidden"].error == original[0].reason
        assert results["network"].error == "Denied by the user."
    assert ota_context.interaction_status is None


async def test_invalid_template_ask_is_denied_by_the_stage_before_approval(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch) -> None:
    """An invalid offered template tool is rejected by its stage without reaching permissions."""
    calls = [_call("templates", "ppt_rag")]
    ota_context = await _stage_round(orchestration, "ppt_plan", calls)
    # Retain the offered ToolSurface while invalidating the cursor before final admission.
    ota_context.transition_think(PresentationStageState(stage="ppt_plan", step_index=2, outline_confirmed=False))
    ota_context.ota_record[-1].permission = RoundPermission(execution_mode="request")
    agent, context = orchestration.agent, orchestration.context
    permission_check = AsyncMock(side_effect=AssertionError("An invalid template request must not enter permission evaluation."))
    monkeypatch.setattr(agent, "permission_check", permission_check)

    admitted = await _invoke(agent.before_action(ota_context, context))

    assert admitted.tool_calls == []
    permission_check.assert_not_awaited()
    assert ota_context.interaction_status is None
    verdict = ota_context.ota_record[-1].permission.verdicts[0]
    assert verdict.verdict == "deny"
    assert "confirmed visual-direction step is not active" in verdict.reason


@pytest.mark.parametrize("resumed", [False, True], ids=["direct", "permission-replay"])
async def test_workflow_switch_blocks_background_dispatch(orchestration: _Harness, monkeypatch: pytest.MonkeyPatch, resumed: bool) -> None:
    """An approved switch exits the active Run without launching its accompanying background child."""
    started: list[str] = []

    async def start_subagent(invocation: AgentInvocation, parent_session_id: str, call: object) -> str:
        started.append(parent_session_id)
        return "unexpected-child"

    monkeypatch.setattr(AgentInvocation, "start_subagent", start_subagent)
    orchestration.context.invocations = AgentInvocation.__new__(AgentInvocation)
    calls = [
        _call("exit", "switch", mode="normal"),
        _call("background", "start_subagent", goal="Inspect the source"),
    ]
    ota_context = await _stage_round(orchestration, "execute", calls)
    agent, context = orchestration.agent, orchestration.context
    if resumed:
        rounds = [record.model_dump(mode="json") for record in ota_context.ota_record]
        permission = {
            "calls": [call.model_dump() for call in calls],
            "verdicts": ["ask", "ask"],
            "items": [{"call_index": index, "tool": call.tool, "arguments": {}} for index, call in enumerate(calls)],
            "execution_mode": "full",
        }
        ota_context.user_input = {
            "type": "permission_answer",
            "answers": [{"call_index": index, "decision": "allow"} for index in range(2)],
        }
        ota_context.transition_interaction(AwaitingPermission(request_id="approval", permission=permission))
        await agent._resume_permission(ota_context, context, permission, rounds, "Pause this Run")
        assert ota_context.ota_record[-1].permission.reviewed is True
    else:
        admitted = await _invoke(agent.before_action(ota_context, context))
        assert [call.call_id for call in admitted.tool_calls] == ["exit"]
        ota_context.think_result = admitted
        ota_context.action_result = await agent.action_tool_call(ota_context, context)
        await _invoke(agent.after_action(ota_context, context))

    assert started == []
    assert ota_context.think_status == NormalStageState()
    results = {step.tool_id: step for step in ota_context.action_result.results}
    assert results["exit"].success is True
    assert results["background"].success is False
    assert "control-flow rejected" in results["background"].error
    assert ota_context.subagent_status is None
    assert ota_context.interaction_status is None


async def test_explicit_special_mode_is_rejected_before_workflow_transition(orchestration: _Harness) -> None:
    """The shared switch syntax check still precedes the mode's automatic-advance guard."""
    calls = [_call("advance", "switch", mode="run_workflow", stage="execute")]
    ota_context = await _stage_round(orchestration, "execute", calls)

    admitted = await _invoke(orchestration.agent.before_action(ota_context, orchestration.context))

    assert admitted.tool_calls == []
    assert "omit mode" in ota_context.ota_record[-1].permission.verdicts[0].reason


async def test_awaited_subagent_batch_remains_admitted(orchestration: _Harness) -> None:
    """Awaited delegation keeps all calls and parks one complete batch after real execution."""
    calls = [_call(f"child-{index}", "run_subagent", goal=f"Inspect source {index}") for index in range(2)]
    ota_context = await _stage_round(orchestration, "main", calls)
    agent, context = orchestration.agent, orchestration.context

    admitted = await _invoke(agent.before_action(ota_context, context))
    assert admitted.tool_calls == calls
    ota_context.think_result = admitted
    ota_context.action_result = await agent.action_tool_call(ota_context, context)
    await _invoke(agent.after_action(ota_context, context))

    assert isinstance(ota_context.subagent_status, AwaitingSubAgent)
    assert [call.tool_call_id for call in ota_context.subagent_status.calls] == ["child-0", "child-1"]
    assert all(step.success for step in ota_context.action_result.results)
