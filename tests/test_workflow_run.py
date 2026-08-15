import json
from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord
from bridgic.amphibious._type import ThinkResult

from src.amphi_agent._agent import AmphiAgent
from src.amphi_agent._cognitive import MainThink, ValidateThink, WorkflowThink
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent._state import (
    AwaitingWorkflowRunChoice,
    NormalStageState,
    WorkflowStageState,
)
from src.amphi_agent._workflow_run import WorkflowRunLibrary
from src.amphi_agent._workflows import WorkflowLibrary, WorkflowPackage
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.tools._request_human import RequestRunWorkflow
from src.amphi_agent.tools._workflow import WorkflowStepReport
from src.amphi_service.protocol import WsChatMessage
from src.amphi_service.protocol.llms._streaming import StreamResult
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    UserInput,
    WorkflowRepository,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)

from ._session_turns import make_session_turns


class _Stream:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish(self, event: str, **payload: object) -> None:
        self.events.append((event, payload))


def _source(
    tmp_path: Path,
    workflow_id: str = "wf-report",
    name: str = "生成报告",
    *,
    validation: bool = True,
) -> WorkflowPackage:
    root = tmp_path / workflow_id
    package_root = root / "workflow"
    package_root.mkdir(parents=True, exist_ok=True)
    (package_root / "WORKFLOW.md").write_text(
        "---\nname: workflow-run-fixture\ndescription: Workflow Run fixture.\n---\n\n"
        "# 收集数据\n\n读取输入数据。\n\n"
        "# 生成报告\n\n将结果写入报告。\n",
        encoding="utf-8",
    )
    validation = (
        "# 检查报告\n\n确认报告内容完整。"
        if validation
        else "---\nvalidation: none\n---"
    )
    (package_root / "VALIDATE.md").write_text(f"{validation}\n", encoding="utf-8")
    for document in ("task.md", "explore.md", "verify.md"):
        (root / document).write_text(
            f"# {document.removesuffix('.md')}\n\nFixture.\n",
            encoding="utf-8",
        )
    package = WorkflowPackage(root, workflow_id=workflow_id, name=name)
    return package


def _library(*sources: WorkflowPackage) -> WorkflowLibrary:
    class FixtureWorkflowLibrary(WorkflowLibrary):
        async def _validated_saved_workflow(self, workflow_id: str) -> WorkflowPackage:
            return self.source(workflow_id)

    library = FixtureWorkflowLibrary("user")
    library._packages = {
        source.workflow_id: source
        for source in sources
        if source.workflow_id is not None
    }
    return library


def _context(tmp_path: Path, *sources: WorkflowPackage) -> AmphiContext:
    session_root = tmp_path / "session-root"
    workflows = _library(*sources)
    record = SessionRecord(
        id="session",
        user_id="user",
        workspace_root=str(session_root),
    )
    return AmphiContext(
        session=Session(record),
        workflows=workflows,
        workflow_runs=WorkflowRunLibrary("user"),
        workspace=Workspace("session", session_root=session_root),
    )


def _projected_state(context: AmphiContext) -> WorkflowStageState:
    state = context.workspace.run_workflow
    assert state is not None
    return WorkflowStageState(
        workflow_id=state.workflow_id,
        generation=state.generation,
        stage=state.stage,
        step_index=state.step_index,
    )


def _persist_workflow_turn(
    context: AmphiContext,
    ota: AmphiOTAContext,
    *,
    error: str | None = None,
) -> None:
    """Replace the in-memory conversation with one persisted Workflow Turn."""
    dump = {
        "state": ota.state.model_dump(mode="json"),
        "ota_record": [],
    }
    if error is not None:
        dump["turn_error"] = error
    record = SessionRecord(
        id="session",
        user_id="user",
        workspace_root=str(context.workspace.session_root),
    )
    context.session = Session(
        record,
        turns=make_session_turns(
            [(UserInput(text="运行 Workflow"), dump)],
            user_id="user",
            session_id="session",
        ),
    )


def _slash(workflow_id: str = "wf-report", label: str = "生成报告") -> WsChatMessage:
    return WsChatMessage(
        session_id="session",
        input=f"/{label} 本周数据",
        blocks=[
            {
                "type": "slash",
                "id": workflow_id,
                "label": label,
                "resource": "workflow",
            },
            {"type": "text", "value": " 本周数据"},
        ],
    )


