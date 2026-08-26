from src.amphi_agent._prompt import (
    CLARIFY_PERSONA,
    EXPLORE_PERSONA,
    GENERATE_PERSONA,
    PERSONA,
    SUB_AGENT_PERSONA,
    VERIFY_PERSONA,
    WORKFLOW_PERSONA,
    WORKFLOW_VALIDATE_PERSONA,
    render_main_persona,
    render_stage_persona,
)
from src.amphi_agent.tools import (
    request_accept_rule_tool,
    request_human_choice_tool,
    request_human_workflow_confirm_tool,
)
from src.amphi_service.i18n import use_locale


MAIN_TOOLS = ("read_file", "request_human_choice", "run_subagent", "start_subagent")
CHILD_TOOLS = ("read_file", "request_human_choice")
STAGE_TOOLS = ("read_file", "request_human_choice", "run_subagent", "start_subagent", "switch")


def _personas() -> dict[str, str]:
    return {
        "main": render_main_persona(MAIN_TOOLS, template=PERSONA),
        "child": render_main_persona(CHILD_TOOLS, template=SUB_AGENT_PERSONA),
        "clarify": render_stage_persona(STAGE_TOOLS, template=CLARIFY_PERSONA),
        "explore": render_stage_persona(STAGE_TOOLS, template=EXPLORE_PERSONA),
        "generate": render_stage_persona(STAGE_TOOLS, template=GENERATE_PERSONA),
        "verify": render_stage_persona(STAGE_TOOLS, template=VERIFY_PERSONA),
        "execute": render_stage_persona(STAGE_TOOLS, template=WORKFLOW_PERSONA),
        "validate": render_stage_persona(STAGE_TOOLS, template=WORKFLOW_VALIDATE_PERSONA),
    }


def _assert_markers(text: str, *markers: str) -> None:
    normalized = " ".join(text.replace("*", "").replace("`", "").lower().split())
    for marker in markers:
        expected = " ".join(marker.replace("*", "").replace("`", "").lower().split())
        assert expected in normalized, marker


def test_persona_size_budgets() -> None:
    """Rendered Personas stay below broad second-pass token budgets.

    These limits intentionally leave roughly 10% to 20% headroom over the optimized
    prompts. They use the same UTF-8-bytes/4 estimate as the Prompt Lab, so wording can
    evolve without restoring the large duplicated blocks that these budgets removed.
    """
    estimated_token_budgets = {
        "main": 4_700,
        "child": 3_600,
        "clarify": 4_200,
        "explore": 4_600,
        "generate": 4_750,
        "verify": 6_800,
        "execute": 3_550,
        "validate": 3_600,
    }

    for name, persona in _personas().items():
        byte_size = len(persona.encode("utf-8"))
        estimated_tokens = (byte_size + 3) // 4
        assert estimated_tokens <= estimated_token_budgets[name], (
            f"{name} Persona uses about {estimated_tokens} tokens "
            f"({byte_size} UTF-8 bytes), budget {estimated_token_budgets[name]}"
        )


def test_core_rules_and_renderer_contract() -> None:
    """Critical boundaries survive wording changes and every placeholder resolves."""
    personas = _personas()
    assert set(personas) == {
        "main", "child", "clarify", "explore", "generate", "verify", "execute", "validate",
    }

    for persona in personas.values():
        _assert_markers(
            persona,
            "authorized security",
            "never reveal",
            "# Context",
            "<turn_failed>",
            "incomplete",
            "preceding Agent content",
            "unfinished",
        )
        assert persona.count("# Context") == 1
        assert persona.index("# Context") < persona.index("<turn_failed>")
        assert "__AMPHI_" not in persona

    for name in ("main", "child"):
        _assert_markers(
            personas[name],
            "thinking language",
            "reply language",
            "app UI language",
            "prompt injection",
            "content to read",
            "do not re-attempt the exact same tool call",
            "Before reporting a task complete, verify it actually works",
            "shared Python base",
            "bundled Node",
            "never create a task-local Python project",
            "do not use PEP 723",
            "target the Node base",
        )

    for name in ("clarify", "explore", "generate", "verify"):
        _assert_markers(
            personas[name],
            "language of the user's input message",
            "prefer core tools",
            '`switch(mode="normal")` never means “the Build is finished”',
        )

    for name in ("execute", "validate"):
        _assert_markers(
            personas[name],
            "original Workflow request",
            "prefer the core tool",
            "report_workflow_step",
        )


