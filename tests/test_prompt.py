import re

import pytest

from src.amphi_agent import _cognitive, _prompt
from src.amphi_agent._cognitive import (
    CHILD_TOOL_NAMES,
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    MainThink,
    SubAgentThink,
    ValidateThink,
    VerifyThink,
    WorkflowThink,
)
from src.amphi_agent._context import AmphiContext, AmphiOTAContext
from src.amphi_agent._session import Session
from src.amphi_agent.tools import (
    BROWSER_ADVANCED_TOOL_NAMES,
    BROWSER_TOOL_NAMES,
    SKILLS_ADVANCED_TOOL_NAMES,
    WORKSPACE_ADVANCED_TOOL_NAMES,
)
from src.amphi_agent.tools._switch import switch
from src.amphi_store import SessionRecord, SubAgentMode


def _main_prompt_tool_names(system: str) -> list[str]:
    match = re.search(
        r"The tools currently available in this cognitive loop are: (.*?)\. Call them directly\.",
        system,
    )
    assert match is not None
    return re.findall(r"`([^`]+)`", match.group(1))


def _stage_prompt_tool_names(system: str) -> list[str]:
    match = re.search(
        r"The tools currently available in [^:]+ are: (.*?)\. Call them directly\.",
        system,
    )
    assert match is not None
    return re.findall(r"`([^`]+)`", match.group(1))


def _child_context() -> AmphiContext:
    record = SessionRecord(
        id="child",
        user_id="user",
        workspace_root="/tmp/session",
        parent_session_id="parent",
        subagent_mode=SubAgentMode.BLOCKING,
    )
    return AmphiContext(session=Session(record))


def test_time_in_local_tz_returns_concise_time_with_local_timezone() -> None:
    value = _prompt.time_in_local_tz()

    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)",
        value,
    )


def test_personas_do_not_contain_volatile_time() -> None:
    personas = (
        _prompt.PERSONA,
        _prompt.CLARIFY_PERSONA,
        _prompt.EXPLORE_PERSONA,
        _prompt.GENERATE_PERSONA,
        _prompt.VERIFY_PERSONA,
        _prompt.WORKFLOW_PERSONA,
        _prompt.WORKFLOW_VALIDATE_PERSONA,
    )

    assert all("Current local time:" not in persona for persona in personas)
    assert all("{{CURRENT_TIME" not in persona for persona in personas)


def test_workflow_persona_owns_its_runtime_contract() -> None:
    system = _prompt.WORKFLOW_PERSONA

    assert re.search(r"[\u4e00-\u9fff]", system) is None
    assert "# System (Workflow Run)" in system
    assert "# Current stage: Execute" in system
    assert "# Executing the Execute stage" in system
    assert "Workflow source is immutable during a Run" in system
    assert "one section at a time" in system
    assert "the sole authority for what to do in this round" in system
    assert "still cannot advance after **three** retry attempts" in system
    assert "atomically advances the persisted step cursor" in system
    assert "the system records the structured section report in `background/execution.md`" in system
    assert "`result/execution.md`" not in system
    assert "call `request_run_workflow` with action `ask`" in system
    assert "The tool parks the current round" in system

    validation = _prompt.WORKFLOW_VALIDATE_PERSONA
    assert re.search(r"[\u4e00-\u9fff]", validation) is None
    assert "# System (Workflow Run)" in validation
    assert "# Current stage: Validate" in validation
    assert "# Executing the Validate stage" in validation
    assert "Workflow source is immutable during a Run" in validation
    assert "one section at a time, from the saved `VALIDATE.md`" in validation
    assert "the sole authority for what to do in this round" in validation
    assert "still cannot advance after **three** retry attempts" in validation
    assert "atomically advances the persisted step cursor" in validation
    assert "the system records the structured section report in `background/validation.md`" in validation
    assert "runtime automatically publishes the completed Run" in validation
    assert "call `request_run_workflow` with action `ask`" in validation
    assert "# Validate stage contract" not in validation
    assert "up to three distinct repairs" not in validation


