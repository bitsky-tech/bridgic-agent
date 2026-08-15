"""Stable Build-mode contracts without duplicating Invocation or WS coverage."""

import json
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from bridgic.amphibious import OTARecord, RETURN, StepToolCall, ThinkUnit, ToolArgument
from bridgic.amphibious._type import ThinkResult

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._cognitive import ClarifyThink, ExploreThink, GenerateThink, MainThink, SubAgentThink, VerifyThink
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._state import (
    AwaitingAcceptRule,
    AwaitingBuildConflict,
    AwaitingBuildConfirm,
    AwaitingTaskConfirm,
    BuildStageState,
    NormalStageState,
)
from src.amphi_agent._workspace import BuildSpace, BuildState, Workspace
from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
from src.amphi_agent.tools._request_human import (
    RequestAcceptRule,
    RequestBuild,
    RequestHumanTaskConfirm,
)
from src.amphi_agent.tools._switch import switch
from src.amphi_service.protocol import WsBuildConfirmMessage, WsChatMessage, WsChoiceAnswerMessage, WsTaskConfirmMessage
from src.amphi_service.i18n import use_locale
from src.amphi_store import SessionRecord, TurnStatus, UserInput

from ._session_turns import make_session_turns


class _Stream:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish(self, event: str, **payload) -> None:
        self.events.append((event, payload))


def _ota(user_input: Any = "x", stage: Optional[str] = None) -> AmphiOTAContext:
    ota = AmphiOTAContext(user_input=user_input, stream=_Stream())
    if stage is not None:
        ota.transition_think(BuildStageState(stage=stage))
    return ota


def _build_message(goal: str) -> WsChatMessage:
    return WsChatMessage(
        session_id="session",
        input=f"/build {goal}",
        blocks=[
            {"type": "slash", "id": "build", "label": "构建"},
            {"type": "text", "value": f" {goal}"},
        ],
    )


def _active_stage(ota: AmphiOTAContext) -> str:
    status = ota.think_status
    assert isinstance(status, BuildStageState)
    return status.stage


def _record(tmp_path: Path) -> SessionRecord:
    return SessionRecord(id="session", user_id="user", workspace_root=str(tmp_path))


def _workspace(tmp_path: Path) -> Workspace:
    workspace = Workspace("session", session_root=tmp_path)
    workspace.work_dir.mkdir(parents=True, exist_ok=True)
    return workspace


def _context(*, session: Optional[Session] = None, workspace: Optional[Workspace] = None) -> AmphiContext:
    workflows = WorkflowLibrary("user")
    if workspace is not None and workspace.build is not None:
        workflows.open_package(workspace.build.root)
    return AmphiContext(session=session or Session(), workflows=workflows, workspace=workspace)


def _build_context(session_root: Path) -> AmphiContext:
    workspace = Workspace("session", session_root=session_root)
    build = BuildSpace(workspace.work_dir)
    build.root.mkdir(parents=True, exist_ok=True)
    build.set_stage("clarify")
    workspace.build = build
    return _context(session=Session(), workspace=workspace)


def test_build_workspace_embeds_create_operation(tmp_path: Path) -> None:
    context = _build_context(tmp_path)

    block = ClarifyThink().build_workspace_block(context)

    assert block.startswith("<build_workspace>\nOperation: create\n")
    assert "Workflow id: (none; allocated after final confirmation)" in block
    assert "Baseline: New Workflow; no saved baseline is being edited." in block
    assert "<build_operation>" not in block


def test_build_workspace_embeds_edit_operation(tmp_path: Path) -> None:
    context = _build_context(tmp_path)
    context.workspace.build.set_stage("clarify", "wf-existing")

    block = ClarifyThink().build_workspace_block(context)

    assert block.startswith("<build_workspace>\nOperation: edit\n")
    assert "Workflow id: `wf-existing`" in block
    assert "Baseline: Restored from the saved Workflow." in block
    assert "Preservation: Preserve every unaffected requirement" in block
    assert "<build_operation>" not in block


def _switch(stage: Optional[str] = None, mode: Optional[str] = None) -> StepToolCall:
    arguments = []
    if mode is not None:
        arguments.append(ToolArgument(name="mode", value=mode))
    if stage is not None:
        arguments.append(ToolArgument(name="stage", value=stage))
    return StepToolCall(tool="switch", tool_arguments=arguments)


def _write_valid_workflow(build: BuildSpace, *, with_script: bool = False) -> None:
    (build.root / "workflow").mkdir(parents=True, exist_ok=True)
    script_line = "Run `scripts/run.py`." if with_script else "Complete the task."
    ((build.root / "workflow") / "WORKFLOW.md").write_text(
        "---\nname: example\ndescription: Example workflow\n---\n\n"
        f"# 第 1 步：执行工作流\n{script_line}\n",
        encoding="utf-8",
    )
    validation_line = (
        "Run `scripts/validate.py` and inspect its result."
        if with_script
        else "Inspect the result and apply the recorded semantic criterion."
    )
    ((build.root / "workflow") / "VALIDATE.md").write_text(
        f"# AC-001：验证工作流结果\n"
        f"Confirmed rule: The workflow result is valid.\n{validation_line}\n",
        encoding="utf-8",
    )
    if with_script:
        scripts = (build.root / "workflow") / "scripts"
        scripts.mkdir()
        (scripts / "run.py").write_text("print('ok')\n", encoding="utf-8")
        (scripts / "validate.py").write_text("print('pass')\n", encoding="utf-8")


