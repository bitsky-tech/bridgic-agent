from pathlib import Path
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall, ToolArgument

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext
from src.amphi_agent._state import (
    AwaitingPresentationOutlineConfirm,
    NormalStageState,
    PresentationStageState,
    PresentationStepRecord,
)
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.cognitive import (
    PRESENTATION_STAGE_ARTIFACTS,
    PRESENTATION_STAGE_STEPS,
    PresentationBriefThink,
    PresentationPlanThink,
)
from src.amphi_agent.prompts.presentation import PRESENTATION_BRIEF_PERSONA
from src.amphi_agent.tools._presentation import PresentationStepReport
from src.amphi_agent.tools._request_human import RequestPresentation
from src.amphi_service.protocol import StageEvent
from src.amphi_service.runtime._session_events import SessionEventBroker


def test_presentation_pipeline_is_registered() -> None:
    """Every durable presentation stage resolves to one registered ThinkUnit."""
    agent = AmphiAgent()

    assert agent.thinking_modes["presentation"] == (
        "ppt_brief",
        "ppt_plan",
        "ppt_compose",
        "ppt_review",
    )
    assert all(getattr(agent, stage, None) is not None for stage in agent.thinking_modes["presentation"])
    assert "request_presentation" in {tool.tool_name for tool in TOOL_LIBRARY.all()}
    assert "report_presentation_step" in {tool.tool_name for tool in TOOL_LIBRARY.all()}


def test_presentation_prompt_is_owned_by_prompt_package() -> None:
    """The ThinkUnit imports its persona instead of defining prompt text locally."""
    assert PresentationBriefThink.persona is PRESENTATION_BRIEF_PERSONA
    assert "__AMPHI_STAGE_TOOL_NAMES__" in PRESENTATION_BRIEF_PERSONA
    assert "__AMPHI_SUB_AGENT_GUIDANCE__" in PRESENTATION_BRIEF_PERSONA


def test_presentation_brief_prompt_defines_a_durable_communication_contract() -> None:
    """Brief owns its complete contract in the system prompt without a step cursor."""
    assert "ppt_brief" not in PRESENTATION_STAGE_STEPS
    assert "no production-step cursor or step report" in PRESENTATION_BRIEF_PERSONA
    assert "supplied materials" in PRESENTATION_BRIEF_PERSONA
    assert "working defaults" in PRESENTATION_BRIEF_PERSONA
    assert ".presentation/brief.md" in PRESENTATION_BRIEF_PERSONA
    assert "Do not begin research, narrative planning, or visual design" in PRESENTATION_BRIEF_PERSONA
    assert "A topic is not a core message" in PRESENTATION_BRIEF_PERSONA
    assert "A bare-topic request does not establish its audience" in PRESENTATION_BRIEF_PERSONA
    assert "before switching to Plan" in PRESENTATION_BRIEF_PERSONA
    assert "Do not turn Brief into an interview checklist" in PRESENTATION_BRIEF_PERSONA
    assert "never add a recommended label" in PRESENTATION_BRIEF_PERSONA
    assert "# Brief artifact contract" in PRESENTATION_BRIEF_PERSONA
    assert "Assumptions and open decisions" in PRESENTATION_BRIEF_PERSONA
    assert "audience-facing qualities" in PRESENTATION_BRIEF_PERSONA


def test_presentation_step_record_repairs_legacy_character_evidence() -> None:
    """Persisted reports from the old string iterator are repaired during hydration."""
    record = PresentationStepRecord.model_validate({
        "stage": "ppt_brief",
        "step_id": "understand_request",
        "summary": "Captured the request.",
        "evidence": list("['.presentation/brief.md']"),
    })

    assert record.evidence == [".presentation/brief.md"]


def test_presentation_pipeline_switches_and_resumes() -> None:
    """Stage handoffs and cross-Turn restoration preserve the presentation mode."""
    agent = AmphiAgent()
    current = PresentationStageState(stage="ppt_brief")

    planned = agent._switch_status(current, "presentation", "ppt_plan")
    finished = agent._switch_status(planned, "normal", None)
    ota_context = AmphiOTAContext()
    agent._resume_think_stage(ota_context, {"mode": "presentation", "stage": "ppt_review"})

    assert planned == PresentationStageState(stage="ppt_plan")
    assert finished == NormalStageState()
    assert ota_context.think_status == PresentationStageState(stage="ppt_review")