def test_visible_subagent_tools_are_declared_with_main_selection_guidance() -> None:
    tools = {"run_subagent", "start_subagent"}
    personas = (
        _prompt.render_main_persona(tools),
        _prompt.render_stage_persona(tools, template=_prompt.WORKFLOW_PERSONA),
        _prompt.render_stage_persona(tools, template=_prompt.WORKFLOW_VALIDATE_PERSONA),
    )

    for persona in personas:
        assert "does not require an explicit user request" in persona
        assert "materially improve correctness, coverage, independent review" in persona
        assert "parent Agent remains responsible for integrating and verifying Child results" in persona
        assert "`run_subagent`" in persona
        assert "`start_subagent`" in persona
        assert "`amphi agent run <prompt>`" in persona
        assert "call `amphi agent run <prompt>` from that script" in persona
        assert "script running through this root Session's `bash`" in persona
        assert "start a real Child Agent under the current Bash call" in persona
        assert "writes its final answer to stdout" in persona
        assert "Pass a dynamically constructed prompt as one subprocess argument" in persona
        assert "prefer an argument list over shell interpolation" in persona
        assert "prefer issuing all corresponding `run_subagent` calls together" in persona
        assert "they do not write overlapping Workspace state" in persona
        assert "A batch round must contain only `run_subagent` calls" in persona
        assert "Independence determines concurrency, not whether a useful subtask may be delegated" in persona
        assert "Keep dependent subtasks sequential" in persona
        assert "executing a script that calls `amphi agent run`" in persona
        assert "counting both concurrent and sequential launches" in persona
        assert "Delegations of 1 to 5 Child Agents do not require confirmation" in persona
        assert "Treat more than 5 Child Agents as a large delegation" in persona
        assert "call `request_human_choice` before launching the first Child Agent" in persona
        assert "state the expected count and delegation outline" in persona
        assert "required even when the task and delegation plan are otherwise clear" in persona
        assert "Do not split launches across rounds to avoid this confirmation" in persona
        assert "only if the expected total rises above the approved count" in persona
        assert _prompt._SUB_AGENT_GUIDANCE_PLACEHOLDER not in persona

    run_only = _prompt.render_stage_persona(
        {"run_subagent"}, template=_prompt.WORKFLOW_PERSONA,
    )
    assert "`run_subagent`" in run_only
    assert "`start_subagent`" not in run_only
    assert "does not require an explicit user request" in run_only
    assert "Treat more than 5 Child Agents as a large delegation" in run_only


def test_subagent_guidance_is_omitted_when_delegation_tools_are_not_visible() -> None:
    personas = (
        _prompt.render_main_persona(set()),
        _prompt.render_stage_persona(set(), template=_prompt.WORKFLOW_PERSONA),
        _prompt.render_stage_persona(set(), template=_prompt.WORKFLOW_VALIDATE_PERSONA),
    )

    for persona in personas:
        assert "does not require an explicit user request" not in persona
        assert "`amphi agent run <prompt>`" not in persona
        assert "prefer issuing all corresponding `run_subagent` calls together" not in persona
        assert "Treat more than 5 Child Agents as a large delegation" not in persona
        assert _prompt._SUB_AGENT_GUIDANCE_PLACEHOLDER not in persona


def test_all_prompts_require_the_same_human_request_context() -> None:
    personas = (
        _prompt.PERSONA,
        _prompt.CLARIFY_PERSONA,
        _prompt.EXPLORE_PERSONA,
        _prompt.GENERATE_PERSONA,
        _prompt.VERIFY_PERSONA,
        _prompt.WORKFLOW_PERSONA,
        _prompt.WORKFLOW_VALIDATE_PERSONA,
    )

    for persona in personas:
        assert _prompt._REQUEST_HUMAN_CHOICE_GUIDANCE in persona
        assert "Every call must provide a non-empty `prompt`" in persona
        assert "why you cannot continue without the user's input" in persona
        assert "what the user's decision will determine" in persona
        assert "required `questions` JSON string" in persona
        assert "never embed the questions JSON in `prompt`" in persona
        assert "`multiSelect` controls the question type" in persona
        assert '"layout": "compact"' not in persona
        assert "Omit `prompt`" not in persona


def test_all_prompts_share_browser_state_guidance() -> None:
    assert _prompt._BROWSER_GUIDANCE.strip()
    personas = (
        _prompt.PERSONA,
        _prompt.SUB_AGENT_PERSONA,
        _prompt.CLARIFY_PERSONA,
        _prompt.EXPLORE_PERSONA,
        _prompt.GENERATE_PERSONA,
        _prompt.VERIFY_PERSONA,
        _prompt.WORKFLOW_PERSONA,
        _prompt.WORKFLOW_VALIDATE_PERSONA,
    )

    for persona in personas:
        assert _prompt._BROWSER_GUIDANCE in persona
        assert "Browser control boundary" in persona
        assert "requires opening, viewing, navigating, searching, or interacting" in persona
        assert "use the built-in `browser_*` tools as the browser-control channel" in persona
        assert "custom scripts that independently control the browser" in persona
        assert "does not prohibit JavaScript or other code" in persona
        assert "call `load_browser_tools` first" in persona
        assert "only after checking the loaded toolset" in persona
        assert "Snapshot lifecycle" in persona
        assert "use element refs only from that snapshot" in persona
        assert "failed browser action may also return a newer snapshot" in persona
        assert "do not call `browser_snapshot` again" in persona
        assert "`read_file` or `grep`" in persona
        assert "contains tab metadata only, not page or DOM content" in persona
        assert "User-facing browser name" in persona
        assert 'simply as "the browser"' in persona
        assert "right-side tool dock" in persona
        assert '"Session browser", "shared browser", "embedded browser", or "app browser"' in persona