async def test_structured_build_slash_stays_in_main(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    ota = _ota(_build_message("create report"))

    await AmphiAgent().init_state(
        ota,
        _context(session=Session(_record(tmp_path)), workspace=workspace),
    )

    assert isinstance(ota.think_status, NormalStageState)
    assert not workspace.has_build


async def test_plain_build_text_does_not_enter_build(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    ota = _ota("/build create report")

    await AmphiAgent().init_state(
        ota,
        _context(session=Session(_record(tmp_path)), workspace=workspace),
    )

    assert isinstance(ota.think_status, NormalStageState)
    assert not workspace.has_build


@pytest.mark.parametrize("terminal_status", [TurnStatus.CANCELLED, TurnStatus.FAILED])
async def test_terminal_turn_reopens_the_active_build_stage(
    tmp_path: Path, terminal_status: TurnStatus,
) -> None:
    record = _record(tmp_path)
    workspace = _workspace(tmp_path)
    await workspace.prepare_build_space("create", stage="explore")
    turns = make_session_turns([(
        UserInput(text="/build create report", blocks=[]),
        {
            "state": {"think": {"mode": "build", "stage": "explore"}},
            "ota_record": [{"think_result": {"step_content": "partial"}}],
        },
    )])
    turns[-1].status = terminal_status
    resumed_workspace = _workspace(tmp_path)
    resumed = _ota("continue from here")

    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=turns), workspace=resumed_workspace),
    )

    assert _active_stage(resumed) == "explore"
    assert resumed_workspace.build is not None
    assert resumed_workspace.build.stage == "explore"


async def test_human_resume_keeps_the_original_turn(tmp_path: Path) -> None:
    pending = {
        "state": {
            "think": {"mode": "normal", "stage": "main"},
            "interaction": {"questions": [{"question": "Continue?", "options": []}]},
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_choice",
                "tool_arguments": {},
                "tool_result": None,
                "success": True,
            }]},
        }],
    }
    turns = make_session_turns([(UserInput(text="original request", blocks=[]), pending)])
    context = _context(
        session=Session(_record(tmp_path), turns=turns),
        workspace=_workspace(tmp_path),
    )
    ota = _ota("/build replacement")

    await AmphiAgent().init_state(ota, context)

    assert isinstance(ota.think_status, NormalStageState)
    assert not context.workspace.has_build
    assert context.session.get_all() == []
    assert ota.user_input.input == "original request"


async def test_request_build_parks_main_without_creating_workspace(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    ota = _ota("Create a reusable report process")
    ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="Create a reusable report process",
            mode="ask",
            reason="The same report will run every week.",
            request_id="build-confirm-1",
        ),
    )
    ota.action_result = SimpleNamespace(results=[step])

    async for _ in AmphiAgent().after_action(ota, _context(
        session=Session(_record(tmp_path)),
        workspace=workspace,
    )):
        pass

    assert ota.interaction_status == AwaitingBuildConfirm(
        request_id="build-confirm-1",
        goal="Create a reusable report process",
        reason="The same report will run every week.",
    )
    assert step.tool_result["mode"] == "ask"
    assert step.tool_result["status"] == "pending"
    assert not workspace.has_build


async def test_request_build_starts_immediately_for_explicit_user_intent(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    ota = _ota("Build a reusable report Workflow")
    ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="Create a reusable report process",
            mode="start",
        ),
    )
    ota.action_result = SimpleNamespace(results=[step])

    async for _ in AmphiAgent().after_action(ota, _context(
        session=Session(_record(tmp_path)),
        workspace=workspace,
    )):
        pass

    assert ota.interaction_status is None
    assert ota.think_status == BuildStageState(stage="clarify")
    assert workspace.has_build
    assert step.tool_result == {
        "mode": "start",
        "goal": "Create a reusable report process",
        "message": "The user's explicit Workflow request entered a new Build.",
    }


async def test_request_build_start_replaces_a_retained_build(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    retained = await workspace.prepare_build_space("create", stage="generate")
    (retained.root / "task.md").write_text("old task", encoding="utf-8")
    workspace.close_build_space()
    ota = _ota("Build a different reusable Workflow")
    ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="Build a different reusable Workflow",
            mode="start",
        ),
    )
    ota.action_result = SimpleNamespace(results=[step])

    async for _ in AmphiAgent().after_action(
        ota,
        _context(session=Session(_record(tmp_path)), workspace=workspace),
    ):
        pass

    assert ota.think_status == BuildStageState(stage="clarify")
    assert workspace.build is not None
    assert not (workspace.build.root / "task.md").exists()


@pytest.mark.parametrize(("action", "enters_build"), [("confirm", True), ("cancel", False)])
async def test_build_proposal_resumes_original_turn(tmp_path: Path, action: str, enters_build: bool) -> None:
    pending = {
        "state": {
            "think": {"mode": "normal", "stage": "main"},
            "interaction": AwaitingBuildConfirm(
                request_id="build-confirm-1",
                goal="Create a reusable report process",
                reason="The same report will run every week.",
            ).model_dump(mode="json"),
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_build",
                "tool_arguments": {
                    "goal": "Create a reusable report process",
                    "mode": "ask",
                    "reason": "The same report will run every week.",
                },
                "tool_result": {
                    "mode": "ask",
                    "request_id": "build-confirm-1",
                    "goal": "Create a reusable report process",
                    "reason": "The same report will run every week.",
                    "status": "pending",
                },
                "success": True,
            }]},
        }],
    }
    original = UserInput(text="Create a reusable report process", blocks=[])
    turns = make_session_turns([(original, pending)])
    workspace = _workspace(tmp_path)
    context = _context(
        session=Session(_record(tmp_path), turns=turns),
        workspace=workspace,
    )
    ota = _ota(WsBuildConfirmMessage(
        session_id="session",
        request_id="build-confirm-1",
        action=action,
    ))

    await AmphiAgent().init_state(ota, context)

    assert context.session.get_all() == []
    assert ota.user_input.input == original.text
    assert ota.interaction_status is None
    result = ota.ota_record[0].action_result["results"][0]["tool_result"]
    assert result["status"] == ("confirmed" if enters_build else "cancelled")
    assert isinstance(ota.think_status, BuildStageState if enters_build else NormalStageState)
    assert workspace.has_build is enters_build