def test_main_and_child_policy_isolation() -> None:
    """Child receives shared execution rules without Main-only lifecycle policy."""
    main = render_main_persona(MAIN_TOOLS, template=PERSONA)
    child = render_main_persona(CHILD_TOOLS, template=SUB_AGENT_PERSONA)

    root_policy_markers = (
        "Workflow execution:",
        "Retained Workspace activities:",
        "Workflow building:",
        "Workflow editing:",
        "Workflow removal:",
        "Scheduled tasks:",
    )
    root_control_tools = (
        "request_run_workflow",
        "request_build",
        "edit_workflow",
        "remove_workflow",
        "create_schedule",
        "update_schedule",
        "delete_schedule",
    )
    for marker in (*root_policy_markers, *root_control_tools):
        assert marker in main
        assert marker not in child

    _assert_markers(
        child,
        "This Session is a Child Agent",
        "focused goal delegated",
        "Do not delegate to another Child Agent",
        "build, edit, remove, run, advance, or complete Workflows",
        "manage schedules",
        "inspect published Workflow results",
        "list_workflow_runs",
        "read_workflow_run",
        "read-only input",
        "never control a Workflow Run",
        "Use only the Session workspace and mounted paths shown in `<Workspace>`",
        "self-contained report",
        "concrete evidence",
    )
    _assert_markers(main, "Workflow results:", "list_workflow_runs", "read_workflow_run")
    path_exception = "unless the user explicitly requires another location"
    assert path_exception in main
    assert path_exception not in child
    assert "This Session is a Child Agent" not in main

    authoritative = "attached tool schemas are the authoritative capability surface"
    _assert_markers(main, authoritative)
    _assert_markers(child, authoritative)

    old_enumeration = "The tools currently available in this cognitive loop are:"
    sentinel_tools = ("sentinel_tool_alpha", "sentinel_tool_beta")
    for template in (PERSONA, SUB_AGENT_PERSONA):
        rendered = render_main_persona(sentinel_tools, template=template)
        assert old_enumeration not in rendered
        assert all(name not in rendered for name in sentinel_tools)

    stage_templates = (
        CLARIFY_PERSONA,
        EXPLORE_PERSONA,
        GENERATE_PERSONA,
        VERIFY_PERSONA,
        WORKFLOW_PERSONA,
        WORKFLOW_VALIDATE_PERSONA,
    )
    for template in stage_templates:
        rendered = render_stage_persona(sentinel_tools, template=template)
        assert "The tools currently available in" not in rendered
        assert all(name not in rendered for name in sentinel_tools)


def test_legacy_renderer_placeholders() -> None:
    """Custom legacy templates still receive tool, delegation, and locale values."""
    main_template = (
        "tools=__AMPHI_MAIN_TOOL_NAMES__\n"
        "delegation=__AMPHI_SUB_AGENT_GUIDANCE__\n"
        "locale=__AMPHI_UI_LANGUAGE__"
    )
    stage_template = (
        "tools=__AMPHI_STAGE_TOOL_NAMES__\n"
        "delegation=__AMPHI_SUB_AGENT_GUIDANCE__\n"
        "locale=__AMPHI_UI_LANGUAGE__"
    )
    tools = ("read_file", "run_subagent")
    with use_locale("zh"):
        main = render_main_persona(tools, template=main_template)
        stage = render_stage_persona(tools, template=stage_template)

    for rendered in (main, stage):
        assert "`read_file`, `run_subagent`" in rendered
        assert "`run_subagent`" in rendered
        assert "locale=Chinese" in rendered
        assert "__AMPHI_" not in rendered