def test_all_prompts_share_markdown_link_guidance() -> None:
    personas = (
        _prompt.PERSONA,
        _prompt.CLARIFY_PERSONA,
        _prompt.EXPLORE_PERSONA,
        _prompt.GENERATE_PERSONA,
        _prompt.VERIFY_PERSONA,
        _prompt.WORKFLOW_PERSONA,
        _prompt.WORKFLOW_VALIDATE_PERSONA,
    )

    guidance = _prompt._MARKDOWN_LINK_GUIDANCE
    assert "whether user-visible or inside Markdown documents or artifacts" in guidance
    assert "`[descriptive label](<https://example.com/path>)`" in guidance
    assert "when the URL itself must be visible, use `<https://example.com/path>`" in guidance
    assert "Never rely on a bare URL" in guidance
    assert "outside the closing `)` or `>`" in guidance
    assert "URLs used as code, data, or command arguments literal" in guidance
    assert "`[name](<file:///absolute/path>)`" in guidance
    assert "absolute `file://` URL" in guidance
    assert "instead of showing only a relative path" in guidance
    assert "Link only paths you have observed or confirmed exist" in guidance
    assert "portable references inside generated artifacts" in guidance
    assert "examples, code, and command arguments as inline code" in guidance

    for persona in personas:
        assert guidance in persona


def test_generate_prompt_advertises_supported_agent_cli_without_legacy_helpers() -> None:
    for persona in (_prompt.EXPLORE_PERSONA, _prompt.GENERATE_PERSONA):
        assert "agent()" not in persona
        assert "def agent(" not in persona
    assert "amphi run-agent" not in persona
    assert "`amphi agent run <input>`" in _prompt.GENERATE_PERSONA
    assert "Never put an Agent call inside a script" not in _prompt.GENERATE_PERSONA
    assert "self-contained semantic subtask that code must invoke" in _prompt.GENERATE_PERSONA
    assert "do not import internal Agent modules" in _prompt.GENERATE_PERSONA
    assert "# <Section 2: produce the confirmed final deliverables>" in _prompt.GENERATE_PERSONA
    assert "# AC-001 — <short, specific check name>" in _prompt.GENERATE_PERSONA
    assert "Acceptance rule: <reproduce the exact AC-001 rule text" in _prompt.GENERATE_PERSONA
    assert "Following the current outline in `task.md`" in _prompt.GENERATE_PERSONA
    assert "If `task.md` contains only AC-001, stop after that section" in (
        _prompt.GENERATE_PERSONA
    )
    assert "acceptance contract" not in _prompt.GENERATE_PERSONA.lower()