async def test_structured_build_slash_does_not_reopen_a_retained_build(
    tmp_path: Path,
) -> None:
    record = _record(tmp_path)
    workspace = _workspace(tmp_path)
    build = await workspace.prepare_build_space("create", stage="generate")
    (build.root / "task.md").write_text("old task", encoding="utf-8")
    workspace.close_build_space()
    turns = make_session_turns([(
        UserInput(text="pause build", blocks=[]),
        {
            "state": {"think": {"mode": "normal", "stage": "main"}, "interaction": None},
            "ota_record": [],
        },
    )])
    ota = _ota(_build_message("continue the report workflow"))

    await AmphiAgent().init_state(
        ota,
        _context(session=Session(record, turns=turns), workspace=workspace),
    )

    assert isinstance(ota.think_status, NormalStageState)
    assert ota.interaction_status is None
    assert workspace.build is None
    assert (workspace.work_dir / ".build" / "task.md").read_text(encoding="utf-8") == "old task"


@pytest.mark.parametrize(
    ("option_id", "stage", "task_kept", "downstream_kept", "action"),
    [
        ("keep", "generate", True, True, "keep"),
        ("merge", "clarify", True, True, "merge"),
        ("replace_new", "clarify", False, False, "replace"),
        # A chat reply — even one naming the build — folds back instead of executing.
        (None, "generate", True, True, "not_answered"),
    ],
)
async def test_request_build_ask_resolves_existing_workspace(
    tmp_path: Path,
    option_id: Optional[str],
    stage: str,
    task_kept: bool,
    downstream_kept: bool,
    action: str,
) -> None:
    record = _record(tmp_path)
    workspace = _workspace(tmp_path)
    build = await workspace.prepare_build_space("create", stage="generate")
    (build.root / "task.md").write_text("old task", encoding="utf-8")
    (build.root / "explore.md").write_text("old explore", encoding="utf-8")
    _write_valid_workflow(build)
    conflict_ota = _ota(_build_message("new task"))
    conflict_ota.transition_think(BuildStageState(stage="generate"))
    conflict_ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="构建另一项任务",
            mode="ask",
            reason="新请求要构建另一项任务，而当前目录统计工作流尚未完成。",
            request_id="build-conflict-1",
        ),
    )
    conflict_ota.action_result = SimpleNamespace(results=[step])
    async for _ in AmphiAgent().after_action(
        conflict_ota,
        _context(session=Session(record), workspace=workspace),
    ):
        pass

    assert isinstance(conflict_ota.interaction_status, AwaitingBuildConflict)
    assert conflict_ota.interaction_status.existing_stage == "generate"
    assert "新请求要构建另一项任务" in conflict_ota.interaction_status.questions[0]["question"]
    assert step.tool_result["status"] == "pending"

    pending_dump = conflict_ota.model_dump(
        mode="json",
        exclude={"stream", "tools", "ota_record"},
    )
    pending_dump["ota_record"] = [{
        "action_result": {"results": [{
            "tool_name": "request_build",
            "tool_arguments": {
                "goal": "构建另一项任务",
                "mode": "ask",
                "reason": "新请求要构建另一项任务，而当前目录统计工作流尚未完成。",
            },
            "tool_result": step.tool_result,
            "success": True,
        }]},
    }]
    pending_turns = make_session_turns([(
        UserInput(text="/build new task", blocks=[]),
        pending_dump,
    )])
    answer: Any = "继续构建上面的工作流" if option_id is None else WsChoiceAnswerMessage(
        session_id="session",
        request_id="build-conflict-1",
        answers=[{"index": 0, "option_id": option_id}],
    )
    resumed = _ota(answer)
    await AmphiAgent().init_state(
        resumed,
        _context(session=Session(record, turns=pending_turns), workspace=workspace),
    )

    assert _active_stage(resumed) == stage
    assert workspace.build is not None
    assert (workspace.build.root / "task.md").exists() is task_kept
    assert (workspace.build.root / "explore.md").exists() is downstream_kept
    assert (workspace.build.root / "workflow").exists() is downstream_kept
    result = resumed.ota_record[0].action_result["results"][0]["tool_result"]
    assert result["action"] == action
    assert result["status"] == ("not_answered" if action == "not_answered" else "resolved")
    assert resumed.interaction_status is None


