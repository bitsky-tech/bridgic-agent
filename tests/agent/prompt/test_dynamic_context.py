import json
from pathlib import Path

from pytest import MonkeyPatch

from src.amphi_agent import (
    AmphiContext,
    AmphiOTAContext,
    BrowserHost,
    MainThink,
    Memory,
    MemoryItem,
    ScheduleLibrary,
    Session,
    SkillLibrary,
    WorkflowLibrary,
    WorkflowRunLibrary,
)
from src.amphi_agent._browser import SessionBrowserState, SessionBrowserTab
from src.amphi_agent._cognitive import (
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    SubAgentThink,
    ValidateThink,
    VerifyThink,
    WorkflowThink,
)
from src.amphi_agent._workspace import Workspace
from src.amphi_store import (
    SessionRecord,
    SessionRepository,
    SessionTurnRecord,
    TurnStatus,
    UserInput,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"
SESSION_ID = "session-context"
PROMPT_TIME = "2026-08-19 12:00 (UTC+08:00)"


def _write_workflow_source(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "task.md").write_text("Task contract", encoding="utf-8")
    (root / "explore.md").write_text("Explore plan", encoding="utf-8")
    (root / "verify.md").write_text("Verify plan", encoding="utf-8")
    workflow = root / "workflow"
    workflow.mkdir(exist_ok=True)
    (workflow / "WORKFLOW.md").write_text(
        """---
name: context-workflow
description: Build a deterministic context report
---
# Produce the report
Write the requested report to result/report.txt.
""",
        encoding="utf-8",
    )
    (workflow / "VALIDATE.md").write_text(
        """# Validate the report
Confirm result/report.txt contains the requested summary.
""",
        encoding="utf-8",
    )
    return root


def _workspace(root: Path) -> Workspace:
    (root / ".work").mkdir(parents=True)
    return Workspace(SESSION_ID, root)


def _session(root: Path) -> Session:
    record = SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root=str(root),
    )
    turn = SessionTurnRecord(
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
    return Session(record, [turn])


def _memory() -> Memory:
    memory = Memory(USER_ID)
    memory.recalled = [MemoryItem("Prefer deterministic context fixtures.")]
    return memory


async def _catalogues(source_root: Path) -> tuple[SkillLibrary, ScheduleLibrary, WorkflowLibrary]:
    skills = await SkillLibrary(USER_ID).load()
    schedules = ScheduleLibrary(USER_ID)
    await schedules.create(
        "Daily context check",
        "Inspect the current prompt context",
        "0 0 9 * * *",
    )
    workflows = WorkflowLibrary(USER_ID)
    await workflows.import_workflow(
        source_root,
        name="Context workflow",
        description="Build a deterministic context report",
        domain="testing",
    )
    return skills, schedules, workflows


def _dynamic_context(system: str) -> str:
    marker = "\n\n<context>\n"
    start = system.rfind(marker)
    assert start >= 0
    context = system[start + 2 :]
    assert context.endswith("\n</context>")
    return context


async def test_main_context(test_sandbox: IsolatedPaths, prompt_store: None) -> None:
    """Final Main dynamic Context:

    {
      "order": [
        "transcript", "skills", "schedules", "workflows", "memories", "Workspace"
      ],
      "browser": "omitted_when_unavailable"
    }

    Checks:
    1. Main renders every available catalogue in stable-to-volatile order.
    2. Each block exposes its current business data instead of an empty placeholder.
    3. An unavailable Browser contributes no dynamic Context block.
    """
    source = _write_workflow_source(test_sandbox.root / "main-source")
    skills, schedules, workflows = await _catalogues(source)
    session_root = test_sandbox.sessions / SESSION_ID
    workspace = _workspace(session_root)
    context = AmphiContext(
        session=_session(session_root),
        memory=_memory(),
        schedules=schedules,
        skills=skills,
        workflows=workflows,
        workspace=workspace,
    )
    ota_context = AmphiOTAContext(user_input="Current request", prompt_time=PROMPT_TIME)

    messages = await MainThink().assemble_messages(ota_context, context)
    dynamic = _dynamic_context(messages[0].content)

    # Check 1: Main renders every available catalogue in stable-to-volatile order.
    positions = [
        dynamic.index(tag)
        for tag in (
            "<transcript>",
            "<skills>",
            "<schedules>",
            "<workflows>",
            "<memories>",
            "<Workspace>",
        )
    ]
    assert positions == sorted(positions)

    # Check 2: Each block exposes its current business data instead of an empty placeholder.
    assert "history.md" in dynamic
    assert "- how-to (location:" in dynamic
    assert "Daily context check" in dynamic
    assert "Context workflow" in dynamic
    assert "Prefer deterministic context fixtures." in dynamic
    assert json.dumps(str(workspace.work_dir), ensure_ascii=False) in dynamic

    # Check 3: An unavailable Browser contributes no dynamic Context block.
    assert "<browser>" not in dynamic


async def test_optional_context(test_sandbox: IsolatedPaths, prompt_store: None, monkeypatch: MonkeyPatch) -> None:
    """Final optional Main Context:

    {
      "workflow_results": "published result identity, status, input, and paths",
      "browser": "active and background tab metadata without page content"
    }

    Checks:
    1. A published Workflow Run appears in the global result catalogue.
    2. Existing Browser tabs expose bounded metadata and identify the active tab.
    """
    session_root = test_sandbox.sessions / SESSION_ID
    await SessionRepository().save(SessionRecord(
        id=SESSION_ID,
        user_id=USER_ID,
        workspace_root=str(session_root),
    ))
    run_id = WorkflowRunRepository().new_id()
    run_root = test_sandbox.runs / "workflow-context" / run_id
    await WorkflowRunRepository().create_or_confirm_terminal(
        USER_ID,
        result_id=run_id,
        workflow_id="workflow-context",
        workflow_name="Published context report",
        source_session_id=SESSION_ID,
        result_dir=str(run_root),
        workflow_input=UserInput(text="Create the published report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.PASSED,
    )
    workflow_runs = await WorkflowRunLibrary(USER_ID).load()

    active_tab = SessionBrowserTab(
        title="Context <report>",
        url="https://example.test/report?mode=prompt",
    )
    background_tab = SessionBrowserTab(
        title="Reference",
        url="https://example.test/reference",
    )
    browser = BrowserHost(prepare_playwright=lambda: None).for_session(SESSION_ID)

    async def browser_state() -> SessionBrowserState:
        return SessionBrowserState(
            tabs=(active_tab, background_tab),
            active_tab=active_tab,
        )

    monkeypatch.setattr(browser, "state", browser_state)
    context = AmphiContext(
        session=_session(session_root),
        workflow_runs=workflow_runs,
        browser=browser,
    )
    messages = await MainThink().assemble_messages(
        AmphiOTAContext(user_input="Inspect optional context", prompt_time=PROMPT_TIME),
        context,
    )
    dynamic = _dynamic_context(messages[0].content)

    # Check 1: A published Workflow Run appears in the global result catalogue.
    assert "<workflow_results>" in dynamic
    assert f"Published context report result (run_id: {run_id}" in dynamic
    assert "status: completed, validation: passed" in dynamic
    result_path = json.dumps(str(run_root / "result"), ensure_ascii=False)
    assert f"result path: {result_path}" in dynamic
    assert 'input: "Create the published report"' in dynamic

    # Check 2: Existing Browser tabs expose bounded metadata and identify the active tab.
    assert "<browser>" in dynamic
    assert r'tab=1 active=true title="Context \u003creport\u003e"' in dynamic
    assert 'url="https://example.test/report?mode=prompt"' in dynamic
    assert 'tab=2 title="Reference" url="https://example.test/reference"' in dynamic


async def test_child_context(test_sandbox: IsolatedPaths, prompt_store: None) -> None:
    """Final Child Agent dynamic Context:

    {
      "included": ["skills", "workflows", "memories", "Workspace"],
      "excluded": ["transcript", "schedules", "active Build details"]
    }

    Checks:
    1. A Child Agent receives shared reusable knowledge and Workspace facts.
    2. Root-only transcript and schedule catalogues are absent.
    3. An active root Build is not exposed as a Child-owned working area.
    """
    source = _write_workflow_source(test_sandbox.root / "child-source")
    skills, schedules, workflows = await _catalogues(source)
    session_root = test_sandbox.sessions / SESSION_ID
    workspace = _workspace(session_root)
    await workspace.prepare_build_space("create", stage="generate")
    assert workspace.build is not None and workspace.build.is_available
    context = AmphiContext(
        session=_session(session_root),
        memory=_memory(),
        schedules=schedules,
        skills=skills,
        workflows=workflows,
        workspace=workspace,
    )
    ota_context = AmphiOTAContext(user_input="Delegated request", prompt_time=PROMPT_TIME)

    messages = await SubAgentThink().assemble_messages(ota_context, context)
    dynamic = _dynamic_context(messages[0].content)

    # Check 1: A Child Agent receives shared reusable knowledge and Workspace facts.
    assert "<skills>" in dynamic
    assert "<workflows>" in dynamic
    assert "<memories>" in dynamic
    assert "<Workspace>" in dynamic
    assert "Context workflow" in dynamic
    assert "Prefer deterministic context fixtures." in dynamic

    # Check 2: Root-only transcript and schedule catalogues are absent.
    assert "<transcript>" not in dynamic
    assert "<schedules>" not in dynamic
    assert "Daily context check" not in dynamic

    # Check 3: An active root Build is not exposed as a Child-owned working area.
    assert "Build work directory (active, writable)" not in dynamic
    assert "Retained Build:" not in dynamic
    assert str(workspace.build.root) not in dynamic


async def test_build_contexts(test_sandbox: IsolatedPaths, prompt_store: None) -> None:
    """Final Build artifact visibility:

    {
      "clarify": ["task.md"],
      "explore": ["task.md"],
      "generate": ["task.md", "explore.md"],
      "verify": ["task.md", "explore.md", "verify.md"]
    }

    Checks:
    1. Every Build stage receives the active Build workspace but no schedule catalogue.
    2. Each stage receives only the artifact bodies required for its responsibility.
    3. Shared Skill, memory, transcript, and Session workspace blocks remain available.
    """
    source = _write_workflow_source(test_sandbox.root / "build-source")
    skills, schedules, workflows = await _catalogues(source)
    session_root = test_sandbox.sessions / SESSION_ID
    workspace = _workspace(session_root)
    build = await workspace.prepare_build_space("create", stage="clarify")
    _write_workflow_source(build.root)
    workflows.open_package(build.root)
    context = AmphiContext(
        session=_session(session_root),
        memory=_memory(),
        schedules=schedules,
        skills=skills,
        workflows=workflows,
        workspace=workspace,
    )

    async def assemble(worker: MainThink, stage: str) -> str:
        ota_context = AmphiOTAContext(
            user_input="Build the workflow",
            prompt_time=PROMPT_TIME,
            state={"think": {"mode": "build", "stage": stage}},
        )
        messages = await worker.assemble_messages(ota_context, context)
        return _dynamic_context(messages[0].content)

    clarify = await assemble(ClarifyThink(), "clarify")
    explore = await assemble(ExploreThink(), "explore")
    generate = await assemble(GenerateThink(), "generate")
    verify = await assemble(VerifyThink(), "verify")
    contexts = [clarify, explore, generate, verify]

    # Check 1: Every Build stage receives the active Build workspace but no schedule catalogue.
    assert all("<build_workspace>" in dynamic for dynamic in contexts)
    assert all(str(build.root) in dynamic for dynamic in contexts)
    assert all("<schedules>" not in dynamic for dynamic in contexts)
    assert all("Daily context check" not in dynamic for dynamic in contexts)

    # Check 2: Each stage receives only the artifact bodies required for its responsibility.
    assert "Task contract" in clarify
    assert "Explore plan" not in clarify
    assert "Verify plan" not in clarify
    assert "Task contract" in explore
    assert "Explore plan" not in explore
    assert "Verify plan" not in explore
    assert "Task contract" in generate
    assert "Explore plan" in generate
    assert "Verify plan" not in generate
    assert "Task contract" in verify
    assert "Explore plan" in verify
    assert "Verify plan" in verify

    # Check 3: Shared Skill, memory, transcript, and Session workspace blocks remain available.
    assert all("<skills>" in dynamic for dynamic in contexts)
    assert all("<memories>" in dynamic for dynamic in contexts)
    assert all("<transcript>" in dynamic for dynamic in contexts)
    assert all("<Workspace>" in dynamic for dynamic in contexts)


async def test_workflow_contexts(test_sandbox: IsolatedPaths, prompt_store: None) -> None:
    """Final Workflow Run Context:

    {
      "execute": {"stage": "execute", "current_section": "Produce the report"},
      "validate": {"stage": "validate", "current_section": "Validate the report"},
      "shared": ["skills", "schedules", "memories", "run directories"]
    }

    Checks:
    1. Execute exposes the immutable current execution section and writable run paths.
    2. Validate replaces the current section with the validation contract.
    3. Both stages retain shared catalogues while omitting the ordinary Workflow list.
    """
    source = _write_workflow_source(test_sandbox.root / "run-source")
    skills, schedules, workflows = await _catalogues(source)
    saved = next(iter(workflows.data().values()))
    assert saved.workflow_id is not None
    session_root = test_sandbox.sessions / SESSION_ID
    workspace = _workspace(session_root)
    workflow_runs = WorkflowRunLibrary(USER_ID)

    def populate(root: Path) -> None:
        workflow_runs.populate_run_workflow(root, source)

    generation = "generation-context"
    run_space = await workspace.prepare_run_workflow_space(
        "create",
        initial_state={
            "workflow_id": saved.workflow_id,
            "generation": generation,
            "workflow_name": saved.name or "Context workflow",
            "workflow_input": UserInput(text="Create the context report"),
            "stage": "execute",
            "step_index": 0,
        },
        populate=populate,
    )
    run = workflow_runs.open_run_workflow(run_space.root)
    workflows.open_package(
        run.source_dir,
        workflow_id=saved.workflow_id,
        name=saved.name,
        validate=True,
    )
    context = AmphiContext(
        session=_session(session_root),
        memory=_memory(),
        schedules=schedules,
        skills=skills,
        workflows=workflows,
        workflow_runs=workflow_runs,
        workspace=workspace,
    )
    execute_ota = AmphiOTAContext(
        user_input="Create the context report",
        prompt_time=PROMPT_TIME,
        state={
            "think": {
                "mode": "run_workflow",
                "stage": "execute",
                "workflow_id": saved.workflow_id,
                "generation": generation,
                "step_index": 0,
            }
        },
    )

    execute_messages = await WorkflowThink().assemble_messages(execute_ota, context)
    execute = _dynamic_context(execute_messages[0].content)

    # Check 1: Execute exposes the immutable current execution section and writable run paths.
    assert "<workflow_run>" in execute
    assert "Stage: execute" in execute
    assert "Current section: 1. Produce the report" in execute
    assert "Write the requested report to result/report.txt." in execute
    assert f"Writable final result directory: {run.result_dir}" in execute
    assert f"Writable background work directory: {run.background_work_dir}" in execute

    run_space.checkpoint_cursor(
        expected_workflow_id=saved.workflow_id,
        expected_generation=generation,
        expected_stage="execute",
        expected_step_index=0,
        stage="validate",
        step_index=0,
    )
    validate_ota = AmphiOTAContext(
        user_input="Create the context report",
        prompt_time=PROMPT_TIME,
        state={
            "think": {
                "mode": "run_workflow",
                "stage": "validate",
                "workflow_id": saved.workflow_id,
                "generation": generation,
                "step_index": 0,
            }
        },
    )
    validate_messages = await ValidateThink().assemble_messages(validate_ota, context)
    validate = _dynamic_context(validate_messages[0].content)

    # Check 2: Validate replaces the current section with the validation contract.
    assert "Stage: validate" in validate
    assert "Current section: 1. Validate the report" in validate
    assert "Confirm result/report.txt contains the requested summary." in validate
    assert "- [x] 1. Produce the report" in validate

    # Check 3: Both stages retain shared catalogues while omitting the ordinary Workflow list.
    for dynamic in (execute, validate):
        assert "<skills>" in dynamic
        assert "<schedules>" in dynamic
        assert "Daily context check" in dynamic
        assert "<memories>" in dynamic
        assert "<workflows>" not in dynamic
