"""Agent invocation checkpoints and persisted-state restoration tests."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from ._session_turns import make_session_turns


def _workflows_for(workspace):
    from src.amphi_agent._workflows import WorkflowLibrary

    workflows = WorkflowLibrary("u")
    if workspace.build is not None:
        workflows.open_package(workspace.build.root)
    return workflows


def _assert_acceptance_state_is_receipt_only(build, request_id: str) -> None:
    """The Build checkpoint remembers the review, never its AC payload."""
    state = json.loads((build.root / ".state.json").read_text(encoding="utf-8"))
    assert state["acceptance_contract"] == {"request_id": request_id}
    assert "acceptance_review_request_id" not in state
    assert "acceptance_review" not in state
    assert "candidate_rules" not in state
    assert "rules" not in state
    assert "mode" not in state


async def test_invocation_success_checkpoint_records_workspace_changes(tmp_path, monkeypatch) -> None:
    from types import SimpleNamespace

    from src.amphi_agent import AgentInvocation
    from src.amphi_agent._workspace import Workspace
    from src.amphi_service.runtime import SessionEventBroker, SystemEventBroker

    monkeypatch.setenv("BRIDGIC_AGENT_SESSIONS_ROOT", str(tmp_path))
    workspace = Workspace("session")
    await workspace.prepare_workspace()
    work = workspace.work_dir
    (work / "result.txt").write_text("done\n", encoding="utf-8")

    invocation = AgentInvocation(
        object(),
        SessionEventBroker(),
        SystemEventBroker(),
    )
    await invocation._checkpoint_workspace(
        workspace,
        SimpleNamespace(input="make result"),
        "Created result",
    )

    history = workspace.checkpoints.history()
    assert history[0]["message"] == "Agent turn: Created result"
    assert history[0]["changed_files"] == 1


async def test_init_state_failed_turn_restores_only_its_cognitive_cursor() -> None:
    """A failed Build Turn keeps its durable stage without reopening an interaction."""
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState
    from src.amphi_store import SessionRecord, UserInput

    parked_build = {"state": {"think": {"mode": "build", "stage": "explore"}, "interaction": None}}
    dump = {"turn_error": "RuntimeError: x", **parked_build}
    history = make_session_turns([(UserInput(text="x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    ota = AmphiOTAContext(user_input="你好")
    await AmphiAgent().init_state(
        ota,
        AmphiContext(session=Session(record, turns=history)),
    )
    assert ota.state.think == BuildStageState(stage="explore")
    assert ota.state.interaction is None


async def test_init_state_restores_loaded_tool_flags_for_waiting_turn() -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_store import SessionRecord, UserInput

    dump = {
        "state": {"think": {"mode": "normal", "stage": "main"}, "interaction": {"questions": []}},
        "ota_record": [{}],
        "browser_tool_loaded": True,
        "workspace_tools_loaded": True,
    }
    history = make_session_turns([(UserInput(text="x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    ota = AmphiOTAContext(user_input="reply")
    await AmphiAgent().init_state(
        ota,
        AmphiContext(session=Session(record, turns=history)),
    )
    assert ota.browser_tool_loaded is True
    assert ota.workspace_tools_loaded is True


async def test_init_state_resumes_main_human_choice_with_structured_help() -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._cognitive import render_input
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import NormalStageState
    from src.amphi_service.protocol import WsChatMessage
    from src.amphi_store import SessionRecord, UserInput

    original = UserInput(
        text="继续规划这个项目",
        blocks=[{"type": "text", "value": "继续规划这个项目"}],
    )
    dump = {
        "state": {
            "think": {"mode": "normal", "stage": "main"},
            "interaction": {
                "questions": [{
                    "question": "你想先处理哪部分？",
                    "options": [{"label": "需求"}, {"label": "实现"}],
                }],
                "prompt": "选择下一步",
            },
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {},
                "tool_result": "",
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(original, dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    context = AmphiContext(session=Session(record, turns=history))
    ota = AmphiOTAContext(user_input=WsChatMessage(
        session_id="t",
        input="/help",
        blocks=[{"type": "slash", "id": "help", "label": "帮助"}],
    ))

    await AmphiAgent().init_state(ota, context)

    reply = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert "Call the `help` tool" in reply
    assert "current conversation context" in reply
    assert "give the user a final answer in the language they are using" in reply
    assert ota.think_status == NormalStageState()
    assert ota.interaction_status is None
    assert context.session.get_all() == []
    assert render_input(ota.user_input) == "继续规划这个项目"


async def test_init_state_does_not_restore_loaded_tool_flags_for_new_turn() -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_store import SessionRecord, UserInput

    dump = {
        "state": {"think": {"mode": "normal", "stage": "main"}, "interaction": None},
        "ota_record": [{}],
        "browser_tool_loaded": True,
        "workspace_tools_loaded": True,
        "skills_tool_loaded": True,
    }
    history = make_session_turns([(UserInput(text="first", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    ota = AmphiOTAContext(user_input="next")

    await AmphiAgent().init_state(ota, AmphiContext(session=Session(record, turns=history)))

    assert ota.browser_tool_loaded is False
    assert ota.workspace_tools_loaded is False
    assert ota.skills_tool_loaded is False


async def test_child_build_slash_stays_in_normal_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import NormalStageState
    from src.amphi_store import SessionRecord, SubAgentMode, UserInput

    block = {"type": "slash", "id": "build", "label": "构建"}
    record = SessionRecord(
        id="child",
        user_id="u",
        workspace_root="/tmp",
        parent_session_id="root",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    context = AmphiContext(session=Session(record))
    ota = AmphiOTAContext(user_input=UserInput(text="/build", blocks=[block]))
    agent = AmphiAgent()
    workflow_starts = []

    async def record_workflow_start(*args, **kwargs):
        workflow_starts.append((args, kwargs))

    monkeypatch.setattr(
        agent,
        "_enter_or_resume_run_workflow",
        record_workflow_start,
    )
    await agent.init_state(ota, context)

    assert isinstance(ota.think_status, NormalStageState)
    assert workflow_starts == []
    assert "available only in root Sessions" in ota.ota_record[-1].observation_result
    assert "continue this task in normal mode" in ota.ota_record[-1].observation_result


async def test_child_does_not_resume_persisted_build_state() -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import NormalStageState
    from src.amphi_store import SessionRecord, SubAgentMode, TurnStatus, UserInput

    turns = make_session_turns([(
        UserInput(text="/build reusable task"),
        {
            "state": {"think": {"mode": "build", "stage": "generate"}},
            "ota_record": [],
        },
    )], user_id="u", session_id="child")
    turns[-1].status = TurnStatus.CANCELLED
    record = SessionRecord(
        id="child",
        user_id="u",
        workspace_root="/tmp",
        parent_session_id="root",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    ota = AmphiOTAContext(user_input="继续")

    await AmphiAgent().init_state(ota, AmphiContext(session=Session(record, turns=turns)))

    assert isinstance(ota.think_status, NormalStageState)


async def test_child_does_not_resume_persisted_workflow_run_state() -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import NormalStageState
    from src.amphi_store import SessionRecord, SubAgentMode, TurnStatus, UserInput

    turns = make_session_turns([(
        UserInput(text="run workflow"),
        {
            "state": {
                "think": {
                    "mode": "run_workflow",
                    "stage": "execute",
                    "workflow_id": "wf-report",
                    "generation": "generation-1",
                    "step_index": 0,
                },
            },
            "ota_record": [],
        },
    )], user_id="u", session_id="child")
    turns[-1].status = TurnStatus.CANCELLED
    record = SessionRecord(
        id="child",
        user_id="u",
        workspace_root="/tmp",
        parent_session_id="root",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    ota = AmphiOTAContext(user_input="继续")

    await AmphiAgent().init_state(ota, AmphiContext(session=Session(record, turns=turns)))

    assert isinstance(ota.think_status, NormalStageState)


async def test_child_permission_resume_rebuilds_surface_and_denies_legacy_root_tool() -> None:
    from bridgic.amphibious import OTARecord
    from bridgic.amphibious._type import StepToolCall, ThinkResult, ToolArgument

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_store import SessionRecord, SubAgentMode, UserInput

    call = StepToolCall(
        call_id="call-legacy-subagent",
        tool="run_subagent",
        tool_arguments=[ToolArgument(name="goal", value="nested task")],
    )
    rounds = [
        OTARecord(
            think_result=ThinkResult(step_content="delegate", tool_calls=[call]),
        ).model_dump(mode="json"),
    ]
    permission = {
        "calls": [call.model_dump(mode="json")],
        "verdicts": ["ask"],
        "items": [{"call_index": 0, "tool": "run_subagent"}],
    }
    record = SessionRecord(
        id="child",
        user_id="u",
        workspace_root="/tmp",
        parent_session_id="root",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    context = AmphiContext(session=Session(record))
    ota = AmphiOTAContext(user_input={
        "answers": [{"call_index": 0, "decision": "allow"}],
    })

    await AmphiAgent()._resume_permission(
        ota,
        context,
        permission,
        rounds,
        UserInput(text="original child task"),
    )

    assert "run_subagent" not in {spec.tool_name for spec in ota.tools}
    step = ota.ota_record[-1].action_result.results[0]
    assert step.tool_id == "call-legacy-subagent"
    assert step.success is False
    assert "not available in this Session's current ToolSurface" in step.error


@pytest.mark.parametrize(
    ("tool_name", "allowed"),
    [("run_subagent", True), ("start_subagent", False)],
)
async def test_root_build_permission_resume_uses_the_current_think_tool_surface(
    tool_name: str,
    allowed: bool,
) -> None:
    from bridgic.amphibious import OTARecord
    from bridgic.amphibious._type import StepToolCall, ThinkResult, ToolArgument

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import AwaitingSubAgent, BuildStageState
    from src.amphi_store import SessionRecord, UserInput

    call = StepToolCall(
        call_id=f"call-build-{tool_name}",
        tool=tool_name,
        tool_arguments=[ToolArgument(name="goal", value="nested task")],
    )
    rounds = [
        OTARecord(
            think_result=ThinkResult(step_content="delegate", tool_calls=[call]),
        ).model_dump(mode="json"),
    ]
    permission = {
        "calls": [call.model_dump(mode="json")],
        "verdicts": ["ask"],
        "items": [{"call_index": 0, "tool": tool_name}],
    }
    context = AmphiContext(session=Session(SessionRecord(
        id="root",
        user_id="u",
        workspace_root="/tmp",
    )))
    ota = AmphiOTAContext(user_input={
        "answers": [{"call_index": 0, "decision": "allow"}],
    })
    ota.transition_think(BuildStageState(stage="clarify"))

    await AmphiAgent()._resume_permission(
        ota,
        context,
        permission,
        rounds,
        UserInput(text="original build task"),
    )

    visible_tools = {spec.tool_name for spec in ota.tools}
    assert "switch" in visible_tools
    assert "run_subagent" in visible_tools
    assert "start_subagent" not in visible_tools
    step = ota.ota_record[-1].action_result.results[0]
    assert step.tool_id == f"call-build-{tool_name}"
    assert step.success is allowed
    if allowed:
        assert isinstance(ota.subagent_status, AwaitingSubAgent)
        assert [item.goal for item in ota.subagent_status.calls] == ["nested task"]
    else:
        assert "not available in this Session's current ToolSurface" in step.error


@pytest.mark.parametrize(
    ("action", "feedback", "stage", "status"),
    [
        ("confirm", None, "explore", "confirmed"),
        ("revise", "补充失败重试分支", "clarify", "revision_requested"),
        ("direct_reply", "补充失败重试分支", "clarify", "not_answered"),
    ],
)
async def test_init_state_task_confirm_resumes_clarify_review(
    tmp_path: Path, action: str, feedback: str | None, stage: str, status: str,
) -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_service.protocol import WsChatMessage
    from src.amphi_store import SessionRecord, UserInput

    payload = {
        "request_id": "task_confirm_test",
        "task_markdown": "## Task\nReview me",
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"task_confirm": dict(payload)},
        },
        "ota_record": [{
            "think_result": {"step_content": "任务说明已完成"},
            "action_result": {"results": [{
                "tool_name": "request_human_task_confirm",
                "tool_arguments": {},
                "tool_result": dict(payload),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="clarify")
    workspace.build.start_acceptance_review("accept-rule-1")
    (workspace.build.root / "task.md").write_text(
        "## Task\nChanged after the card was shown",
        encoding="utf-8",
    )
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    user_input = (
        WsChatMessage(session_id="t", input=feedback or "", blocks=[])
        if action == "direct_reply"
        else SimpleNamespace(
            type="task_confirm",
            request_id="task_confirm_test",
            action=action,
            feedback=feedback,
        )
    )
    ota = AmphiOTAContext(user_input=user_input)

    await AmphiAgent().init_state(ota, context)

    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == status
    assert result["feedback"] == feedback
    assert result["message"]
    if action in {"revise", "direct_reply"}:
        assert "Keep the one-time acceptance outline" in result["message"]
        assert "without presenting another acceptance-review card" in result["message"]
    assert ota.think_status == BuildStageState(stage=stage)
    assert ota.state.interaction is None
    assert context.session.get_all() == []
    assert workspace.build.stage == stage
    assert workspace.build.acceptance_review_request_id == "accept-rule-1"
    _assert_acceptance_state_is_receipt_only(workspace.build, "accept-rule-1")
    assert workspace.build.last_task_confirmation == {
        "request_id": "task_confirm_test",
        "task_markdown": "## Task\nReview me",
    }
    assert getattr(ota.user_input, "input") == "/build x"


async def test_init_state_resumes_acceptance_review_with_unanswered_new_message(
    tmp_path: Path,
) -> None:
    from bridgic.amphibious import StepToolCall

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._cognitive import ClarifyThink
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_service.protocol import WsChatMessage
    from src.amphi_store import SessionRecord, UserInput

    payload = {
        "request_id": "accept-1",
        "candidate_rules": ["The result exists."],
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"accept_rule": dict(payload)},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {"rules": '["The result exists."]'},
                "tool_result": dict(payload),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="clarify")
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=WsChatMessage(
        session_id="t",
        input="把第一条规则改得更具体",
        blocks=[{"type": "text", "value": "把第一条规则改得更具体"}],
    ))

    await AmphiAgent().init_state(ota, context)

    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == "not_answered"
    assert result["candidate_rules"] == ["The result exists."]
    assert result["user_message"] == "把第一条规则改得更具体"
    assert "did not accept or reject" in result["message"]
    assert "without presenting another acceptance-review card" in result["message"]
    assert ota.state.interaction is None
    assert context.session.get_all() == []
    assert ota.user_input.input == "/build x"
    assert workspace.build.acceptance_review_request_id == "accept-1"
    _assert_acceptance_state_is_receipt_only(workspace.build, "accept-1")
    review_ota = AmphiOTAContext(user_input="/build x")
    review_ota.transition_think(BuildStageState(stage="clarify"))
    repeated = await ClarifyThink().legality_check(
        StepToolCall(tool="request_accept_rule", tool_arguments=[]),
        review_ota,
        context,
    )
    assert repeated and "one-time acceptance outline" in repeated


async def test_init_state_confirmation_cards_accept_a_whole_card_chat_reply(
    tmp_path: Path,
) -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._workspace import Workspace
    from src.amphi_service.protocol import WsChatMessage
    from src.amphi_store import SessionRecord, UserInput

    cases = [
        (
            "build",
            {"mode": "normal", "stage": "main"},
            {
                "build_confirm": True,
                "request_id": "build-1",
                "goal": "构建目录统计工作流",
            },
            "request_build",
            {
                "mode": "ask",
                "request_id": "build-1",
                "goal": "构建目录统计工作流",
                "status": "pending",
            },
        ),
        (
            "task",
            {"mode": "build", "stage": "clarify"},
            {
                "task_confirm": {
                    "request_id": "task-1",
                    "task_markdown": "# Task\nReview me",
                    "status": "pending",
                },
            },
            "request_human_task_confirm",
            {
                "request_id": "task-1",
                "task_markdown": "# Task\nReview me",
                "status": "pending",
            },
        ),
        (
            "workflow",
            {"mode": "build", "stage": "verify"},
            {
                "workflow_confirm": {
                    "request_id": "workflow-1",
                    "default_name": "目录统计",
                    "status": "pending",
                },
            },
            "request_human_workflow_confirm",
            {
                "request_id": "workflow-1",
                "default_name": "目录统计",
                "status": "pending",
            },
        ),
    ]
    for case, think, interaction, tool_name, tool_result in cases:
        dump = {
            "state": {"think": think, "interaction": interaction},
            "ota_record": [{
                "action_result": {"results": [{
                    "tool_name": tool_name,
                    "tool_arguments": {},
                "tool_result": tool_result,
                "success": True,
            }]},
        }],
        }
        session_id = f"t-{case}"
        session_root = tmp_path / case
        history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
        record = SessionRecord(id=session_id, user_id="u", workspace_root=str(session_root))
        workspace = Workspace(session_id, session_root=session_root)
        if think["mode"] == "build":
            await workspace.prepare_build_space("create", stage=think["stage"])
        if case == "task":
            workspace.build.start_acceptance_review("accept-1")
        context = AmphiContext(
            session=Session(record, turns=history),
            workflows=_workflows_for(workspace),
            workspace=workspace,
        )
        ota = AmphiOTAContext(user_input=WsChatMessage(
            session_id=session_id,
            input="请结合这张卡片整体再调整一下",
            blocks=[{"type": "text", "value": "请结合这张卡片整体再调整一下"}],
        ))

        await AmphiAgent().init_state(ota, context)

        result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
        assert result["status"] == "not_answered", case
        assert result["user_message"] == "请结合这张卡片整体再调整一下", case
        assert "entire" in result["message"], case
        if case == "task":
            assert "Keep the one-time acceptance outline" in result["message"]
        assert ota.state.interaction is None, case
        assert context.session.get_all() == [], case
        assert ota.user_input.input == "/build x", case
        if case == "task":
            assert workspace.build.acceptance_review_request_id == "accept-1"
            _assert_acceptance_state_is_receipt_only(workspace.build, "accept-1")


async def test_init_state_keeps_explicit_execution_only_acceptance_in_turn_only(
    tmp_path: Path,
) -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._workspace import Workspace
    from src.amphi_store import SessionRecord, UserInput

    payload = {
        "request_id": "accept-1",
        "candidate_rules": ["The result exists."],
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"accept_rule": dict(payload)},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {"rules": '["The result exists."]'},
                "tool_result": dict(payload),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="clarify")
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=SimpleNamespace(
        type="accept_rule",
        request_id="accept-1",
        mode="execution_only",
        decisions=[],
        supplement="",
    ))

    await AmphiAgent().init_state(ota, context)

    assert workspace.build.acceptance_review_request_id == "accept-1"
    _assert_acceptance_state_is_receipt_only(workspace.build, "accept-1")
    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == "confirmed"
    assert result["mode"] == "execution_only"
    assert result["rules"] == []
    assert ota.state.interaction is None


async def test_init_state_normalizes_structured_acceptance_in_turn_only(
    tmp_path: Path,
) -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._workspace import Workspace
    from src.amphi_store import SessionRecord, UserInput

    payload = {
        "request_id": "accept-criteria",
        "candidate_rules": ["The report exists.", "The report is readable."],
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"accept_rule": dict(payload)},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {"rules": '["The report exists.", "The report is readable."]'},
                "tool_result": dict(payload),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="clarify")
    context = AmphiContext(
        session=Session(
            SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path)),
            turns=history,
        ),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=SimpleNamespace(
        type="accept_rule",
        request_id="accept-criteria",
        mode="criteria",
        decisions=["accept", "reject"],
        feedback=["", "The report has a clear structure."],
        supplement="The report exists.",
    ))

    await AmphiAgent().init_state(ota, context)

    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == "confirmed"
    assert result["mode"] == "criteria"
    assert result["rules"] == [
        {
            "id": "AC-001",
            "text": "The report exists.",
            "source": "agent_proposed_user_accepted",
        },
        {
            "id": "AC-002",
            "text": "The report has a clear structure.",
            "source": "user_supplement",
        },
    ]
    assert result["revised_count"] == 1
    assert result["rejected_count"] == 0
    _assert_acceptance_state_is_receipt_only(workspace.build, "accept-criteria")
    assert ota.state.interaction is None


async def test_init_state_all_rejected_rules_select_execution_only(tmp_path: Path) -> None:
    from types import SimpleNamespace

    from bridgic.amphibious import StepToolCall

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._cognitive import ClarifyThink
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_store import SessionRecord, UserInput

    payload = {
        "request_id": "accept-1",
        "candidate_rules": ["The result exists."],
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"accept_rule": dict(payload)},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_accept_rule",
                "tool_arguments": {"rules": '["The result exists."]'},
                "tool_result": dict(payload),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="clarify")
    context = AmphiContext(
        session=Session(
            SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path)),
            turns=history,
        ),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=SimpleNamespace(
        type="accept_rule",
        request_id="accept-1",
        mode="criteria",
        decisions=["reject"],
        feedback=[""],
        supplement="",
    ))

    await AmphiAgent().init_state(ota, context)

    assert workspace.build.acceptance_review_request_id == "accept-1"
    _assert_acceptance_state_is_receipt_only(workspace.build, "accept-1")
    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == "confirmed"
    assert result["mode"] == "execution_only"
    assert result["rules"] == []
    assert "execution-only mode" in result["message"]
    review_ota = AmphiOTAContext(user_input="/build x")
    review_ota.transition_think(BuildStageState(stage="clarify"))
    repeated = await ClarifyThink().legality_check(
        StepToolCall(tool="request_accept_rule", tool_arguments=[]),
        review_ota,
        context,
    )
    assert repeated and "one-time acceptance outline" in repeated


async def test_init_state_task_confirm_rejects_stale_request_id() -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_store import SessionRecord, UserInput

    dump = {
        "state": {
            "think": {"mode": "build", "stage": "clarify"},
            "interaction": {"task_confirm": {
                "request_id": "current_request",
                "task_markdown": "## Task\nReview me",
                "status": "pending",
            }},
        },
        "ota_record": [{}],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    ota = AmphiOTAContext(user_input=SimpleNamespace(
        type="task_confirm",
        request_id="stale_request",
        action="confirm",
    ))

    with pytest.raises(RuntimeError, match="does not match the pending request"):
        await AmphiAgent().init_state(ota, AmphiContext(session=Session(record, turns=history)))


@pytest.mark.parametrize("saved", [True, False])
async def test_init_state_workflow_confirm_resume_records_persistence_result(
    tmp_path: Path, monkeypatch, connected_repo: None, saved: bool,
) -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState, NormalStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
    from src.amphi_store import SessionRecord, UserInput

    source_roots: list[Path] = []
    published_workflow_root = tmp_path / "saved-workflow"

    async def materialize_workflow(_library, source_root, *, workflow_id, **kwargs):
        source_root = Path(source_root)
        source_roots.append(source_root)
        assert workflow_id is None
        assert (source_root / ".state.json").is_file()
        assert (source_root / "task.md").is_file()
        assert (source_root / "explore.md").is_file()
        assert (source_root / "verify.md").is_file()
        assert (source_root / "workflow").is_dir()
        assert kwargs == {
            "source_session_id": "t",
            "source_turn_id": "turn_0",
            "name": "小红书内容爬虫",
            "description": "验证通过",
        }
        if not saved:
            raise OSError("disk full")
        return WorkflowPackage(
            root=published_workflow_root,
            workflow_id="wf_1",
            name="小红书内容爬虫",
            description="验证通过",
            source_session_id="t",
            source_turn_id="turn_0",
        )

    monkeypatch.setattr(WorkflowLibrary, "materialize_workflow", materialize_workflow)

    pending = {
        "request_id": "workflow_confirm_test",
        "default_name": "小红书内容爬虫",
        "summary": "验证通过",
        "operation": "create",
        "workflow_id": None,
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "verify"},
            "interaction": {"workflow_confirm": dict(pending)},
        },
        "ota_record": [
            {
                "think_result": {"step_content": "验证通过"},
                "action_result": {
                    "results": [
                        {
                            "tool_name": "request_human_workflow_confirm",
                            "tool_arguments": {"prompt": "{}"},
                            "tool_result": dict(pending),
                            "success": True,
                        }
                    ]
                },
            }
        ],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    build = await workspace.prepare_build_space("create", stage="verify")
    (build.root / "task.md").write_text("# Task\n", encoding="utf-8")
    (build.root / "explore.md").write_text("# Explore\n", encoding="utf-8")
    (build.root / "verify.md").write_text("# Verify\n", encoding="utf-8")
    (build.root / "workflow").mkdir()
    workflows = WorkflowLibrary("u")
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=workflows,
        workspace=workspace,
    )
    ota = AmphiOTAContext(
        user_input=SimpleNamespace(
            type="workflow_confirm",
            request_id="workflow_confirm_test",
            action="confirm",
            name="小红书内容爬虫",
        )
    )

    await AmphiAgent().init_state(ota, context)

    step = ota.ota_record[-1].action_result["results"][0]
    if saved:
        assert step["tool_result"]["status"] == "confirmed"
        assert step["tool_result"]["workflow_id"] == "wf_1"
        assert step["tool_result"]["name"] == "小红书内容爬虫"
        assert step["tool_result"]["published_root"] == str(published_workflow_root)
        handoff = (
            "[artifact publication]\n"
            "The Workflow package under .build was published to:\n"
            f"{published_workflow_root.resolve()}\n\n"
            "Package-relative paths are unchanged for task.md, explore.md, verify.md, and "
            "workflow/. Other files from .build were not published and must not be linked. "
            "The original temporary .build workspace was deleted. The published location "
            "above is internal handoff context. The UI already presented the published "
            "artifacts in a dedicated card. In the final answer, briefly summarize the "
            "outcome without repeating or linking the published directory, artifact paths, "
            "file URIs, or artifact Markdown links."
        )
        assert handoff in ota._current_record().observation_result
        assert isinstance(ota.think_status, NormalStageState)
    else:
        assert step["tool_result"]["status"] == "save_failed"
        assert step["tool_result"]["error"] == "disk full"
        assert ota.think_status == BuildStageState(stage="verify")
    assert ota.state.interaction is None
    assert getattr(ota.user_input, "input") == "/build x"
    assert ota.model_dump(mode="json", exclude={"stream", "tools"})["user_input"]["input"] == "/build x"
    assert context.session.get_all() == []
    assert workspace.has_build is not saved
    assert build.root.exists() is not saved
    assert source_roots == [build.root]
    assert source_roots[0].exists() is not saved


@pytest.mark.parametrize(
    ("action", "expected_target_id", "expected_operation", "saved_workflow_id"),
    [
        ("confirm", "wf_original", "edit", "wf_original"),
        ("save_as_new", None, "create", "wf_copy"),
    ],
)
async def test_init_state_edit_workflow_confirmation_selects_persistence_target(
    tmp_path: Path,
    monkeypatch,
    action: str,
    expected_target_id: str | None,
    expected_operation: str,
    saved_workflow_id: str,
) -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import NormalStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
    from src.amphi_service.protocol import WsWorkflowConfirmMessage
    from src.amphi_store import SessionRecord, UserInput

    materialized_targets: list[str | None] = []
    idempotency_lookups: list[str] = []
    published_root = tmp_path / saved_workflow_id

    async def find_materialized_workflow(_library, source_turn_id: str):
        idempotency_lookups.append(source_turn_id)
        return None

    async def materialize_workflow(_library, source_root, *, workflow_id, **kwargs):
        materialized_targets.append(workflow_id)
        assert Path(source_root).name == ".build"
        assert kwargs == {
            "source_session_id": "t",
            "source_turn_id": "turn_0",
            "name": "目录报告副本" if action == "save_as_new" else "目录报告",
            "description": "修改验证通过",
        }
        return WorkflowPackage(
            root=published_root,
            workflow_id=saved_workflow_id,
            name=kwargs["name"],
            description=kwargs["description"],
            source_session_id="t",
            source_turn_id="turn_0",
        )

    monkeypatch.setattr(
        WorkflowLibrary,
        "find_materialized_workflow",
        find_materialized_workflow,
    )
    monkeypatch.setattr(WorkflowLibrary, "materialize_workflow", materialize_workflow)

    pending = {
        "request_id": "workflow_edit_confirm",
        "default_name": "目录报告",
        "summary": "修改验证通过",
        "operation": "edit",
        "workflow_id": "wf_original",
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {
                "mode": "build",
                "stage": "verify",
                "workflow_id": "wf_original",
            },
            "interaction": {"workflow_confirm": dict(pending)},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_workflow_confirm",
                "tool_arguments": {"prompt": "{}"},
                "tool_result": dict(pending),
                "success": True,
            }]},
        }],
    }
    history = make_session_turns([(UserInput(text="修改目录报告", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    build = await workspace.prepare_build_space(
        "create",
        workflow_id="wf_original",
        stage="verify",
    )
    workflows = WorkflowLibrary("u")
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=workflows,
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=WsWorkflowConfirmMessage(
        session_id="t",
        request_id="workflow_edit_confirm",
        action=action,
        name="目录报告副本" if action == "save_as_new" else "目录报告",
    ))

    await AmphiAgent().init_state(ota, context)

    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert materialized_targets == [expected_target_id]
    assert idempotency_lookups == (["turn_0"] if action == "save_as_new" else [])
    assert result["status"] == "confirmed"
    assert result["operation"] == expected_operation
    assert result["workflow_id"] == saved_workflow_id
    assert result["name"] == (
        "目录报告副本" if action == "save_as_new" else "目录报告"
    )
    assert isinstance(ota.think_status, NormalStageState)
    assert workspace.has_build is False
    assert build.root.exists() is False


@pytest.mark.parametrize(
    ("answer", "expected_status"),
    [
        (
            SimpleNamespace(
                type="workflow_confirm",
                request_id="workflow_confirm_test",
                action="cancel",
                name=None,
            ),
            "cancelled",
        ),
        (
            SimpleNamespace(
                type="chat",
                input="我还想继续调整",
                blocks=[],
            ),
            "not_answered",
        ),
    ],
)
async def test_init_state_workflow_confirm_nonapproval_keeps_build(
    tmp_path: Path,
    answer,
    expected_status: str,
) -> None:
    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_agent._state import BuildStageState
    from src.amphi_agent._workspace import Workspace
    from src.amphi_store import SessionRecord, UserInput

    pending = {
        "request_id": "workflow_confirm_test",
        "default_name": "待保存流程",
        "summary": "验证通过",
        "operation": "create",
        "workflow_id": None,
        "status": "pending",
    }
    dump = {
        "state": {
            "think": {"mode": "build", "stage": "verify"},
            "interaction": {"workflow_confirm": dict(pending)},
        },
        "ota_record": [{
            "action_result": {
                "results": [{
                    "tool_name": "request_human_workflow_confirm",
                    "tool_arguments": {"prompt": "{}"},
                    "tool_result": dict(pending),
                    "success": True,
                }],
            },
        }],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root=str(tmp_path))
    workspace = Workspace("t", session_root=tmp_path)
    await workspace.prepare_build_space("create", stage="verify")
    context = AmphiContext(
        session=Session(record, turns=history),
        workflows=_workflows_for(workspace),
        workspace=workspace,
    )
    ota = AmphiOTAContext(user_input=answer)

    await AmphiAgent().init_state(ota, context)

    result = ota.ota_record[-1].action_result["results"][0]["tool_result"]
    assert result["status"] == expected_status
    assert ota.think_status == BuildStageState(stage="verify")
    assert workspace.has_build


async def test_init_state_workflow_confirm_rejects_stale_request_id() -> None:
    from types import SimpleNamespace

    from src.amphi_agent._agent import AmphiAgent
    from src.amphi_agent._context import AmphiContext, AmphiOTAContext
    from src.amphi_agent._session import Session
    from src.amphi_store import SessionRecord, UserInput

    dump = {
        "state": {
            "think": {"mode": "build", "stage": "verify"},
            "interaction": {
                "workflow_confirm": {
                    "request_id": "current_request",
                    "status": "pending",
                },
            },
        },
        "ota_record": [{}],
    }
    history = make_session_turns([(UserInput(text="/build x", blocks=[]), dump)])
    record = SessionRecord(id="t", user_id="u", workspace_root="/tmp")
    ota = AmphiOTAContext(user_input=SimpleNamespace(
        type="workflow_confirm",
        request_id="stale_request",
        action="confirm",
        workflow_id="wf_1",
    ))

    with pytest.raises(RuntimeError, match="does not match the pending request"):
        await AmphiAgent().init_state(ota, AmphiContext(session=Session(record, turns=history)))