async def test_request_build_ask_carries_the_recent_edit_target(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    await workspace.prepare_build_space("create", stage="generate")
    ota = _ota("编辑另一个工作流", stage="generate")
    ota.ota_record = [OTARecord.model_validate({
        "action_result": {"results": [{
            "tool_name": "edit_workflow",
            "tool_arguments": {"workflow_id": "workflow-next"},
            "tool_result": {
                "workflow_id": "workflow-next",
                "workflow_name": "Next",
            },
            "success": True,
        }]},
    })]
    ota.open_record()
    step = SimpleNamespace(
        tool_name="request_build",
        success=True,
        tool_result=RequestBuild(
            goal="编辑另一个已保存工作流",
            mode="ask",
            reason="用户要求编辑另一个已保存工作流。",
            request_id="build-edit-conflict-1",
        ),
    )
    ota.action_result = SimpleNamespace(results=[step])

    async for _ in AmphiAgent().after_action(
        ota,
        _context(session=Session(_record(tmp_path)), workspace=workspace),
    ):
        pass

    conflict = ota.interaction_status
    assert isinstance(conflict, AwaitingBuildConflict)
    assert conflict.requested_workflow_id == "workflow-next"
    assert [
        option["label"]
        for option in conflict.questions[0]["options"]
    ] == ["保留并继续", "删除并编辑"]


async def test_build_conflict_choices_use_stable_ids_and_the_active_locale(tmp_path: Path) -> None:
    """Choice execution must consume ids, while the card owns its display copy."""
    workspace = _workspace(tmp_path)
    await workspace.prepare_build_space("create", stage="generate")
    context = _context(session=Session(_record(tmp_path)), workspace=workspace)
    request = RequestBuild(
        goal="Build another task",
        mode="ask",
        reason="Another build is already in progress.",
        request_id="build-i18n-1",
    )

    with use_locale("en"):
        conflict = AmphiAgent()._build_request_interaction(context, request)

    assert conflict.questions[0]["header"] == "Unfinished build"
    assert [
        (option["id"], option["label"])
        for option in conflict.questions[0]["options"]
    ] == [
        ("keep", "Keep and continue"),
        ("merge", "Merge new requirements"),
        ("replace_new", "Discard and start over"),
    ]


async def test_dispatch_resumes_and_moves_between_stages() -> None:
    parked = {
        "state": {
            "think": {"mode": "build", "stage": "generate"},
            "interaction": None,
        },
        "ota_record": [],
    }
    context = _context(session=Session(
        SessionRecord(id="session", user_id="user", workspace_root="/tmp"),
        turns=make_session_turns([(UserInput(text="previous", blocks=[]), parked)]),
    ))
    ota = _ota("continue")
    generator = AmphiAgent().on_agent(ota, context)

    first = await generator.asend(None)
    assert isinstance(first, ThinkUnit) and first.name == "generate"
    ota.transition_think(BuildStageState(stage="verify"))
    second = await generator.asend("generated")
    assert isinstance(second, ThinkUnit) and second.name == "verify"
    ota.transition_think(NormalStageState())
    main = await generator.asend("verified")
    assert isinstance(main, ThinkUnit) and main.name == "main"
    assert ("stage", {"mode": "normal", "stage": None}) in ota.stream.events
    returned = await generator.asend("build summary")
    assert isinstance(returned, RETURN) and returned.value == "build summary"
    await generator.aclose()


async def test_child_normal_state_dispatches_the_dedicated_subagent_think() -> None:
    child = SessionRecord(
        id="child",
        user_id="user",
        parent_session_id="parent",
        workspace_root="/tmp",
    )
    context = _context(session=Session(child))
    ota = _ota("delegated task")
    agent = AmphiAgent()
    generator = agent.on_agent(ota, context)

    first = await generator.asend(None)

    assert isinstance(first, ThinkUnit) and first.name == "subagent"
    assert type(agent.main._worker_template) is MainThink
    assert type(agent.subagent._worker_template) is SubAgentThink
    await generator.aclose()


def test_child_special_state_cannot_select_a_root_think_unit() -> None:
    child = SessionRecord(
        id="child",
        user_id="user",
        parent_session_id="parent",
        workspace_root="/tmp",
    )
    context = _context(session=Session(child))
    ota = _ota("delegated task", stage="clarify")

    with pytest.raises(RuntimeError, match="Child Sessions can run only"):
        AmphiAgent()._current_think_unit_name(ota, context)


async def test_switch_reason_is_injected_for_the_next_build_think() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    ota = _ota(stage="explore")
    ota.open_record()
    handoff = "飞书记录读取探路脚本已通过；Generate 从 `.build/scripts/read_record.py` 开始。"
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_id="switch-1",
        tool_name="switch",
        tool_arguments={"stage": "generate", "reason": handoff},
        success=True,
        error=None,
        tool_result=await switch(stage="generate", reason=handoff),
    )])

    async for _ in AmphiAgent().after_action(ota, context):
        pass

    assert _active_stage(ota) == "generate"
    note = ota.ota_record[-1].observation_result
    assert "[stage handoff] `build/explore` → `build/generate`" in note
    assert handoff in note
    messages = GenerateThink().turn_messages_block(ota, context)
    assert handoff in messages[-1].content


async def test_switch_to_main_retains_build_files_but_clears_domain_bindings() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    ota = _ota(stage="clarify")
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="switch",
        success=True,
        tool_result={"mode": "normal", "stage": None, "reason": "先回答用户的问题"},
    )])

    async for _ in AmphiAgent().after_action(ota, context):
        pass

    assert ota.think_status == NormalStageState()
    assert context.workspace.has_build
    assert context.workspace.build is None
    assert context.workflows.package is None


async def test_empty_main_answer_continues_for_user_visible_summary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.amphi_agent._agent.MAX_THINK_UNITS_PER_TURN", 1)
    context = _context(session=Session())
    ota = _ota("finish the task")
    ota.ota_record.append(OTARecord())
    generator = AmphiAgent().on_agent(ota, context)

    first = await generator.asend(None)
    assert isinstance(first, ThinkUnit) and first.name == "main"
    retry = await generator.asend("")

    assert isinstance(retry, ThinkUnit) and retry.name == "main"
    note = ota.ota_record[-1].observation_result
    assert "last response was empty" in note
    assert "user-visible final answer" in note

    returned = await generator.asend("Task completed.")
    assert isinstance(returned, RETURN) and returned.value == "Task completed."
    await generator.aclose()


async def test_stage_handoffs_require_their_artifacts() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build
    clarify = _ota(stage="clarify")
    explore = _ota(stage="explore")

    accept_review = StepToolCall(tool="request_accept_rule", tool_arguments=[])
    task_review = StepToolCall(tool="request_human_task_confirm", tool_arguments=[])

    # Acceptance candidates are reviewed before task.md is written.
    assert await ClarifyThink().legality_check(accept_review, clarify, context) is None
    assert "task.md" in await ClarifyThink().legality_check(task_review, clarify, context)
    assert "task.md" in await ClarifyThink().legality_check(_switch("explore"), clarify, context)
    (build.root / "task.md").write_text("## Task\nX", encoding="utf-8")
    assert "reviewed" in await ClarifyThink().legality_check(_switch("explore"), clarify, context)
    assert "request_accept_rule" in await ClarifyThink().legality_check(
        task_review,
        clarify,
        context,
    )
    build.start_acceptance_review("accept-rule-1")
    repeated_review = await ClarifyThink().legality_check(
        accept_review,
        clarify,
        context,
    )
    assert repeated_review and "one-time acceptance outline" in repeated_review
    assert await ClarifyThink().legality_check(
        task_review,
        clarify,
        context,
    ) is None

    assert "explore.md" in await ExploreThink().legality_check(_switch("generate"), explore, context)
    (build.root / "explore.md").write_text("1. inspect", encoding="utf-8")
    assert await ExploreThink().legality_check(_switch("generate"), explore, context) is None
    assert await ExploreThink().legality_check(_switch("clarify"), explore, context) is None