@pytest.mark.parametrize("stage", ["execute", "validate"])
async def test_workflow_think_overrides_the_configured_permission_mode(
    tmp_path: Path,
    monkeypatch,
    stage: str,
) -> None:
    context = _context(tmp_path)
    context.execution_mode = "request"
    ota = AmphiOTAContext(user_input="run", stream=_Stream())
    ota.transition_think(WorkflowStageState(
        workflow_id="wf-permission",
        generation="generation-permission",
        stage=stage,
        step_index=0,
    ))
    ota.open_record()
    ota.think_result = ThinkResult(step_content="", tool_calls=[])
    agent = AmphiAgent()
    seen_modes: list[str | None] = []

    async def permission_check(_ota, _context, *, execution_mode=None):
        seen_modes.append(execution_mode)
        return []

    monkeypatch.setattr(agent, "permission_check", permission_check)
    gate = agent.before_action(ota, context)
    admitted = (await gate.asend(None)).value
    await gate.aclose()

    assert admitted.tool_calls == []
    assert seen_modes == ["full"]
    assert ota.ota_record[-1].permission.execution_mode == "full"


def test_workflow_run_library_owns_the_active_run_binding(tmp_path: Path) -> None:
    source = _source(tmp_path, workflow_id="source").root
    (source / "ignored-root-entry.txt").write_text("not package source\n", encoding="utf-8")
    (source / "ignored-root-directory").mkdir()
    (source / "ignored-root-directory" / "nested.txt").write_text(
        "not package source\n",
        encoding="utf-8",
    )
    run_root = tmp_path / "run"
    run_root.mkdir()
    library = WorkflowRunLibrary("user")

    library.populate_run_workflow(run_root, source)
    assert library.run_workflow is None
    assert not (run_root / "source" / "ignored-root-entry.txt").exists()
    assert not (run_root / "source" / "ignored-root-directory").exists()
    assert {
        path.name for path in (run_root / "source").iterdir()
    } == set(WorkflowPackage.ROOT_ENTRY_NAMES)

    run = library.open_run_workflow(run_root)
    assert library.run_workflow is run
    assert library.require_run_workflow(run_root) is run
    library.close_run_workflow()
    assert library.run_workflow is None


async def _after_action(
    agent: AmphiAgent,
    ota: AmphiOTAContext,
    context: AmphiContext,
    tool_name: str,
    result: object,
) -> ActionStepResult:
    step = ActionStepResult(
        tool_id=f"call-{len(ota.ota_record)}",
        tool_name=tool_name,
        tool_arguments={},
        tool_result=result,
        success=True,
    )
    action = ActionResult(results=[step])
    ota.action_result = action
    ota.ota_record.append(OTARecord(action_result=action))
    async for _ in agent.after_action(ota, context):
        pass
    return step


async def _start_run(
    agent: AmphiAgent,
    ota: AmphiOTAContext,
    context: AmphiContext,
    workflow_id: str = "wf-report",
) -> ActionStepResult:
    return await _after_action(
        agent,
        ota,
        context,
        "request_run_workflow",
        RequestRunWorkflow(workflow_id, "start"),
    )


@pytest.fixture(autouse=True)
def _workflow_run_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRIDGIC_AGENT_RUNS_ROOT", str(tmp_path / "runs"))