def test_build_prompts_confirm_outputs_and_keep_runtime_validation_lean() -> None:
    clarify = _prompt.CLARIFY_PERSONA
    assert "Build mode ultimately produces a reusable Workflow" in clarify
    assert "Clarify (`task.md`) establishes a precise requirements description" in clarify
    assert "You are helping the user design a reusable Workflow" in clarify
    assert "First pin down the end-to-end actions" in clarify
    assert "misconception, contradiction, or missing acceptance signal" in clarify
    assert "detailed description of the task requirements in `task.md`" in clarify
    assert "one or two concise rules for checking whether that final result has been achieved" in clarify
    assert "direct final outcome the user cares about in task-domain language" in clarify
    assert "must be recognizable from the completed result" in clarify
    assert "without creating test business data" in clarify
    assert "ensure they are logically consistent" in clarify
    assert "The review may be presented before `task.md` exists" in clarify
    assert "whether through the card or a natural-language reply" in clarify
    assert "as the outline for writing the complete `task.md`" in clarify
    assert "If this Build has not yet presented its acceptance review" in clarify
    assert "Call `request_accept_rule` only once" in clarify
    assert "for every later revision" in clarify
    assert "`task.md`, not Build state, is the sole durable source of truth" in clarify
    assert "Final deliverables and Acceptance criteria" in clarify
    assert "do not repeat the acceptance review" in clarify
    assert "acceptance contract" not in clarify.lower()
    assert "final deliverables and acceptance criteria as required user decisions" not in clarify
    assert "whether a screenshot was supplied or where it can be accessed" not in clarify
    assert clarify.index("# Tools and skills") < clarify.index("# Current stage: clarify")

    explore = _prompt.EXPLORE_PERSONA
    assert "concrete, grounded **implementation approach**" in explore
    assert "it is normal for no acceptance criteria to be defined" in explore
    assert "exactly two level-two sections meaning Execution environment and Task flow" in explore
    assert "mark it `CODE:`, `AGENT:`, or `HUMAN:`" in explore
    assert "strongly recommended decision framework" in explore
    assert "Skill discovery may be skipped only when" in explore
    assert "For every other task, follow `how-to` and actively search for" in explore
    assert "browser automation as a hard exclusion" in explore
    assert "Do not select, install, enable, or execute any candidate Skill" in explore
    assert "Use the built-in `browser_*` tools as the already-selected implementation" in explore
    assert "assess Skills only for that non-browser portion" in explore
    assert "check whether an available Skill materially covers" in explore
    assert "Only after the `how-to` process finds no sufficiently matched and usable Skill" in explore
    assert "record it as a `HUMAN:` step under Task flow" in explore
    assert "prefer `CODE:` wherever possible" in explore
    assert "must remain read-only and must not modify state or cause side effects" in explore
    assert "write an executable draft script under `.build/scripts/`" in explore
    assert "actual-path walkthrough, not a desk exercise" in explore
    assert "Prepare them during Explore" in explore
    assert "execute one complete representative iteration" in explore
    assert "traverse one real continuation and confirm the corresponding stopping state" in explore
    assert "record that exact boundary" in explore
    assert "paths of draft scripts that grounded deterministic steps" in explore
    assert "quick path" not in explore and "deep path" not in explore
    assert "STABLE:" not in explore and "VOLATILE:" not in explore
    assert ".explore/" not in explore
    assert explore.index("# Tools and skills") < explore.index("# Current stage: explore")

    generate = _prompt.GENERATE_PERSONA
    assert "use one level-one section in this shape for each acceptance check" in generate
    assert "`VALIDATE.md` assumes execution is complete" in generate
    assert "must not create, update, delete, relabel, send, trigger" in generate
    assert "must not depend on output or side effects from another check" in generate
    assert "Write only the final deliverables confirmed in `task.md`" in generate
    assert "`task.md` is the source of truth for task steps, final deliverables, and acceptance criteria" in generate
    assert "instead of relying on a separate Build-state contract" in generate
    assert "actual operation path observed in the prepared environment" in generate
    assert "Reuse the third-party Python packages prepared and verified" in generate
    assert "do not add an input, item limit, branch, or alternate path solely" in generate
    assert "Preserve the real source acquisition, parsing, transformation" in generate
    assert "use the successful `.build/scripts/` draft as grounded evidence" in generate
    assert "must never be referenced directly by `WORKFLOW.md`" in generate
    assert "For `HUMAN:`, state in `WORKFLOW.md` when to pause" in generate
    assert "Validation evidence:" not in generate
    assert ".explore/" not in generate

    for stage, persona in (
        ("clarify", clarify),
        ("explore", explore),
        ("generate", generate),
        ("verify", _prompt.VERIFY_PERSONA),
    ):
        assert f"The tools currently available in {stage.title()} are:" in persona
        assert persona.index("# Tools and skills") < persona.index(f"# Current stage: {stage}")
        assert "<build_operation>" not in persona
        assert "`Operation` as `create` or `edit`" in persona

    verify = _prompt.VERIFY_PERSONA
    assert "one title and three level-two sections meaning Test scope and Workflow checks" in verify
    assert "Keep all source under `workflow/` read-only" in verify
    assert "smallest bounded execution that preserves its operations, branches, and loop behavior" in verify
    assert "use the operation path in `explore.md` as the coverage baseline" in verify
    assert "Never execute an action that can change actual external or business state" in verify
    assert "Replay the operation sequence recorded in `explore.md` directly in the actual environment" in verify
    assert "create a fresh full copy at `.verify/workflow/`" in verify
    assert "It proves only the per-item body that actually ran" in verify
    assert "record that section as `NOT RUN (safety)`" in verify
    assert "Overall Build verdict may be `PASS`" in verify
    assert "it must also name the skipped boundary and remaining coverage limitation" in verify
    assert "do not have an Agent reimplement the check" in verify
    assert "apply its recorded semantic rubric only to the real result" in verify
    assert "Every acceptance check must remain read-only" in verify
    assert "`task.md` is the source of truth for final deliverables and acceptance criteria" in verify
    assert "record the validator as `NOT RUN (safety)`" in verify
    assert "run the edited Workflow end to end from the beginning" not in verify
    assert "VALIDATION_COMPATIBILITY" not in verify
    assert "VALIDATION_ISOLATION" not in verify
    assert "VERIFY_ONLY_BEGIN" in verify
    assert "VERIFY_ONLY_END" in verify


def test_special_mode_prompts_make_completion_paths_unambiguous() -> None:
    for persona in (
        _prompt.CLARIFY_PERSONA,
        _prompt.EXPLORE_PERSONA,
        _prompt.GENERATE_PERSONA,
        _prompt.VERIFY_PERSONA,
    ):
        assert '`switch(mode="normal")` never means “the Build is finished”' in persona

    assert "call `request_human_task_confirm` to ask the user to confirm" in _prompt.CLARIFY_PERSONA
    assert "Before calling `switch`, check that the stage is actually complete" in _prompt.EXPLORE_PERSONA
    assert "Before calling `switch`, check that Generate is actually complete" in _prompt.GENERATE_PERSONA
    assert "Verify's only successful completion action" in _prompt.VERIFY_PERSONA
    assert "do not emit a final completion answer" in _prompt.VERIFY_PERSONA

    execute = _prompt.WORKFLOW_PERSONA
    validation = _prompt.WORKFLOW_VALIDATE_PERSONA
    for persona in (execute, validation):
        assert "Treat these persisted fields as authoritative" in persona
        assert "Never infer the Run position from existing files" in persona
        assert "explicitly requests to terminate and exit" in persona
        assert "call `switch(mode=\"normal\")`" in persona
        assert "retains the current Workflow Run state" in persona
        assert '`switch(mode="normal")` never means “the Workflow Run is complete”' in persona

    assert "After each section is complete, call `report_workflow_step`" in execute
    assert "runtime automatically enters Validate" in execute
    assert "publishes an execution-only Run" in execute
    assert "# Current stage: Validate" not in execute

    assert "After each section is complete, call `report_workflow_step`" in validation
    assert "runtime automatically publishes the completed Run" in validation
    assert "# Current stage: Execute" not in validation
    assert "- `<schedules>`:" in validation