async def test_first_acceptance_review_parks_without_task_or_persisting_ac_content() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    ota = _ota(stage="clarify")
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="request_accept_rule",
        success=True,
        tool_result=RequestAcceptRule(["The result exists."], "accept-rule-1"),
    )])

    async for _ in AmphiAgent().after_action(ota, context):
        pass

    assert isinstance(ota.interaction_status, AwaitingAcceptRule)
    assert not (context.workspace.build.root / "task.md").exists()
    assert context.workspace.build.acceptance_review_request_id == "accept-rule-1"
    state = json.loads(
        (context.workspace.build.root / ".state.json").read_text(encoding="utf-8")
    )
    assert state["acceptance_contract"] == {"request_id": "accept-rule-1"}
    assert "acceptance_review_request_id" not in state
    serialized = json.dumps(state, ensure_ascii=False)
    assert "The result exists." not in serialized
    assert "AC-001" not in serialized


def test_verify_continue_prompt_requires_confirmation_instead_of_normal_switch() -> None:
    ota = _ota(stage="verify")
    ota.ota_record.append(SimpleNamespace(observation_result=None))

    AmphiAgent._stamp_build_continue(ota)

    note = ota.ota_record[-1].observation_result
    assert "safe verification PASS" in note
    assert "request_human_workflow_confirm" in note
    assert 'switch(mode="normal") as a completion shortcut' in note


async def test_explore_rejects_heading_shaped_machine_annotations() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    handoff = _switch("generate")
    explore = _ota(stage="explore")
    (context.workspace.build.root / "explore.md").write_text(
        "# 探索报告\n\n## 编译计划\n\n1. 扫描目录\n\n# CODE: deterministic scan\n",
        encoding="utf-8",
    )

    rejection = await ExploreThink().legality_check(handoff, explore, context)

    assert rejection and "machine annotation" in rejection
    (context.workspace.build.root / "explore.md").write_text(
        "# 探索报告\n\n## 编译计划\n\n1. 扫描目录\n   - `CODE:` 确定性扫描\n",
        encoding="utf-8",
    )
    assert await ExploreThink().legality_check(handoff, explore, context) is None


@pytest.mark.parametrize(
    ("diagram", "reason"),
    [
        ("```mermaid\nflowchart SIDEWAYS\nA --> B\n```", "flow direction"),
        ("```mermaid\nflowchart TD\nA[Open\n```", "unmatched"),
        ("```mermaid\nflowchart TD\nA --> B", "not closed"),
    ],
)
async def test_clarify_rejects_invalid_mermaid(diagram: str, reason: str) -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    (context.workspace.build.root / "task.md").write_text(
        f"## Task\nX\n\n## Workflow\n{diagram}",
        encoding="utf-8",
    )

    rejection = await ClarifyThink().legality_check(
        StepToolCall(tool="request_human_task_confirm", tool_arguments=[]),
        _ota(stage="clarify"),
        context,
    )

    assert rejection and reason in rejection


async def test_clarify_accepts_text_or_valid_mermaid() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    call = StepToolCall(tool="request_human_task_confirm", tool_arguments=[])
    (context.workspace.build.root / "task.md").write_text(
        "## Task\nX\n\n## Workflow\n```mermaid\nflowchart TD\nA --> B\n```\n",
        encoding="utf-8",
    )
    context.workspace.build.start_acceptance_review("accept-rule-1")
    assert await ClarifyThink().legality_check(call, _ota(stage="clarify"), context) is None

    (context.workspace.build.root / "task.md").write_text("## Task\nOne step", encoding="utf-8")
    assert await ClarifyThink().legality_check(call, _ota(stage="clarify"), context) is None


def test_build_acceptance_review_state_keeps_only_request_identity_across_stages() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build

    assert build.start_acceptance_review("accept-rule-1") == "accept-rule-1"
    build.set_stage("explore")

    checkpoint = context.workspace.build_checkpoint()
    assert isinstance(checkpoint, BuildState)
    assert checkpoint.acceptance_contract == {"request_id": "accept-rule-1"}
    state = json.loads((build.root / ".state.json").read_text(encoding="utf-8"))
    assert state["acceptance_contract"] == {"request_id": "accept-rule-1"}
    assert "acceptance_review_request_id" not in state
    assert "rules" not in state


def test_build_task_confirmation_snapshot_is_durable_and_idempotent() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build

    build.record_task_confirmation("task-1", "## Task\nFirst review")
    build.set_stage("explore")
    build.record_task_confirmation("task-1", "## Task\nFirst review")

    assert build.last_task_confirmation == {
        "request_id": "task-1",
        "task_markdown": "## Task\nFirst review",
    }
    with pytest.raises(RuntimeError, match="snapshot changed for the same request"):
        build.record_task_confirmation("task-1", "## Task\nCorrupted review")