async def test_workflow_slash_stays_in_main_without_creating_a_run(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    message = _slash()
    ota = AmphiOTAContext(user_input=message, stream=_Stream())

    await AmphiAgent().init_state(ota, context)

    assert ota.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    assert context.workspace.run_workflow is None
    assert context.workflow_runs.run_workflow is None
    assert context.workflows.package is None
    assert UserInput.from_runtime(ota.user_input) == UserInput.from_runtime(message)
    assert await WorkflowRunRepository().list_for_user("user") == []


async def test_request_run_workflow_is_the_only_entry_path(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    await SessionRepository().save(SessionRecord(
        id="session",
        user_id="user",
        workspace_root=str(context.session.workspace_root),
    ))
    await WorkflowRepository().create(
        "user",
        workflow_id="wf-report",
        name="生成报告",
        description=None,
        domain=None,
        workflow_dir=str(source.root),
    )
    message = _slash()
    ota = AmphiOTAContext(user_input=message, stream=_Stream())

    step = await _start_run(AmphiAgent(), ota, context)

    assert ota.think_status == _projected_state(context)
    assert step.tool_result["status"] == "started"
    state = await context.workspace.prepare_run_workflow_space("resume")
    assert state.workflow_id == "wf-report"
    assert json.loads((state.root / ".state.json").read_text(encoding="utf-8")) == {
        "workflow_id": "wf-report",
        "generation": state.generation,
        "workflow_name": "生成报告",
        "workflow_input": UserInput.from_runtime(message).model_dump(mode="json"),
        "stage": "execute",
        "step_index": 0,
    }
    associated = await WorkflowRepository().list_for_session("user", "session")
    assert [workflow.id for workflow in associated] == ["wf-report"]
    assert await WorkflowRunRepository().list_for_user("user") == []


async def test_first_workflow_prompt_restores_the_structured_input(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    message = _slash()
    ota = AmphiOTAContext(user_input=message, stream=_Stream())
    await _start_run(AmphiAgent(), ota, context)

    messages = await WorkflowThink().assemble_messages(ota, context)

    assert context.workspace.run_workflow is not None
    assert context.workspace.run_workflow.workflow_input == UserInput.from_runtime(message)
    assert "<workflow_run>" in messages[0].content
    assert "Workflow id: `wf-report`" in messages[0].content
    assert "Workflow name: `生成报告`" in messages[0].content
    assert "Stage: execute" in messages[0].content
    assert "Step: 1 of 2" in messages[0].content
    assert "Current section: 1. 收集数据" in messages[0].content
    assert "Original Workflow input:" in messages[0].content
    assert "本周数据" in messages[0].content


async def test_request_run_workflow_requires_explicit_retained_run_actions(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    agent = AmphiAgent()

    with pytest.raises(ValueError, match="no unfinished Workflow Run"):
        await _after_action(
            agent,
            AmphiOTAContext(user_input="restart", stream=_Stream()),
            context,
            "request_run_workflow",
            RequestRunWorkflow("wf-report", "restart"),
        )

    await _start_run(
        agent,
        AmphiOTAContext(user_input="start", stream=_Stream()),
        context,
    )
    with pytest.raises(ValueError, match="already owns an unfinished Workflow Run"):
        await _after_action(
            agent,
            AmphiOTAContext(user_input="start again", stream=_Stream()),
            context,
            "request_run_workflow",
            RequestRunWorkflow("wf-report", "start"),
        )


async def test_reports_automatically_advance_and_complete_stage_boundaries(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    stream = _Stream()
    ota = AmphiOTAContext(user_input=_slash(), stream=stream)
    agent = AmphiAgent()
    await _start_run(agent, ota, context)
    active_run = context.workflow_runs.run_workflow
    active_package = context.workflows.package
    assert active_run is not None
    (active_run.result_dir / "report.md").write_text("# 报告\n", encoding="utf-8")
    (active_run.background_work_dir / "message_idempotency_key.txt").write_text(
        "retry-key\n",
        encoding="utf-8",
    )

    await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("success", "数据已收集", ["background/data.json"]),
    )
    assert ota.think_status == _projected_state(context)
    assert context.workflow_runs.run_workflow is active_run
    assert context.workflows.package is active_package
    execute_second = await WorkflowThink().assemble_messages(ota, context)
    assert "Stage: execute" in execute_second[0].content
    assert "Step: 2 of 2" in execute_second[0].content
    assert "Current section: 2. 生成报告" in execute_second[0].content

    await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("success", "报告已生成", ["result/report.md"]),
    )
    assert ota.think_status == _projected_state(context)
    assert isinstance(ota.think_status, WorkflowStageState)
    assert ota.think_status.stage == "validate"
    assert ota.think_status.step_index == 0
    validate_first = await ValidateThink().assemble_messages(ota, context)
    assert "Stage: validate" in validate_first[0].content
    assert "Step: 1 of 1" in validate_first[0].content
    assert "Current section: 1. 检查报告" in validate_first[0].content

    completed = await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("success", "验证通过", ["result/report.md"]),
    )

    assert ota.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    assert context.workspace.run_workflow is None
    assert context.workflow_runs.run_workflow is None
    assert context.workflows.package is None
    assert completed.tool_result["status"] == "success"
    assert completed.tool_result["run_status"] == WorkflowRunStatus.COMPLETED.value
    assert completed.tool_result["created_at"]
    terminal_events = [payload for event, payload in stream.events if event == "workflow_result"]
    durable_terminal = ota._current_record().model_dump()["workflow_result"]
    assert durable_terminal == {
        "run_id": completed.tool_result["run_id"],
        "workflow_id": "wf-report",
        "workflow_name": "生成报告",
        "status": WorkflowRunStatus.COMPLETED.value,
        "validation_status": WorkflowValidationStatus.PASSED.value,
        "created_at": completed.tool_result["created_at"],
        "result_file_count": 1,
        "summary": "Workflow `生成报告` completed all execution and validation sections successfully.",
    }
    assert terminal_events == [durable_terminal]
    rows = await WorkflowRunRepository().list_for_user("user")
    assert [row.id for row in rows] == [completed.tool_result["run_id"]]
    assert rows[0].status is WorkflowRunStatus.COMPLETED
    assert rows[0].validation_status is WorkflowValidationStatus.PASSED
    published = context.workflow_runs.get(completed.tool_result["run_id"])
    assert published is not None
    assert completed.tool_result["published_result_dir"] == str(published.result_dir)
    assert published.result_files == ("result/report.md",)
    assert published.work_files == ("background/work/message_idempotency_key.txt",)
    assert not active_run.root.exists()
    handoff = ota._current_record().observation_result or ""
    assert (
        "The artifacts under .run/result and .run/background/work were published under:"
        in handoff
    )
    assert str(published.root) in handoff
    assert "Paths relative to .run are unchanged." in handoff
    assert "The original temporary .run workspace was deleted." in handoff
    assert "The published location above is internal handoff context." in handoff
    assert (
        "The UI already presented the published artifacts in a dedicated card."
        in handoff
    )
    assert "briefly summarize the outcome without repeating or linking" in handoff
    assert "artifact paths, file URIs, or artifact Markdown links" in handoff
    assert "use absolute paths under the published directory" not in handoff

    main_messages = await MainThink().assemble_messages(ota, context)
    main_payload = json.dumps(
        [message.model_dump(mode="json") for message in main_messages],
        ensure_ascii=False,
    )
    assert (
        "The artifacts under .run/result and .run/background/work were published under:"
        in main_payload
    )
    assert str(published.root) in main_payload
    assert "Paths relative to .run are unchanged." in main_payload
    assert "The original temporary .run workspace was deleted." in main_payload
    assert "The published location above is internal handoff context." in main_payload
    assert (
        "The UI already presented the published artifacts in a dedicated card."
        in main_payload
    )
    assert "briefly summarize the outcome without repeating or linking" in main_payload
    assert "artifact paths, file URIs, or artifact Markdown links" in main_payload
    assert "use absolute paths under the published directory" not in main_payload


async def test_terminal_run_tells_main_not_to_repeat_published_artifact_links(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    """The real Agent loop tells Main to leave artifact access to the result card."""
    source = _source(tmp_path, validation=False)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    temporary_run_root = context.workspace.run_workflow_root
    temporary_report = temporary_run_root / "result" / "report.md"

    class CompletionLlm:
        def __init__(self) -> None:
            self.responses = [
                StreamResult(tool_calls=[{
                    "name": "request_run_workflow",
                    "arguments": {
                        "workflow_id": "wf-report",
                        "action": "start",
                        "reason": "Run the selected Workflow.",
                    },
                }], content=""),
                StreamResult(tool_calls=[{
                    "name": "write_file",
                    "arguments": {
                        "file_path": str(temporary_report),
                        "content": "# Report\n",
                    },
                }], content=""),
                StreamResult(tool_calls=[{
                    "name": "report_workflow_step",
                    "arguments": {
                        "status": "success",
                        "summary": "Data collected.",
                        "evidence": [],
                    },
                }], content=""),
                StreamResult(tool_calls=[{
                    "name": "report_workflow_step",
                    "arguments": {
                        "status": "success",
                        "summary": "Report generated.",
                        "evidence": [str(temporary_report)],
                    },
                }], content=""),
            ]
            self.main_payload = ""
            self.published = None
            self.temporary_root_existed_for_main = True

        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            if self.responses:
                return self.responses.pop(0)
            self.main_payload = json.dumps(
                [message.model_dump(mode="json") for message in messages],
                ensure_ascii=False,
            )
            self.published = context.workflow_runs.runs()[0]
            self.temporary_root_existed_for_main = temporary_run_root.exists()
            return StreamResult(
                tool_calls=[],
                content="报告已生成，结果可在上方卡片中查看。",
            )

    llm = CompletionLlm()

    answer = await AmphiAgent(max_rounds=20).arun(
        llm=llm,
        context=context,
        ota_context=ota,
    )

    assert llm.responses == []
    assert llm.published is not None
    published_file = llm.published.result_dir / "report.md"
    assert published_file.is_file()
    assert llm.published.files == ("result/report.md",)
    assert llm.temporary_root_existed_for_main is False
    assert not temporary_run_root.exists()
    assert (
        "The artifacts under .run/result and .run/background/work were published under:"
        in llm.main_payload
    )
    assert str(llm.published.root) in llm.main_payload
    assert "Paths relative to .run are unchanged." in llm.main_payload
    assert "The original temporary .run workspace was deleted." in llm.main_payload
    assert "The published location above is internal handoff context." in llm.main_payload
    assert (
        "The UI already presented the published artifacts in a dedicated card."
        in llm.main_payload
    )
    assert "briefly summarize the outcome without repeating or linking" in llm.main_payload
    assert "artifact paths, file URIs, or artifact Markdown links" in llm.main_payload
    assert "use absolute paths under the published directory" not in llm.main_payload
    assert str(temporary_run_root) in llm.main_payload
    assert answer == "报告已生成，结果可在上方卡片中查看。"
    assert published_file.as_uri() not in answer
    assert str(llm.published.result_dir) not in answer
    assert str(temporary_run_root) not in answer


async def test_execution_only_run_completes_without_validate_stage(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path, validation=False)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    agent = AmphiAgent()
    await _start_run(agent, ota, context)

    completed = None
    for summary in ("数据已收集", "报告已生成"):
        completed = await _after_action(
            agent,
            ota,
            context,
            "report_workflow_step",
            WorkflowStepReport("success", summary, []),
        )

    assert ota.think_status == NormalStageState()
    assert completed is not None
    assert completed.tool_result["status"] == "success"
    assert completed.tool_result["run_status"] == WorkflowRunStatus.COMPLETED.value
    assert completed.tool_result["validation_status"] == WorkflowValidationStatus.NOT_REQUIRED.value
    assert ota._current_record().model_dump()["workflow_result"]["result_file_count"] == 0


async def test_automatic_completion_retries_from_the_durable_boundary(
    tmp_path: Path,
    connected_repo: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(tmp_path, validation=False)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    agent = AmphiAgent()
    await _start_run(agent, ota, context)
    await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("success", "数据已收集", []),
    )
    original_publish = context.workflow_runs.publish
    attempts = 0

    async def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("database unavailable")
        return await original_publish(*args, **kwargs)

    monkeypatch.setattr(context.workflow_runs, "publish", fail_once)
    with pytest.raises(RuntimeError, match="database unavailable"):
        await _after_action(
            agent,
            ota,
            context,
            "report_workflow_step",
            WorkflowStepReport("success", "报告已生成", []),
        )

    checkpoint = context.workspace.run_workflow_checkpoint()
    assert checkpoint is not None
    assert checkpoint.stage == "execute"
    assert checkpoint.step_index == 2
    assert isinstance(ota.think_status, WorkflowStageState)
    result_id = context.workflow_runs.terminal_result_id("session", checkpoint.generation)
    _persist_workflow_turn(context, ota, error="database unavailable")
    resumed_stream = _Stream()
    resumed = AmphiOTAContext(user_input=UserInput(text="继续"), stream=resumed_stream)

    await agent.init_state(resumed, context)

    assert attempts == 2
    assert resumed.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    terminal = resumed._current_record().model_dump()["workflow_result"]
    assert terminal["run_id"] == result_id
    assert terminal["status"] == WorkflowRunStatus.COMPLETED.value
    assert [event for event, _payload in resumed_stream.events].count("workflow_result") == 1
    rows = await WorkflowRunRepository().list_for_user("user")
    assert [row.id for row in rows] == [result_id]


async def test_failed_report_saves_terminal_result_and_removes_active_run(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    agent = AmphiAgent()
    await _start_run(agent, ota, context)

    failed = await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("failure", "上游数据不可用", ["background/error.log"]),
    )

    assert ota.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    assert context.workflow_runs.run_workflow is None
    assert context.workflows.package is None
    assert failed.tool_result["status"] == "failure"
    assert failed.tool_result["run_status"] == WorkflowRunStatus.FAILED.value
    assert failed.tool_result["validation_status"] == WorkflowValidationStatus.FAILED.value
    assert failed.tool_result["created_at"]
    terminal_events = [
        payload
        for event, payload in ota.stream.events
        if event == "workflow_result"
    ]
    assert [payload["status"] for payload in terminal_events] == [
        WorkflowRunStatus.FAILED.value
    ]
    handoff = ota._current_record().observation_result or ""
    assert (
        "The UI already presented the published artifacts in a dedicated card."
        in handoff
    )
    assert "artifact paths, file URIs, or artifact Markdown links" in handoff
    rows = await WorkflowRunRepository().list_for_user("user")
    assert len(rows) == 1
    assert rows[0].status is WorkflowRunStatus.FAILED


async def test_failed_report_retries_the_same_terminal_result_after_database_error(
    tmp_path: Path,
    connected_repo: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    agent = AmphiAgent()
    await _start_run(agent, ota, context)
    original_publish = context.workflow_runs.publish
    attempts = 0

    async def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("database unavailable")
        return await original_publish(*args, **kwargs)

    monkeypatch.setattr(context.workflow_runs, "publish", fail_once)
    report = WorkflowStepReport(
        "failure",
        "上游数据不可用",
        ["background/error.log"],
    )
    first = await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        report,
    )

    state = await context.workspace.prepare_run_workflow_space("resume")
    assert first.success is False
    assert first.tool_result["status"] == "save_failed"
    assert isinstance(ota.think_status, WorkflowStageState)
    result_id = context.workflow_runs.terminal_result_id("session", state.generation)

    second = await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport(
            "failure",
            "再次确认上游接口仍不可用",
            ["background/retry-error.log"],
        ),
    )

    assert second.success is True
    assert second.tool_result["run_id"] == result_id
    assert second.tool_result["summary"] == report.summary
    assert ota.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    rows = await WorkflowRunRepository().list_for_user("user")
    assert [row.id for row in rows] == [result_id]


async def test_resume_uses_checkpoint_and_restart_replaces_the_snapshot(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    first = _source(tmp_path)
    second = _source(tmp_path, "wf-other", "其他流程", validation=False)
    context = _context(tmp_path, first, second)
    agent = AmphiAgent()
    start = AmphiOTAContext(user_input=UserInput(text="原始输入"), stream=_Stream())
    await _after_action(
        agent,
        start,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "start"),
    )
    original_input = (await context.workspace.prepare_run_workflow_space("resume")).workflow_input

    context.workspace.close_run_workflow_space()
    resume = AmphiOTAContext(user_input=UserInput(text="继续"), stream=_Stream())
    await _after_action(
        agent,
        resume,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "resume"),
    )
    assert resume.think_status == _projected_state(context)

    same_restart = AmphiOTAContext(user_input=UserInput(text="重新执行"), stream=_Stream())
    await _after_action(
        agent,
        same_restart,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "restart"),
    )
    assert (
        await context.workspace.prepare_run_workflow_space("resume")
    ).workflow_input == original_input

    other_restart = AmphiOTAContext(user_input=UserInput(text="运行其他流程"), stream=_Stream())
    await _after_action(
        agent,
        other_restart,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-other", "restart"),
    )
    assert other_restart.think_status == _projected_state(context)
    assert (
        (await context.workspace.prepare_run_workflow_space("resume")).workflow_input
        == UserInput(text="运行其他流程")
    )
    assert (await context.workspace.prepare_run_workflow_space("resume")).workflow_id == "wf-other"
    assert context.workflow_runs.run_workflow is not None
    assert context.workflow_runs.run_workflow.root == context.workspace.run_workflow.root
    assert context.workflows.package is not None
    assert context.workflows.package.workflow_id == "wf-other"