def test_switch_tool_description_distinguishes_build_and_workflow_progression() -> None:
    description = switch.__doc__ or ""

    assert "model-controlled pipeline such as Build" in description
    assert "Workflow Run stages" in description
    assert "advance automatically after successful section reports" in description


@pytest.mark.parametrize(
    "worker",
    [
        MainThink(),
        SubAgentThink(),
        ClarifyThink(),
        ExploreThink(),
        GenerateThink(),
        VerifyThink(),
        WorkflowThink(),
        ValidateThink(),
    ],
)
def test_every_think_system_block_is_stable(worker) -> None:
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    first = worker.system_block(ota_context, context)
    second = worker.system_block(ota_context, context)

    assert first == second
    assert "<current_time>" not in first


@pytest.mark.parametrize(
    "worker",
    [
        MainThink(), SubAgentThink(), ClarifyThink(), ExploreThink(),
        GenerateThink(), VerifyThink(),
    ],
)
async def test_every_think_freezes_current_time_in_the_current_user_tail(worker, monkeypatch) -> None:
    values = iter(("2026-07-15 16:00 (UTC+08:00)", "2026-07-15 16:01 (UTC+08:00)"))
    monkeypatch.setattr(_cognitive, "time_in_local_tz", lambda: next(values))
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    first = await worker.assemble_messages(ota_context, context)
    second = await worker.assemble_messages(ota_context, context)
    third = await worker.assemble_messages(AmphiOTAContext(user_input="test"), context)

    assert first[0].content == second[0].content == third[0].content
    assert "<current_time>" not in first[0].content
    assert first[1].content == second[1].content
    assert ota_context.prompt_time == "2026-07-15 16:00 (UTC+08:00)"
    assert "prompt_time" not in ota_context.model_dump()
    assert first[1].content.endswith(
        "<current_time>\n2026-07-15 16:00 (UTC+08:00)\n</current_time>"
    )
    assert third[1].content.endswith(
        "<current_time>\n2026-07-15 16:01 (UTC+08:00)\n</current_time>"
    )


async def test_prompt_contexts_are_ordered_from_stable_to_volatile(monkeypatch) -> None:
    def async_block(value):
        async def render(*_):
            return value
        return render

    ota = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    main = MainThink()
    monkeypatch.setattr(main, "transcript_block", lambda *_: "transcript")
    monkeypatch.setattr(main, "skills_block", async_block("skills"))
    monkeypatch.setattr(main, "schedules_block", async_block("schedules"))
    monkeypatch.setattr(main, "workflows_block", async_block("workflows"))
    monkeypatch.setattr(main, "memory_block", async_block("memory"))
    monkeypatch.setattr(main, "workspace_block", async_block("workspace"))
    assert await main.context_blocks(ota, context) == [
        "transcript", "skills", "schedules", "workflows", "memory", "workspace",
    ]

    subagent = SubAgentThink()
    monkeypatch.setattr(subagent, "skills_block", async_block("skills"))
    monkeypatch.setattr(subagent, "workflows_block", async_block("workflows"))
    monkeypatch.setattr(subagent, "memory_block", async_block("memory"))
    monkeypatch.setattr(subagent, "workspace_block", async_block("workspace"))
    assert await subagent.context_blocks(ota, context) == [
        "skills", "workflows", "memory", "workspace",
    ]

    workflow = WorkflowThink()
    monkeypatch.setattr(workflow, "transcript_block", lambda *_: "transcript")
    monkeypatch.setattr(workflow, "skills_block", async_block("skills"))
    monkeypatch.setattr(workflow, "schedules_block", async_block("schedules"))
    monkeypatch.setattr(workflow, "workflow_run_block", async_block("workflow_run"))
    monkeypatch.setattr(workflow, "memory_block", async_block("memory"))
    monkeypatch.setattr(workflow, "workspace_block", async_block("workspace"))
    assert await workflow.context_blocks(ota, context) == [
        "transcript", "skills", "schedules", "workflow_run", "memory", "workspace",
    ]

    build = ClarifyThink()
    monkeypatch.setattr(build, "transcript_block", lambda *_: "transcript")
    monkeypatch.setattr(build, "skills_block", async_block("skills"))
    monkeypatch.setattr(build, "artifacts_block", lambda *_: "artifacts")
    monkeypatch.setattr(build, "memory_block", async_block("memory"))
    monkeypatch.setattr(build, "build_workspace_block", lambda *_: "build_workspace")
    monkeypatch.setattr(build, "workspace_block", async_block("workspace"))
    assert await build.build_context_blocks(ota, context, "task.md") == [
        "transcript", "skills", "artifacts", "memory", "build_workspace", "workspace",
    ]