def test_presentation_continue_prompt_matches_the_current_cursor() -> None:
    """Continuation guidance never asks Brief to call its unavailable report tool."""
    brief = AmphiOTAContext(ota_record=[OTARecord()])
    brief.transition_think(PresentationStageState(stage="ppt_brief"))
    AmphiAgent._stamp_presentation_continue(brief)

    brief_note = brief.ota_record[-1].observation_result or ""
    assert ".presentation/brief.md" in brief_note
    assert 'switch(stage="ppt_plan"' in brief_note
    assert "Do not call report_presentation_step" in brief_note

    plan = AmphiOTAContext(ota_record=[OTARecord()])
    plan.transition_think(PresentationStageState(stage="ppt_plan"))
    AmphiAgent._stamp_presentation_continue(plan)
    assert "collect_evidence" in (plan.ota_record[-1].observation_result or "")

    ready = AmphiOTAContext(ota_record=[OTARecord()])
    ready.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=len(PRESENTATION_STAGE_STEPS["ppt_plan"]),
    ))
    AmphiAgent._stamp_presentation_continue(ready)
    ready_note = ready.ota_record[-1].observation_result or ""
    assert 'switch(stage="ppt_compose"' in ready_note
    assert "do not repeat a completed step" in ready_note


async def test_presentation_contracts_are_invalidated_on_entry_and_backtrack(tmp_path: Path) -> None:
    """A new or rewound pipeline cannot satisfy its gates with stale contracts."""
    workspace = Workspace("presentation-invalidation", tmp_path / "presentation-invalidation")
    context = AmphiContext(workspace=workspace)

    def write_contracts() -> dict[str, Path]:
        paths = {
            stage: workspace.work_dir / relative
            for stage, relative in PRESENTATION_STAGE_ARTIFACTS.items()
        }
        for stage, path in paths.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"# Old {stage}\n", encoding="utf-8")
        return paths

    paths = write_contracts()
    entering = AmphiOTAContext(ota_record=[OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-request-presentation",
            tool_name="request_presentation",
            tool_arguments={"goal": "Create a new deck"},
            tool_result=RequestPresentation("Create a new deck"),
        )
    ]))])
    async for _ in AmphiAgent().after_action(entering, context):
        raise AssertionError("after_action must not yield a visible value")

    assert entering.think_status == PresentationStageState(goal="Create a new deck")
    assert all(not path.exists() for path in paths.values())

    paths = write_contracts()
    rewinding = AmphiOTAContext(ota_record=[OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-switch-presentation",
            tool_name="switch",
            tool_arguments={"stage": "ppt_plan"},
            tool_result={"mode": None, "stage": "ppt_plan", "reason": "Revise the plan."},
        )
    ]))])
    rewinding.transition_think(PresentationStageState(stage="ppt_review"))
    async for _ in AmphiAgent().after_action(rewinding, context):
        raise AssertionError("after_action must not yield a visible value")

    assert rewinding.think_status == PresentationStageState(stage="ppt_plan")
    assert paths["ppt_brief"].is_file()
    assert not paths["ppt_plan"].exists()
    assert not paths["ppt_review"].exists()


async def test_presentation_step_contract_and_runtime_progress() -> None:
    """A stage cannot hand off until each observable production step is reported."""
    worker = PresentationPlanThink()
    context = AmphiContext()
    ota_context = AmphiOTAContext()
    ota_context.transition_think(PresentationStageState(stage="ppt_plan", goal="Explain the strategy"))
    switch = StepToolCall(
        tool="switch",
        tool_arguments=[ToolArgument(name="stage", value="ppt_compose")],
    )

    reason = await worker.legality_check(switch, ota_context, context)
    assert reason is not None and "collect_evidence" in reason
    assert "Current step id: collect_evidence" in worker.progress_block(ota_context)

    agent = AmphiAgent()
    ota_context.ota_record.append(OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-report-presentation",
            tool_name="report_presentation_step",
            tool_arguments={"summary": "Collected the selected sources."},
            tool_result=PresentationStepReport(
                "Collected the selected sources.",
                ["https://example.com/reference"],
                {"sources": [{
                    "kind": "web",
                    "title": "Primary reference",
                    "locator": "https://example.com/reference",
                    "excerpt": "Relevant evidence",
                    "usage": "Supports the opening chapter",
                }]},
            ),
        )
    ])))
    async for _ in agent.after_action(ota_context, context):
        raise AssertionError("after_action must not yield a visible value")

    state = ota_context.think_status
    assert isinstance(state, PresentationStageState)
    assert state.step_index == 1
    assert state.reports == [PresentationStepRecord(
        stage="ppt_plan",
        step_id="collect_evidence",
        summary="Collected the selected sources.",
        evidence=["https://example.com/reference"],
    )]
    assert state.sources[0].id == "source-001"
    assert state.sources[0].kind == "web"
    assert "Current step id: shape_chapters" in worker.progress_block(ota_context)

    completed = AmphiOTAContext()
    completed.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=len(PRESENTATION_STAGE_STEPS["ppt_plan"]),
    ))
    assert await worker.legality_check(switch, completed, context) is None