async def test_replacing_build_clears_task_confirmation_snapshot(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    build = await workspace.prepare_build_space("create", stage="clarify")
    build.record_task_confirmation("task-1", "## Task\nFirst Build")

    replacement = await workspace.prepare_build_space("create", stage="clarify")

    assert replacement.last_task_confirmation is None


@pytest.mark.parametrize("source_change", ["modified", "deleted"])
async def test_edit_first_task_review_uses_the_restore_time_baseline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    source_change: str,
) -> None:
    workflow_id = "wf-existing"
    restored_task = "## Task\nSaved at edit entry"
    saved_root = tmp_path / "saved-workflow"
    (saved_root / "workflow").mkdir(parents=True)
    (saved_root / "task.md").write_text(restored_task, encoding="utf-8")
    (saved_root / "explore.md").write_text("# Explore\nUse the saved plan.\n", encoding="utf-8")
    (saved_root / "verify.md").write_text("# Verify\nPASS\n", encoding="utf-8")
    ((saved_root / "workflow") / "WORKFLOW.md").write_text(
        "---\nname: saved-plan\ndescription: Create the result.\n---\n\n"
        "# Execute\nCreate the result.\n",
        encoding="utf-8",
    )
    ((saved_root / "workflow") / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    saved = WorkflowPackage(saved_root, workflow_id=workflow_id, name="Saved plan")
    workflows = WorkflowLibrary("user")
    workflows.data()[workflow_id] = saved

    @asynccontextmanager
    async def guarded_source(requested_workflow_id: str):
        assert requested_workflow_id == workflow_id
        yield saved

    monkeypatch.setattr(workflows, "guarded_source", guarded_source)
    session_root = tmp_path / "session"
    workspace = _workspace(session_root)
    context = AmphiContext(
        session=Session(_record(session_root)),
        workflows=workflows,
        workspace=workspace,
    )
    ota = _ota()
    ota.transition_think(BuildStageState(stage="clarify", workflow_id=workflow_id))

    await AmphiAgent._sync_build_space(ota, context, create=True)

    assert workspace.build is not None
    assert (workspace.build.root / "task.md").read_text(encoding="utf-8") == restored_task
    if source_change == "modified":
        (saved_root / "task.md").write_text(
            "## Task\nSaved after edit entry",
            encoding="utf-8",
        )
    else:
        workflows.data().pop(workflow_id)
        (saved_root / "task.md").unlink()
    (workspace.build.root / "task.md").write_text(
        "## Task\nFirst edited review",
        encoding="utf-8",
    )
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="request_human_task_confirm",
        success=True,
        tool_result=RequestHumanTaskConfirm("task-edit-1"),
    )])

    async for _ in AmphiAgent().after_action(ota, context):
        pass

    payload = ota.interaction_status.task_confirm
    assert payload["previous_task_markdown"] == restored_task
    assert payload["original_task_markdown"] == restored_task


@pytest.mark.parametrize("reply_kind", ["structured_revise", "direct_chat"])
async def test_edit_revision_records_the_real_reply_snapshot_for_the_next_card(
    tmp_path: Path,
    reply_kind: str,
) -> None:
    workflow_id = "wf-existing"
    saved_original = "## Task\nSaved original"
    first_review = "## Task\nFirst edited review"
    second_review = "## Task\nSecond edited review"
    first_payload = {
        "request_id": "task-edit-1",
        "task_markdown": first_review,
        "previous_task_markdown": saved_original,
        "operation": "edit",
        "workflow_id": workflow_id,
        "original_task_markdown": saved_original,
        "status": "pending",
    }
    pending = {
        "state": {
            "think": {
                "mode": "build",
                "stage": "clarify",
                "workflow_id": workflow_id,
            },
            "interaction": AwaitingTaskConfirm(
                task_confirm=first_payload,
            ).model_dump(mode="json"),
        },
        "ota_record": [{
            "action_result": {"results": [{
                "tool_name": "request_human_task_confirm",
                "tool_arguments": {},
                "tool_result": first_payload,
                "success": True,
            }]},
        }],
    }
    turns = make_session_turns(
        [(UserInput(text="Edit the saved Workflow", blocks=[]), pending)],
        user_id="user",
        session_id="session",
    )
    workspace = _workspace(tmp_path)
    build = await workspace.prepare_build_space(
        "create",
        workflow_id=workflow_id,
        stage="clarify",
    )
    (build.root / "task.md").write_text(
        "## Task\nFile changed while the first card was pending",
        encoding="utf-8",
    )
    context = _context(
        session=Session(_record(tmp_path), turns=turns),
        workspace=workspace,
    )
    response = (
        WsTaskConfirmMessage(
            session_id="session",
            request_id="task-edit-1",
            action="revise",
            feedback="Revise the task definition.",
        )
        if reply_kind == "structured_revise"
        else WsChatMessage(
            session_id="session",
            input="Revise the task definition directly.",
            blocks=[{"type": "text", "value": "Revise the task definition directly."}],
        )
    )
    ota = _ota(response)
    agent = AmphiAgent()

    await agent.init_state(ota, context)

    assert workspace.build is not None
    assert workspace.build.last_task_confirmation == {
        "request_id": "task-edit-1",
        "task_markdown": first_review,
    }
    assert context.session.get_all() == []
    (workspace.build.root / "task.md").write_text(second_review, encoding="utf-8")
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="request_human_task_confirm",
        success=True,
        tool_result=RequestHumanTaskConfirm("task-edit-2"),
    )])

    async for _ in agent.after_action(ota, context):
        pass

    payload = ota.interaction_status.task_confirm
    assert payload["operation"] == "edit"
    assert payload["previous_task_markdown"] == first_review
    assert payload["previous_task_markdown"] != saved_original


async def test_execution_only_marker_skips_validation_audit_without_contract() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build
    (build.root / "workflow").mkdir(parents=True, exist_ok=True)
    ((build.root / "workflow") / "WORKFLOW.md").write_text(
        "---\nname: example\ndescription: Example workflow\n---\n\n"
        "# 第 1 步：执行工作流\nComplete the task.\n",
        encoding="utf-8",
    )
    ((build.root / "workflow") / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )

    state = json.loads((build.root / ".state.json").read_text(encoding="utf-8"))
    assert state["acceptance_contract"] is None
    assert await GenerateThink().legality_check(
        _switch("verify"),
        _ota(stage="generate"),
        context,
    ) is None

    (build.root / "verify.md").write_text(
        "# 验证报告\n\n## 执行检查\n工作流可以正常执行。\n\n## 总体结论\nPASS\n",
        encoding="utf-8",
    )
    confirm = StepToolCall(tool="request_human_workflow_confirm", tool_arguments=[])
    assert await VerifyThink().legality_check(confirm, _ota(stage="verify"), context) is None