@pytest.mark.parametrize(
    "worker",
    [
        ClarifyThink(),
        ExploreThink(),
        GenerateThink(),
        VerifyThink(),
        WorkflowThink(),
        ValidateThink(),
    ],
)
@pytest.mark.parametrize(
    ("browser_loaded", "workspace_loaded", "skills_loaded"),
    [
        (False, False, False),
        (True, False, False),
        (False, True, False),
        (False, False, True),
        (True, True, True),
    ],
)
def test_stage_prompt_tools_match_runtime_visibility(
    worker,
    browser_loaded,
    workspace_loaded,
    skills_loaded,
) -> None:
    ota_context = AmphiOTAContext(user_input="test")
    ota_context.browser_tool_loaded = browser_loaded
    ota_context.workspace_tools_loaded = workspace_loaded
    ota_context.skills_tool_loaded = skills_loaded
    context = AmphiContext()
    runtime_names = [
        spec.tool_name
        for spec in worker.select_tools(ota_context, context)
    ]
    system = worker.system_block(ota_context, context)

    assert _stage_prompt_tool_names(system) == runtime_names
    assert "__AMPHI_STAGE_TOOL_NAMES__" not in system
    assert (
        "prefer issuing all corresponding `run_subagent` calls together" in system
    ) is ("run_subagent" in set(runtime_names))

@pytest.mark.parametrize(
    ("browser_loaded", "workspace_loaded", "skills_loaded"),
    [
        (False, False, False),
        (True, False, False),
        (False, True, False),
        (False, False, True),
        (True, True, True),
    ],
)
async def test_main_prompt_tools_match_the_same_dynamic_runtime_surface(
    browser_loaded,
    workspace_loaded,
    skills_loaded,
) -> None:
    worker = MainThink()
    ota_context = AmphiOTAContext(user_input="test")
    ota_context.browser_tool_loaded = browser_loaded
    ota_context.workspace_tools_loaded = workspace_loaded
    ota_context.skills_tool_loaded = skills_loaded

    system = (await worker.assemble_messages(ota_context, AmphiContext()))[0].content
    runtime_names = [spec.tool_name for spec in ota_context.tools]

    assert _main_prompt_tool_names(system) == runtime_names
    assert runtime_names == [
        spec.tool_name for spec in worker.select_tools(ota_context, AmphiContext())
    ]
    assert "__AMPHI_MAIN_TOOL_NAMES__" not in system


async def test_main_pure_reasoning_keeps_its_empty_tool_surface() -> None:
    ota_context = AmphiOTAContext(user_input="test")
    worker = MainThink()
    worker.allowed_tools = frozenset()

    system = (await worker.assemble_messages(ota_context, AmphiContext()))[0].content

    assert ota_context.tools == []
    assert _main_prompt_tool_names(system) == []
    assert "are: (none). Call them directly." in system


@pytest.mark.parametrize(
    ("worker", "context"),
    [
        pytest.param(MainThink(), AmphiContext(), id="main"),
        pytest.param(SubAgentThink(), _child_context(), id="subagent"),
    ],
)
async def test_normal_thinking_sends_the_prompt_surface_to_the_llm_harness(
    worker,
    context,
) -> None:
    from src.amphi_service.protocol.llms._streaming import StreamResult

    captured: dict[str, object] = {}

    class CaptureLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            captured["system"] = messages[0].content
            captured["tool_names"] = [tool.name for tool in tools]
            return StreamResult(tool_calls=[], content="done")

    worker._llm = CaptureLlm()
    ota_context = AmphiOTAContext(user_input="test")
    ota_context.browser_tool_loaded = True
    ota_context.workspace_tools_loaded = True
    ota_context.skills_tool_loaded = True
    ota_context.open_record()

    await worker.thinking(ota_context, context)

    system = captured["system"]
    tool_names = captured["tool_names"]
    assert isinstance(system, str)
    assert isinstance(tool_names, list)
    assert _main_prompt_tool_names(system) == tool_names
    assert tool_names == [spec.tool_name for spec in ota_context.tools]


@pytest.mark.parametrize("worker", [WorkflowThink(), ValidateThink()])
async def test_workflow_thinking_sends_the_selected_surface_to_the_llm_harness(
    worker,
    monkeypatch,
) -> None:
    from src.amphi_service.protocol.llms._streaming import StreamResult

    captured: dict[str, object] = {}

    class CaptureLlm:
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            captured["system"] = messages[0].content
            captured["tool_names"] = [tool.name for tool in tools]
            return StreamResult(tool_calls=[], content="done")

    async def empty_context_blocks(*_args):
        return []

    monkeypatch.setattr(worker, "context_blocks", empty_context_blocks)
    worker._llm = CaptureLlm()
    ota_context = AmphiOTAContext(user_input="pause this Workflow Run")
    ota_context.open_record()

    await worker.thinking(ota_context, AmphiContext())

    system = captured["system"]
    tool_names = captured["tool_names"]
    assert isinstance(system, str)
    assert isinstance(tool_names, list)
    assert "switch" in tool_names
    assert _stage_prompt_tool_names(system) == tool_names
    assert tool_names == [spec.tool_name for spec in ota_context.tools]
    assert tool_names == [
        spec.tool_name
        for spec in worker.select_tools(ota_context, AmphiContext())
    ]