def test_locale_and_delegation_matrix() -> None:
    """Locale substitution and delegation guidance follow independent render inputs."""
    variants = {
        "none": render_main_persona(("read_file",)),
        "run": render_main_persona(("read_file", "run_subagent")),
        "both": render_main_persona(("read_file", "run_subagent", "start_subagent")),
    }
    assert "`run_subagent`" not in variants["none"]
    assert "`start_subagent`" not in variants["none"]
    assert "`run_subagent`" in variants["run"]
    assert "`start_subagent`" not in variants["run"]
    assert "`run_subagent`" in variants["both"]
    assert "`start_subagent`" in variants["both"]
    _assert_markers(
        variants["both"],
        "self-contained goal",
        "never write overlapping state",
        "one to five",
        "more than five requires",
        "complete delegation outline",
        "splitting rounds",
        "approved count",
    )

    for locale, expected in (("en", "English"), ("zh", "Chinese")):
        with use_locale(locale):
            personas = _personas()
            delegation_variants = (
                render_main_persona(("read_file",)),
                render_main_persona(("read_file", "run_subagent")),
                render_main_persona(("read_file", "run_subagent", "start_subagent")),
            )
        for name, persona in personas.items():
            assert f"app UI language: {expected}" in persona, name
        for persona in delegation_variants:
            assert f"app UI language: {expected}" in persona
            assert "__AMPHI_" not in persona


def test_choice_contract() -> None:
    """Choice guidance retains decision quality while field types live in the schema."""
    for persona in _personas().values():
        _assert_markers(
            persona,
            "request_human_choice",
            "only when progress genuinely depends",
            "batch related open decisions",
            "self-contained Markdown briefing",
            "one concrete decision",
            "complete answer",
            "allowOther",
            "questions",
            "rather than embedding them in prompt",
            "multi-select",
        )

    schema = request_human_choice_tool.to_tool().parameters
    assert schema["required"] == ["questions", "prompt"]
    assert schema["properties"]["questions"]["type"] == "string"
    assert schema["properties"]["prompt"]["type"] == "string"


def test_browser_contract() -> None:
    """Browser state stays on the built-in channel and current snapshot refs."""
    for persona in _personas().values():
        _assert_markers(
            persona,
            "Browser control boundary",
            "only built-in `browser_*` tools",
            "Selenium",
            "Playwright",
            "CDP",
            "not substitutes",
            "load_browser_tools",
            "Snapshot lifecycle",
            "newest returned snapshot is authoritative",
            "returned by a failed action",
            "refs only from it",
            "full-snapshot file",
            "<browser> provides tab metadata",
            'call this surface "the browser"',
            '"Browser" tab',
        )


def test_link_contract() -> None:
    """External and confirmed local paths remain clickable in user-visible prose."""
    for persona in _personas().values():
        _assert_markers(
            persona,
            "external URL",
            "Markdown link",
            "[descriptive label](<https://example.com/path>)",
            "file:///absolute/path",
            "observed or confirmed exist",
        )


def test_skill_contract() -> None:
    """Skills are resolved from the catalogue and read through the owned tool."""
    for persona in _personas().values():
        normalized = persona.replace("*", "").replace("`", "")
        _assert_markers(normalized, "<skills>", "absolute", "first call view_skill")
        lowered = normalized.lower()
        assert "must not use bash" in lowered or "never use bash" in lowered