async def test_generate_and_verify_validate_deliverables() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build
    generate = _ota(stage="generate")
    handoff = _switch("verify")

    assert "WORKFLOW.md" in await GenerateThink().legality_check(handoff, generate, context)
    _write_valid_workflow(build, with_script=True)
    assert await GenerateThink().legality_check(handoff, generate, context) is None

    validation = (build.root / "workflow") / "VALIDATE.md"
    valid_validation = validation.read_text(encoding="utf-8")
    validation.write_text(
        valid_validation
        + "\n# AC-002：额外验证\nConfirmed rule: An unapproved condition.\n",
        encoding="utf-8",
    )
    assert await GenerateThink().legality_check(handoff, generate, context) is None
    validation.write_text(
        valid_validation.replace("The workflow result is valid.", "A stronger invented rule."),
        encoding="utf-8",
    )
    assert await GenerateThink().legality_check(handoff, generate, context) is None
    validation.write_text(valid_validation, encoding="utf-8")

    entry = (build.root / "workflow") / "WORKFLOW.md"
    valid_entry = entry.read_text(encoding="utf-8")
    entry.write_text(
        "---\nname: example\ndescription: Example workflow\n---\n\n# 第 1 步：执行工作流\n",
        encoding="utf-8",
    )
    assert "has no instructions" in await GenerateThink().legality_check(handoff, generate, context)
    entry.write_text(valid_entry, encoding="utf-8")

    validation.unlink()
    assert "VALIDATE.md" in await GenerateThink().legality_check(handoff, generate, context)
    validation.write_text(
        "# AC-001：验证工作流结果\n"
        "Confirmed rule: The workflow result is valid.\n"
        "Run `scripts/validate.py`.\n",
        encoding="utf-8",
    )

    script = (build.root / "workflow") / "scripts" / "run.py"
    script.write_text("def (:\n", encoding="utf-8")
    assert "syntax" in await GenerateThink().legality_check(handoff, generate, context)
    script.write_text("print('ok')\n", encoding="utf-8")

    validation.write_text(
        "# AC-001：验证工作流结果\n"
        "Confirmed rule: The workflow result is valid.\n"
        "Run `scripts/missing.py`.\n",
        encoding="utf-8",
    )
    assert "VALIDATE.md references" in await GenerateThink().legality_check(
        handoff, generate, context,
    )
    validation.write_text(
        "# AC-001：验证工作流结果\n"
        "Confirmed rule: The workflow result is valid.\n"
        "Run `scripts/validate.py`.\n",
        encoding="utf-8",
    )

    confirm = StepToolCall(tool="request_human_workflow_confirm", tool_arguments=[])
    verify = _ota(stage="verify")
    source_write = StepToolCall(tool="write_file", tool_arguments=[
        ToolArgument(name="file_path", value=str((build.root / "workflow") / "scripts" / "run.py")),
        ToolArgument(name="content", value="print('changed')\n"),
    ])
    assert await VerifyThink().legality_check(source_write, verify, context) is None
    missing_report = await VerifyThink().legality_check(confirm, verify, context)
    assert "verify.md" in missing_report
    assert "isolated test scope" in missing_report
    (build.root / "verify.md").write_text("# 验证报告\n\n## 总体结论\nFAIL\n", encoding="utf-8")
    failed_report = await VerifyThink().legality_check(confirm, verify, context)
    assert "Do not mark PASS" in failed_report
    assert "safety limitation was hidden" in failed_report
    (build.root / "verify.md").write_text(
        "# 验证报告\n\n"
        "## Workflow 运行\n"
        "PASS：工作流执行成功。\n\n"
        "## 验收结果\n"
        "AC-001 PASS：结果有效。\n\n"
        "## 总体结论\n"
        "PASS\n",
        encoding="utf-8",
    )
    assert await VerifyThink().legality_check(confirm, verify, context) is None


async def test_verify_confirmation_allows_disclosed_unexecuted_side_effect() -> None:
    context = _build_context(Path(tempfile.mkdtemp()))
    build = context.workspace.build
    workflow = build.root / "workflow"
    workflow.mkdir(parents=True)
    (workflow / "WORKFLOW.md").write_text(
        "---\nname: notify\ndescription: Prepare and send a notification\n---\n\n"
        "# 第 1 步：准备通知\nCreate the notification payload.\n\n"
        "# 第 2 步：发送通知\nSend the payload to the production recipient.\n",
        encoding="utf-8",
    )
    (workflow / "VALIDATE.md").write_text(
        "# AC-001：确认通知已送达\n"
        "Confirmed rule: The production notification is delivered.\n"
        "Inspect the externally observable delivery state without changing it.\n",
        encoding="utf-8",
    )
    (build.root / "verify.md").write_text(
        "# 验证报告\n\n"
        "## 测试范围与工作流检查\n"
        "第 1 步 PASS：在隔离目录使用一个样例生成了完整通知载荷。\n"
        "第 2 步 NOT RUN (safety)：真实发送不可逆，发送边界未调用；已检查载荷和目标参数。\n\n"
        "## 验收结果\n"
        "AC-001 NOT RUN (safety)：未真实发送，因此没有预测送达结果。\n\n"
        "## 总体结论\n"
        "PASS\n",
        encoding="utf-8",
    )

    confirm = StepToolCall(tool="request_human_workflow_confirm", tool_arguments=[])

    assert await VerifyThink().legality_check(confirm, _ota(stage="verify"), context) is None


async def test_control_calls_are_vetted_then_dispatched() -> None:
    agent = AmphiAgent()
    context = _build_context(Path(tempfile.mkdtemp()))
    ota = _ota(stage="clarify")
    ota.open_record()
    ota.tools = ClarifyThink().select_tools(ota, context)
    ota.think_result = ThinkResult(
        step_content="handoff",
        tool_calls=[_switch("explore")],
    )

    gate = agent.before_action(ota, context)
    approved = (await gate.asend(None)).value
    await gate.aclose()
    assert approved.tool_calls == []

    ota.action_result = None
    async for _ in agent.after_action(ota, context):
        pass
    assert _active_stage(ota) == "clarify"
    assert ota.action_result.results[0].success is False
    assert "task.md" in ota.action_result.results[0].error

    ota = _ota(stage="explore")
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="switch",
        success=True,
        tool_result={"mode": None, "stage": "clarify"},
    )])
    async for _ in agent.after_action(ota, context):
        pass
    assert _active_stage(ota) == "clarify"

    (context.workspace.build.root / "task.md").write_text("## Task\nReview", encoding="utf-8")
    ota = _ota(stage="clarify")
    ota.open_record()
    ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="request_human_task_confirm",
        success=True,
        tool_result=RequestHumanTaskConfirm("task-request"),
    )])
    async for _ in agent.after_action(ota, context):
        pass
    assert isinstance(ota.interaction_status, AwaitingTaskConfirm)
    assert ota.interaction_status.task_confirm["task_markdown"] == "## Task\nReview"
    assert ota.interaction_status.task_confirm["previous_task_markdown"] == ""

    context.workspace.build.record_task_confirmation(
        "task-request",
        "## Task\nReview",
    )
    (context.workspace.build.root / "task.md").write_text(
        "## Task\nRevised review",
        encoding="utf-8",
    )
    next_ota = _ota(stage="clarify")
    next_ota.open_record()
    next_ota.action_result = SimpleNamespace(results=[SimpleNamespace(
        tool_name="request_human_task_confirm",
        success=True,
        tool_result=RequestHumanTaskConfirm("task-request-2"),
    )])

    async for _ in agent.after_action(next_ota, context):
        pass

    assert next_ota.interaction_status.task_confirm["previous_task_markdown"] == "## Task\nReview"