@pytest.mark.parametrize(
    ("loaded_flag", "advanced_names"),
    [
        ("browser_tool_loaded", BROWSER_ADVANCED_TOOL_NAMES),
        ("workspace_tools_loaded", WORKSPACE_ADVANCED_TOOL_NAMES),
        ("skills_tool_loaded", SKILLS_ADVANCED_TOOL_NAMES),
    ],
)
def test_subagent_loaders_reveal_every_advanced_tool(
    loaded_flag,
    advanced_names,
) -> None:
    worker = SubAgentThink()
    context = _child_context()
    unloaded = AmphiOTAContext(user_input="test")
    unloaded_names = {
        spec.tool_name for spec in worker.select_tools(unloaded, context)
    }

    assert {"load_browser_tools", "load_workspace_tools", "manage_skills"} <= unloaded_names
    assert unloaded_names.isdisjoint(advanced_names)

    loaded = AmphiOTAContext(user_input="test")
    setattr(loaded, loaded_flag, True)
    loaded_names = {spec.tool_name for spec in worker.select_tools(loaded, context)}

    assert advanced_names <= loaded_names


async def test_subagent_uses_its_own_tool_surface_and_prompt() -> None:
    configured = BROWSER_TOOL_NAMES | {
        "bash",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "grep",
        "web_search",
        "web_fetch",
        "workspace_status",
        "workspace_diff",
        "workspace_history",
        "load_workspace_tools",
        "view_skill",
        "manage_skills",
        "list_workflow_runs",
        "read_workflow_run",
        "request_human_choice",
    }
    assert CHILD_TOOL_NAMES == configured
    expected = (
        configured
        | BROWSER_ADVANCED_TOOL_NAMES
        | WORKSPACE_ADVANCED_TOOL_NAMES
        | SKILLS_ADVANCED_TOOL_NAMES
    )

    ota_context = AmphiOTAContext(user_input="test")
    ota_context.browser_tool_loaded = True
    ota_context.workspace_tools_loaded = True
    ota_context.skills_tool_loaded = True
    worker = SubAgentThink()
    context = _child_context()
    messages = await worker.assemble_messages(
        ota_context,
        context,
    )
    system = messages[0].content
    persona = worker.system_block(ota_context, context)
    runtime_names = [spec.tool_name for spec in ota_context.tools]

    assert set(runtime_names) == expected
    assert _main_prompt_tool_names(system) == runtime_names
    assert worker.persona == _prompt.SUB_AGENT_PERSONA
    assert worker.persona != MainThink.persona
    assert persona.rstrip().endswith(_prompt.SUB_AGENT_PROMPT.strip())
    assert "<sub_agent>" not in persona
    assert system.startswith(f"{persona}\n\n<context>\n")
    assert system.rstrip().endswith("</context>")
    assert messages[1].content.rstrip().endswith("</current_time>")
    assert "running, advancing, or completing Workflows" in system
    assert "call `request_human_choice` yourself" in system
    assert "does not hand that interaction back to its parent Agent" in system
    assert "`amphi agent run <prompt>`" not in system
    assert "prefer issuing all corresponding `run_subagent` calls together" not in system
    assert _prompt._SUB_AGENT_GUIDANCE_PLACEHOLDER not in system
    assert {
        "edit_workflow",
        "request_build",
        "request_run_workflow",
        "create_schedule",
        "update_schedule",
        "delete_schedule",
        "get_schedule",
        "list_schedules",
        "remove_workflow",
        "run_subagent",
        "start_subagent",
    }.isdisjoint(runtime_names)

async def test_root_main_keeps_root_tools_without_a_sub_agent_prompt() -> None:
    ota_context = AmphiOTAContext(user_input="test")
    messages = await MainThink().assemble_messages(
        ota_context,
        AmphiContext(),
    )
    system = messages[0].content
    runtime_names = {spec.tool_name for spec in ota_context.tools}

    assert {"run_subagent", "start_subagent", "request_build"} <= runtime_names
    assert "`amphi agent run <prompt>`" in system
    assert "call `remove_workflow` with its id from `<workflows>`" in system
    assert "prefer issuing all corresponding `run_subagent` calls together" in system
    assert _prompt._SUB_AGENT_GUIDANCE_PLACEHOLDER not in system
    assert _prompt.SUB_AGENT_PROMPT.strip() not in system
    assert system.rstrip().endswith("</context>")
    assert messages[1].content.rstrip().endswith("</current_time>")


def test_switch_is_hidden_from_main_and_visible_in_special_modes() -> None:
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    assert "switch" not in {
        spec.tool_name for spec in MainThink().select_tools(ota_context, context)
    }

    for worker in (
        ClarifyThink(), ExploreThink(), GenerateThink(), VerifyThink(),
        WorkflowThink(), ValidateThink(),
    ):
        assert "switch" in {spec.tool_name for spec in worker.select_tools(ota_context, context)}