async def test_execute_can_ask_how_to_resolve_a_competing_workflow_run(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    first = _source(tmp_path)
    second = _source(tmp_path, "wf-other", "其他流程", validation=False)
    context = _context(tmp_path, first, second)
    agent = AmphiAgent()
    ota = AmphiOTAContext(user_input=UserInput(text="先运行报告"), stream=_Stream())
    await _after_action(
        agent,
        ota,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "start"),
    )
    active_state = ota.think_status

    step = await _after_action(
        agent,
        ota,
        context,
        "request_run_workflow",
        RequestRunWorkflow(
            "wf-other",
            "ask",
            "用户提出了另一个 Workflow，但没有说明是否替换当前 Run。",
        ),
    )

    assert ota.think_status == active_state
    assert isinstance(ota.interaction_status, AwaitingWorkflowRunChoice)
    assert ota.interaction_status.existing_workflow_id == "wf-report"
    assert ota.interaction_status.requested_workflow_id == "wf-other"
    assert step.tool_result["status"] == "pending"


async def test_switch_to_main_retains_run_files_but_clears_domain_bindings(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    ota = AmphiOTAContext(user_input=UserInput(text="先暂停运行"), stream=_Stream())
    agent = AmphiAgent()
    await _after_action(
        agent,
        ota,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "start"),
    )

    await _after_action(
        agent,
        ota,
        context,
        "switch",
        {"mode": "normal", "stage": None, "reason": "先处理用户的新问题"},
    )

    assert ota.think_status == NormalStageState()
    assert context.workspace.has_run_workflow
    assert context.workspace.run_workflow is None
    assert context.workflow_runs.run_workflow is None
    assert context.workflows.package is None