async def test_stage_messages_include_only_required_artifacts(connected_repo: None) -> None:
    tmp = Path(tempfile.mkdtemp())
    context = _build_context(tmp)
    workspace = context.workspace
    (workspace.build.root / "task.md").write_text("## Task\nX", encoding="utf-8")
    (workspace.build.root / "explore.md").write_text("1. inspect", encoding="utf-8")
    workflow = workspace.build.root / "workflow"
    scripts = workflow / "scripts"
    scripts.mkdir(parents=True)
    (workflow / "WORKFLOW.md").write_text("# Execute\nRun it.\n", encoding="utf-8")
    (workflow / "VALIDATE.md").write_text("# Validate\nCheck it.\n", encoding="utf-8")
    (scripts / "run.py").write_text("print('ok')\n", encoding="utf-8")
    context = _context(session=Session(_record(tmp)), workspace=workspace)

    expected = {
        ClarifyThink: ("task.md",),
        ExploreThink: ("task.md",),
        GenerateThink: ("task.md", "explore.md"),
        VerifyThink: ("task.md", "explore.md"),
    }
    for worker_type, artifacts in expected.items():
        system = (await worker_type().assemble_messages(
            _ota(stage=worker_type.__name__.removesuffix("Think").lower()),
            context,
        ))[0].content
        assert str(workspace.build.root) in system
        assert "<acceptance_contract>" not in system
        assert "rebuilt from the live Build filesystem before every model call" in system
        assert "do not call `read_file` merely to recover" not in system
        for name in ("task.md", "explore.md", "verify.md"):
            assert (f"<{name}>" in system) is (name in artifacts)
        for path, body in (
            ("workflow/WORKFLOW.md", "# Execute\nRun it."),
            ("workflow/VALIDATE.md", "# Validate\nCheck it."),
            ("workflow/scripts/run.py", "print('ok')"),
        ):
            assert f'<workflow_artifact path="{path}">' not in system
            assert body not in system

    clarify = (await ClarifyThink().assemble_messages(_ota(stage="clarify"), context))[0].content
    assert "all human-readable material in these files must use" in clarify
    assert "task definition" in clarify and "requirement contract" not in clarify
    assert "First pin down the end-to-end actions" in clarify
    assert "Call `request_accept_rule` only once" in clarify
    explore = (await ExploreThink().assemble_messages(_ota(stage="explore"), context))[0].content
    assert "exactly two level-two sections meaning Execution environment and Task flow" in explore
    assert "Skill discovery may be skipped only when" in explore
    assert "For every other task, follow `how-to` and actively search for" in explore
    assert "Only after the `how-to` process finds no sufficiently matched and usable Skill" in explore
    assert "mark it `CODE:`, `AGENT:`, or `HUMAN:`" in explore
    assert "prefer `CODE:` wherever possible" in explore
    assert "write an executable draft script under `.build/scripts/`" in explore
    assert "must remain read-only and must not modify state or cause side effects" in explore
    assert "actual-path walkthrough, not a desk exercise" in explore
    assert "Prepare them during Explore" in explore
    assert "execute one complete representative iteration" in explore
    assert "traverse one real continuation and confirm the corresponding stopping state" in explore
    assert "record that exact boundary" in explore
    assert "quick path" not in explore and ".explore/" not in explore
    generate = (await GenerateThink().assemble_messages(_ota(stage="generate"), context))[0].content
    assert "each level-one section representing one runtime step" in generate
    assert "`WORKFLOW.md` only performs the task and must not invoke `VALIDATE.md`" in generate
    assert "Translate the examples into the Build language" in generate
    assert "background work directory" in generate
    assert "current acceptance criteria in `task.md` as the outline" in generate
    assert "use the successful `.build/scripts/` draft as grounded evidence" in generate
    assert "must never be referenced directly by `WORKFLOW.md`" in generate
    assert "For `HUMAN:`, state in `WORKFLOW.md` when to pause" in generate
    assert "# AC-001 — <short, specific check name>" in generate
    assert "Validation evidence:" not in generate
    verify = (await VerifyThink().assemble_messages(_ota(stage="verify"), context))[0].content
    assert "Keep all source under `workflow/` read-only" in verify
    assert "smallest bounded execution that preserves its operations, branches, and loop behavior" in verify
    assert "use the operation path in `explore.md` as the coverage baseline" in verify
    assert "Never execute an action that can change actual external or business state" in verify
    assert "Replay the operation sequence recorded in `explore.md` directly in the actual environment" in verify
    assert "create a fresh full copy at `.verify/workflow/`" in verify
    assert "It proves only the per-item body that actually ran" in verify
    assert "record that section as `NOT RUN (safety)`" in verify
    assert "do not have an Agent reimplement the check" in verify
    assert "apply its recorded semantic rubric only to the real result" in verify
    assert "VERIFY_ONLY_BEGIN" in verify
    assert "VERIFY_ONLY_END" in verify
