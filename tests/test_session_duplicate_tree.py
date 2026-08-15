"""SessionService.duplicate 复制主 Session 及其直接 Child Sessions。"""
from pathlib import Path

import httpx
import pytest

from src.amphi_agent._workflow_run import RunWorkflow, WorkflowRunLibrary
from src.amphi_agent._workspace import Workspace
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_service.runtime import SessionService
from src.amphi_store import (
    SessionMountRepository,
    SessionRepository,
    SessionStatus,
    SessionTurnRepository,
    SubAgentMode,
    TurnStatus,
    UserInput,
    WorkflowRepository,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)


@pytest.mark.asyncio
async def test_duplicate_copies_background_children_into_new_tree(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    service = SessionService()
    sessions = SessionRepository()
    root = await service.create_root(LOCAL_USER_ID)
    bg = await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=root.id,
        parent_call_id="call-bg",
        subagent_mode=SubAgentMode.BACKGROUND,
        title="抓京东",
    )
    await sessions.create_child(
        LOCAL_USER_ID,
        parent_session_id=root.id,
        parent_call_id="call-fg",
        subagent_mode=SubAgentMode.BLOCKING,
        title="汇总",
    )
    await sessions.update_turn_projection(
        bg.id,
        LOCAL_USER_ID,
        status=SessionStatus.AWAITING,
        model="child-model",
        last_answer="需要确认",
    )
    workflows = WorkflowRepository()
    root_workflow = await workflows.create(
        LOCAL_USER_ID,
        name="根会话工作流",
        description=None,
        domain=None,
        workflow_dir=str(tmp_path / "root-workflow"),
        source_session_id=root.id,
    )
    child_workflow = await workflows.create(
        LOCAL_USER_ID,
        name="子会话工作流",
        description=None,
        domain=None,
        workflow_dir=str(tmp_path / "child-workflow"),
        source_session_id=bg.id,
    )
    runs = WorkflowRunRepository()
    root_run, _ = await runs.create_or_confirm_terminal(
        LOCAL_USER_ID,
        result_id=runs.new_id(),
        workflow_id=root_workflow.id,
        workflow_name=root_workflow.name,
        source_session_id=root.id,
        result_dir=str(tmp_path / "root-run"),
        workflow_input=UserInput(text="运行根会话工作流"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )
    child_run, _ = await runs.create_or_confirm_terminal(
        LOCAL_USER_ID,
        result_id=runs.new_id(),
        workflow_id=child_workflow.id,
        workflow_name=child_workflow.name,
        source_session_id=bg.id,
        result_dir=str(tmp_path / "child-run"),
        workflow_input=UserInput(text="运行子会话工作流"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.NOT_REQUIRED,
    )

    new_root = await service.duplicate(root)

    children = await sessions.list_children(LOCAL_USER_ID, new_root.id)
    assert len(children) == 2  # 复制所有子 Agent(background + foreground)
    modes = {c.subagent_mode for c in children}
    assert SubAgentMode.BACKGROUND in modes and SubAgentMode.BLOCKING in modes
    for c in children:
        assert c.parent_session_id == new_root.id
        assert c.id != bg.id  # 新 id
    assert {c.title for c in children} == {"抓京东", "汇总"}
    copied_bg = next(child for child in children if child.title == "抓京东")
    assert copied_bg.status is SessionStatus.AWAITING
    assert copied_bg.last_answer == "需要确认"
    copied_root_workflows = await workflows.list_for_session(LOCAL_USER_ID, new_root.id)
    copied_child_workflows = await workflows.list_for_session(LOCAL_USER_ID, copied_bg.id)
    assert [workflow.id for workflow in copied_root_workflows] == [root_workflow.id]
    assert [workflow.id for workflow in copied_child_workflows] == [child_workflow.id]
    copied_root_runs = await runs.list_for_session(LOCAL_USER_ID, new_root.id)
    copied_child_runs = await runs.list_for_session(LOCAL_USER_ID, copied_bg.id)
    assert [run.id for run in copied_root_runs] == [root_run.id]
    assert [run.id for run in copied_child_runs] == [child_run.id]
    assert copied_root_runs[0].source_session_id == root.id
    assert copied_child_runs[0].source_session_id == bg.id


@pytest.mark.asyncio
async def test_duplicate_reuses_active_run_checkpoint_without_result_id_collision(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    service = SessionService()
    source_session = await service.create_root(LOCAL_USER_ID)
    source = tmp_path / "workflow"
    package = source / "workflow"
    package.mkdir(parents=True)
    (package / "WORKFLOW.md").write_text(
        "---\nname: duplicate-run\ndescription: Duplicate Run fixture.\n---\n\n"
        "# Execute\n\nProduce a result.\n",
        encoding="utf-8",
    )
    (package / "VALIDATE.md").write_text(
        "---\nvalidation: none\n---\n",
        encoding="utf-8",
    )
    for name in ("task.md", "explore.md", "verify.md"):
        (source / name).write_text(f"# {name}\n", encoding="utf-8")
    attachment = await service.upload_mount(
        source_session,
        filename="request.txt",
        data=b"copied input",
    )
    workflow_input = UserInput(
        text="run report",
        blocks=[{
            "type": "mention",
            "group": "file",
            "id": attachment.id,
            "label": "request.txt",
        }],
    )
    await SessionTurnRepository().append_result(
        LOCAL_USER_ID,
        session_id=source_session.id,
        expected_tail_id=None,
        user_input=workflow_input,
        ota_records=[{"referenced_mount": attachment.id}],
        agent_state={"referenced_mount": attachment.id},
        browser_tool_loaded=False,
        workspace_tools_loaded=True,
        skills_tool_loaded=False,
        status=TurnStatus.COMPLETED,
        final_answer="started",
        error=None,
        input_tokens=1,
        output_tokens=1,
    )
    workspace = Workspace(
        source_session.id,
        session_root=Path(source_session.workspace_root),
    )
    active = await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": "wf-report",
            "generation": "shared-local-generation",
            "workflow_name": "Report",
            "workflow_input": workflow_input.model_dump(mode="json"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=lambda root: RunWorkflow(root).prepare("create", source_root=source),
    )

    duplicate = await service.duplicate(source_session)
    copied_workspace = Workspace(
        duplicate.id,
        session_root=Path(duplicate.workspace_root),
    )
    copied = await copied_workspace.prepare_run_workflow_space("resume")
    copied_mounts = await SessionMountRepository().list_for_session(
        duplicate.id,
        LOCAL_USER_ID,
    )
    copied_attachment = next(mount for mount in copied_mounts if mount.name == "request.txt")
    copied_turns = await SessionTurnRepository().list_conversation(
        LOCAL_USER_ID,
        duplicate.id,
    )

    assert copied.workflow_id == active.workflow_id
    assert copied.generation == active.generation
    assert copied.workflow_input.blocks[0]["id"] == copied_attachment.id
    assert copied_attachment.id != attachment.id
    assert Path(copied_attachment.abs_path).read_bytes() == b"copied input"
    assert Path(copied_attachment.abs_path) != Path(attachment.abs_path)
    assert copied_turns[0].user_input.blocks[0]["id"] == copied_attachment.id
    assert copied_turns[0].ota_records[0]["referenced_mount"] == copied_attachment.id
    assert copied_turns[0].agent_state == {"referenced_mount": copied_attachment.id}
    assert WorkflowRunLibrary.terminal_result_id(
        source_session.id,
        active.generation,
    ) != WorkflowRunLibrary.terminal_result_id(
        duplicate.id,
        copied.generation,
    )