async def test_child_session_cannot_claim_the_shared_workspace_run(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path)
    context = _context(tmp_path, source)
    agent = AmphiAgent()
    start = AmphiOTAContext(user_input=UserInput(text="运行"), stream=_Stream())
    await _after_action(
        agent,
        start,
        context,
        "request_run_workflow",
        RequestRunWorkflow("wf-report", "start"),
    )
    context.session = Session(SessionRecord(
        id="sibling",
        user_id="user",
        parent_session_id="root",
        workspace_root=str(context.workspace.session_root),
    ))
    sibling = AmphiOTAContext(user_input=UserInput(text="继续"), stream=_Stream())

    with pytest.raises(RuntimeError, match="Child Sessions cannot control"):
        await _after_action(
            agent,
            sibling,
            context,
            "request_run_workflow",
            RequestRunWorkflow("wf-report", "resume"),
        )


def test_workflow_mode_registers_distinct_execute_and_validate_thinks() -> None:
    agent = AmphiAgent()

    assert agent.thinking_modes["run_workflow"] == ("execute", "validate")
    assert isinstance(agent.execute._worker_template, WorkflowThink)
    assert isinstance(agent.validate._worker_template, ValidateThink)


async def test_persisted_execution_boundary_is_settled_without_a_model_action(
    tmp_path: Path,
    connected_repo: None,
) -> None:
    source = _source(tmp_path, validation=False)
    context = _context(tmp_path, source)
    agent = AmphiAgent()
    ota = AmphiOTAContext(user_input=_slash(), stream=_Stream())
    await _start_run(agent, ota, context)
    await _after_action(
        agent,
        ota,
        context,
        "report_workflow_step",
        WorkflowStepReport("success", "数据已收集", []),
    )
    state = context.workspace.run_workflow
    source = context.workflows.require_package()
    assert state is not None
    final_step = source.execution_steps[1]
    context.workflow_runs.record_step(
        stage="execute",
        step_number=final_step.index,
        step_title=final_step.title,
        status="success",
        summary="报告已生成",
    )
    state.checkpoint_cursor(
        expected_workflow_id=state.workflow_id,
        expected_generation=state.generation,
        expected_stage="execute",
        expected_step_index=1,
        stage="execute",
        step_index=2,
    )
    ota.transition_think(_projected_state(context))
    result_id = context.workflow_runs.terminal_result_id("session", state.generation)
    _persist_workflow_turn(context, ota)
    resumed = AmphiOTAContext(user_input=UserInput(text="继续"), stream=_Stream())

    await agent.init_state(resumed, context)

    assert resumed.think_status == NormalStageState()
    assert not context.workspace.has_run_workflow
    rows = await WorkflowRunRepository().list_for_user("user")
    assert [row.id for row in rows] == [result_id]