def test_build_tool_contracts() -> None:
    """Build-specific interactions retain their business contracts and schemas."""
    personas = _personas()
    clarify = personas["clarify"]
    verify = personas["verify"]

    _assert_markers(
        clarify,
        "one or two concise rules",
        "final outcome",
        "request_accept_rule",
        "only once",
    )
    acceptance_schema = request_accept_rule_tool.to_tool().parameters
    assert acceptance_schema["required"] == ["rules"]
    assert acceptance_schema["properties"]["rules"]["type"] == "string"
    assert "JSON list containing one or two direct final-result statements" in (
        acceptance_schema["properties"]["rules"]["description"]
    )

    _assert_markers(verify, "request_human_workflow_confirm", "default_name", "summary", "End the turn")
    workflow_schema = request_human_workflow_confirm_tool.to_tool().parameters
    assert workflow_schema["required"] == ["prompt"]
    assert workflow_schema["properties"]["prompt"]["type"] == "string"
    prompt_description = workflow_schema["properties"]["prompt"]["description"]
    assert '"default_name": "workflow name"' in prompt_description
    assert '"summary": "optional short summary"' in prompt_description


def test_build_structures() -> None:
    """Each Build stage retains its owned artifact and completion boundary."""
    personas = _personas()
    _assert_markers(
        personas["clarify"],
        "task.md",
        "Task",
        "Workflow",
        "Expected output",
        "Final deliverables",
        "Acceptance criteria",
        "request_accept_rule",
        "request_human_task_confirm",
        "fenced Mermaid",
        "Call it alone and end the turn",
        "call `request_human_task_confirm` separately and end that turn",
    )
    _assert_markers(
        personas["explore"],
        "explore.md",
        "Execution environment",
        "Task flow",
        "CODE:",
        "AGENT:",
        "HUMAN:",
        "how-to",
        "view_skill",
        "switch",
    )
    _assert_markers(
        personas["generate"],
        ".build/workflow/",
        "WORKFLOW.md",
        "VALIDATE.md",
        "scripts/*.py",
        "execution",
        "validation",
        "Keep execution and validation independent",
        "switch",
    )
    _assert_markers(
        personas["verify"],
        "verify.md",
        "read-only",
        "Overall Build verdict",
        "smallest decisive real evidence",
        "request_human_workflow_confirm",
    )
    assert "one title and four level-two sections meaning Task, Workflow, Expected output" in personas["clarify"]
    assert "exactly two level-two sections meaning Execution environment and Task flow" in personas["explore"]
    assert "Before calling `switch`, check that the stage is actually complete" in personas["explore"]
    assert '`switch(stage="generate")`' in personas["explore"]
    assert "Before calling `switch`, check that Generate is actually complete" in personas["generate"]
    assert '`switch(stage="verify")`' in personas["generate"]
    assert "# AC-xxx — <short check name>" in personas["generate"]
    assert "Acceptance rule: <exact AC-xxx rule text>" in personas["generate"]


def test_workflow_structures() -> None:
    """Workflow stages retain cursor authority, path boundaries, and reporting."""
    personas = _personas()
    for name in ("execute", "validate"):
        _assert_markers(
            personas[name],
            "Workflow source is immutable",
            "Current section",
            "Current instruction",
            "sole authority",
            "background/work/",
            "final result directory",
            "three retry attempts",
            "report_workflow_step",
            "explicit stage-completion boundary",
            "do not invent or report a section",
            "terminal failure report generated by the runtime",
            "load_browser_tools",
            "load_workspace_tools",
            "manage_skills",
            "raw HTML needed for source-level scraping",
            "DuckDuckGo",
            "another `search_engine`",
        )

    assert "background/execution.md" in personas["execute"]
    assert "background/validation.md" in personas["validate"]
    _assert_markers(
        personas["validate"],
        "Validation is read-only",
        "do not rerun the task",
        "or modify result/business state",
        "declared criterion actually passes",
        "decisive evidence",
    )
    for name in ("execute", "validate"):
        persona = personas[name]
        assert "Write every intermediate file under `background/work/`" in persona
        assert "Write to the final result directory only" in persona
        assert "After each section is complete, call `report_workflow_step`" in persona