def test_presentation_progress_event_contains_the_durable_cursor() -> None:
    """Live stage events expose the same progress data restored from the transcript."""
    publisher = SessionEventBroker().open("presentation-progress")
    ota_context = AmphiOTAContext(stream=publisher)
    state = PresentationStageState(
        stage="ppt_compose",
        step_index=1,
        goal="Explain the strategy",
        reports=[PresentationStepRecord(
            stage="ppt_compose",
            step_id="build_slide_shells",
            summary="Created twelve slide shells.",
            evidence=["slides 1-12"],
        )],
    )

    AmphiAgent._publish_stage(ota_context, state)

    assert len(publisher._buffer) == 1
    event = publisher._buffer[0]
    assert isinstance(event, StageEvent)
    assert event.payload() == {
        "mode": "presentation",
        "stage": "ppt_compose",
        "presentation_goal": "Explain the strategy",
        "presentation_step_index": 1,
        "presentation_reports": [{
            "stage": "ppt_compose",
            "step_id": "build_slide_shells",
            "summary": "Created twelve slide shells.",
            "evidence": ["slides 1-12"],
        }],
        "presentation_sources": [],
        "presentation_outline": [],
        "presentation_outline_confirmed": False,
        "presentation_outline_confirmation_id": None,
    }


async def test_presentation_brief_artifact_is_required_for_the_stage_handoff(tmp_path: Path) -> None:
    """Brief can hand off without a step report only after its artifact is durable."""
    workspace = Workspace("presentation-artifact", tmp_path / "presentation-artifact")
    context = AmphiContext(workspace=workspace)
    worker = PresentationBriefThink()
    ota_context = AmphiOTAContext()
    ota_context.transition_think(PresentationStageState(stage="ppt_brief"))
    switch = StepToolCall(
        tool="switch",
        tool_arguments=[ToolArgument(name="stage", value="ppt_plan")],
    )

    reason = await worker.legality_check(switch, ota_context, context)
    assert reason is not None and ".presentation/brief.md" in reason

    artifact = workspace.work_dir / ".presentation" / "brief.md"
    assert worker.artifact_path(context, "ppt_brief") == artifact
    artifact.parent.mkdir(parents=True)
    artifact.write_text("# Brief\n\nAudience: board", encoding="utf-8")

    assert await worker.legality_check(switch, ota_context, context) is None
    assert "Audience: board" in worker.artifacts_block(context)


def test_presentation_step_catalog_matches_the_intended_production_order() -> None:
    """Plan derives its visual direction from the confirmed content blueprint."""
    assert [step.step_id for step in PRESENTATION_STAGE_STEPS["ppt_plan"]] == [
        "collect_evidence",
        "shape_chapters",
        "map_slides",
        "design_visual_direction",
    ]
    assert [step.step_id for step in PRESENTATION_STAGE_STEPS["ppt_compose"]] == [
        "build_slide_shells",
        "fill_slide_content",
        "create_visuals",
        "polish_deck",
    ]


async def test_slide_map_report_parks_for_editable_outline_confirmation() -> None:
    """The runtime owns outline ids and stops before visual design for review."""
    agent = AmphiAgent()
    state = PresentationStageState(stage="ppt_plan", step_index=2).apply_plan_step_data(
        "collect_evidence",
        {"sources": [{
            "kind": "conversation",
            "title": "User request",
            "excerpt": "Focus on the life story.",
        }]},
    )
    ota_context = AmphiOTAContext(ota_record=[OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-map-slides",
            tool_name="report_presentation_step",
            tool_arguments={"summary": "Mapped the deck."},
            tool_result=PresentationStepReport(
                "Mapped the deck.",
                ["source-001"],
                {"chapters": [{
                    "title": "Opening",
                    "summary": "Establish the context.",
                    "slides": [{
                        "title": "Why this story matters",
                        "key_message": "The subject remains relevant.",
                        "source_ids": ["source-001"],
                    }],
                }]},
            ),
        ),
    ]))])
    ota_context.transition_think(state)

    async for _ in agent.after_action(ota_context, AmphiContext()):
        raise AssertionError("after_action must not yield a visible value")

    next_state = ota_context.think_status
    assert isinstance(next_state, PresentationStageState)
    assert next_state.step_index == 3
    assert next_state.outline[0].id == "chapter-001"
    assert next_state.outline[0].slides[0].id == "slide-001"
    assert next_state.outline_confirmation_id.startswith("presentation_outline_")
    assert next_state.outline_confirmed is False
    assert isinstance(ota_context.interaction_status, AwaitingPresentationOutlineConfirm)