@pytest.mark.parametrize(
    ("worker", "expected"),
    [
        (
            MainThink(),
            {
                "request_build", "request_run_workflow", "request_human_choice",
                "create_schedule", "delete_schedule", "edit_workflow", "get_schedule",
                "list_schedules", "remove_workflow", "update_schedule",
                "run_subagent", "start_subagent",
            },
        ),
        (
            SubAgentThink(),
            {"request_human_choice"},
        ),
        (
            ClarifyThink(),
            {
                "request_accept_rule", "request_build", "request_human_choice",
                "request_human_task_confirm", "run_subagent", "switch",
            },
        ),
        (
            ExploreThink(),
            {"request_build", "request_human_choice", "run_subagent", "switch"},
        ),
        (
            GenerateThink(),
            {"request_build", "request_human_choice", "run_subagent", "switch"},
        ),
        (
            VerifyThink(),
            {
                "request_build", "request_human_choice",
                "request_human_workflow_confirm", "run_subagent", "switch",
            },
        ),
        (
            WorkflowThink(),
            {
                "request_run_workflow", "request_human_choice", "create_schedule",
                "delete_schedule", "get_schedule", "list_schedules", "update_schedule",
                "remove_workflow", "report_workflow_step", "run_subagent",
                "start_subagent", "switch",
            },
        ),
        (
            ValidateThink(),
            {
                "request_run_workflow", "request_human_choice", "create_schedule",
                "delete_schedule", "get_schedule", "list_schedules", "update_schedule",
                "remove_workflow", "report_workflow_step", "run_subagent",
                "start_subagent", "switch",
            },
        ),
    ],
)
def test_control_tool_surfaces_follow_think_ownership(worker, expected) -> None:
    control_tools = {
        "request_accept_rule", "request_build", "request_run_workflow",
        "request_human_choice", "request_human_task_confirm",
        "request_human_workflow_confirm", "create_schedule", "delete_schedule",
        "edit_workflow", "get_schedule", "list_schedules", "remove_workflow", "update_schedule",
        "report_workflow_step", "run_subagent",
        "start_subagent", "switch",
    }
    visible = {
        spec.tool_name
        for spec in worker.select_tools(AmphiOTAContext(user_input="test"), AmphiContext())
    }

    assert visible & control_tools == expected


@pytest.mark.parametrize(
    "worker",
    [
        MainThink(), ClarifyThink(), ExploreThink(), GenerateThink(),
        VerifyThink(), WorkflowThink(), ValidateThink(),
    ],
)
def test_prompt_never_directs_a_root_think_to_a_hidden_tool(worker) -> None:
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()
    visible = {spec.tool_name for spec in worker.select_tools(ota_context, context)}
    known = {spec.tool_name for spec in _cognitive.TOOL_LIBRARY.all()} | {"switch"}
    mentioned = set(re.findall(
        r"`([a-z][a-z0-9_]*)`",
        worker.system_block(ota_context, context),
    )) & known

    assert mentioned <= visible


def test_request_build_owns_entry_and_build_conflict_semantics() -> None:
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    assert "request_build" in {
        spec.tool_name for spec in MainThink().select_tools(ota_context, context)
    }
    for worker in (ClarifyThink(), ExploreThink(), GenerateThink(), VerifyThink()):
        tool_names = {
            spec.tool_name for spec in worker.select_tools(ota_context, context)
        }
        assert "request_build" in tool_names
        assert "request_build_conflict" not in tool_names
        prompt = worker.system_block(ota_context, context)
        assert "may target a different Workflow from the unfinished Build" in prompt
        assert 'request_build` with `mode="ask"' in prompt

    assert "request_build_conflict" not in {
        spec.tool_name for spec in _cognitive.TOOL_LIBRARY.all()
    }


def test_run_workflow_request_is_visible_in_main_and_workflow_mode() -> None:
    ota_context = AmphiOTAContext(user_input="test")
    context = AmphiContext()

    assert "request_run_workflow" in {
        spec.tool_name for spec in MainThink().select_tools(ota_context, context)
    }
    for worker in (WorkflowThink(), ValidateThink()):
        assert "request_run_workflow" in {
            spec.tool_name for spec in worker.select_tools(ota_context, context)
        }
    for worker in (
        ClarifyThink(),
        ExploreThink(),
        GenerateThink(),
        VerifyThink(),
    ):
        assert "request_run_workflow" not in {
            spec.tool_name for spec in worker.select_tools(ota_context, context)
        }
    assert "choose `resume` without asking" in _prompt.PERSONA
    assert "Use action `start` only when no retained Run exists" in _prompt.PERSONA
    assert "`restart` when they clearly want the currently saved Workflow" in _prompt.PERSONA
    assert "`ask` only when conversation context cannot distinguish" in _prompt.PERSONA
    assert "Restarting the same Workflow reuses the old Run's original structured input" in (
        _prompt.PERSONA
    )
