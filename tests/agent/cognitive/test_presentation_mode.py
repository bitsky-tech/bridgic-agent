import json
from pathlib import Path

import pytest
from bridgic.amphibious import ActionResult, ActionStepResult, OTARecord, StepToolCall, ToolArgument
from bridgic.amphibious._type import ThinkResult

from src.amphi_agent import AmphiAgent, AmphiContext, AmphiOTAContext, Session
from src.amphi_agent.cognitive.presentation.state import (
    AwaitingPresentationOutlineConfirm,
    AwaitingPresentationTemplateSelection,
    PresentationChapterOutline,
    PresentationPlanData,
    PresentationStageState,
    PresentationStepRecord,
    PresentationTemplateCandidate,
)
from src.amphi_agent.cognitive.presentation.shared import presentation_view, read_artifact, write_artifact
from src.amphi_agent.cognitive.state import CallVerdict
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent._workspace import Workspace
from src.amphi_agent.cognitive import (
    PRESENTATION_STAGE_ARTIFACTS,
    PRESENTATION_STAGE_STEPS,
    PresentationBriefThink,
    PresentationPlanThink,
)
from src.amphi_agent.prompts.presentation import PRESENTATION_BRIEF_PERSONA, PRESENTATION_PLAN_PERSONA
from src.amphi_agent.tools.ppt import PresentationStepReport, RequestPresentation, RequestPresentationOutlineConfirm
from src.amphi_agent._invocation import AgentInvocation
from src.amphi_service.protocol import (
    PresentationOutlineConfirmRequestEvent,
    PresentationTemplateSelectionRequestEvent,
    StageEvent,
)
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_store import SessionTurnRecord, TurnStatus, UserInput
from tests.agent.cognitive._harness import legality_reason, tool_call


def _receipt(name: str, payload: dict) -> OTARecord:
    return OTARecord(action_result=ActionResult(results=[ActionStepResult(tool_id=name, tool_name=name, tool_arguments={}, tool_result=payload)]))


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
    assert ".ppt/brief.md" in PRESENTATION_BRIEF_PERSONA
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
        "evidence": list("['.ppt/brief.md']"),
    })

    assert record.evidence == [".ppt/brief.md"]


async def test_presentation_pipeline_switches_and_resumes() -> None:
    """Stage handoffs and cross-Turn restoration preserve the presentation mode."""
    agent = AmphiAgent()
    context = AmphiContext()
    ota_context = AmphiOTAContext(ota_record=[OTARecord()])
    ota_context.transition_think(PresentationStageState(stage="ppt_brief"))

    for target, expected in [
        ({"mode": "presentation", "stage": "ppt_plan"}, PresentationStageState(stage="ppt_plan")),
        ({"mode": "normal"}, NormalStageState()),
    ]:
        ota_context.action_result = ActionResult(results=[ActionStepResult(
            tool_id="switch-stage",
            tool_name="switch",
            tool_arguments=target,
            tool_result=target,
            success=True,
        )])
        async for _ in agent.after_action(ota_context, context):
            pass
        assert ota_context.think_status == expected

    review = PresentationStageState(stage="ppt_review", goal="Explain the strategy", step_index=1)
    ota_context.transition_think(review)
    previous_turn = SessionTurnRecord(
        id="presentation-review-turn",
        user_id="local",
        session_id="presentation-session",
        session_ordinal=0,
        user_input=UserInput.from_runtime("Review the strategy presentation."),
        ota_records=[record.model_dump(mode="json") for record in ota_context.ota_record],
        agent_state=ota_context.state.model_dump(mode="json"),
        status=TurnStatus.COMPLETED,
    )
    context.session = Session(turns=[previous_turn])
    resumed = AmphiOTAContext(user_input="Continue reviewing the remaining slides.")

    await agent.init_state(resumed, context)

    assert resumed.think_status == review
    assert resumed.user_input == "Continue reviewing the remaining slides."
    assert resumed.ota_record == []
    assert context.session.get_all() == [previous_turn]


async def test_presentation_continue_prompt_matches_the_current_cursor() -> None:
    """Continuation guidance never asks Brief to call its unavailable report tool."""
    agent = AmphiAgent()
    context = AmphiContext()
    brief = AmphiOTAContext(ota_record=[OTARecord()])
    brief.transition_think(PresentationStageState(stage="ppt_brief"))
    brief_outcome = await agent._current_think_worker(brief, context).handle_think_unit_result(
        brief, context, brief.think_status, "", agent,
    )

    brief_note = brief_outcome.continuation
    assert ".ppt/brief.md" in brief_note
    assert 'switch(stage="ppt_plan"' in brief_note
    assert "Do not call report_presentation_step" in brief_note

    plan = AmphiOTAContext(ota_record=[OTARecord()])
    plan.transition_think(PresentationStageState(stage="ppt_plan"))
    plan_outcome = await agent._current_think_worker(plan, context).handle_think_unit_result(
        plan, context, plan.think_status, "", agent,
    )
    assert "collect_evidence" in plan_outcome.continuation

    ready = AmphiOTAContext(ota_record=[OTARecord()])
    ready.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=len(PRESENTATION_STAGE_STEPS["ppt_plan"]),
    ))
    ready_outcome = await agent._current_think_worker(ready, context).handle_think_unit_result(
        ready, context, ready.think_status, "", agent,
    )
    ready_note = ready_outcome.continuation
    assert 'switch(stage="ppt_compose"' in ready_note
    assert "do not repeat a completed step" in ready_note


def test_presentation_plan_context_excludes_renderer_preview_assets(tmp_path: Path) -> None:
    """The prompt reads the confirmed artifact and excludes renderer-only fields."""
    context = AmphiContext(workspace=Workspace("plan-context", tmp_path / "plan-context"))
    candidate = PresentationTemplateCandidate(
        template_id="template-1", version="version-1", title="Editorial",
        preview_paths=["/private/previews/slide-1.jpg"],
        structural_evidence={"overview": "Editorial template", "representative_slides": [{"slide_number": 1}]},
        materialize_ref={"provider": "local", "template_id": "template-1"},
    )
    artifact = write_artifact(context, "template", {"selected_template": candidate.agent_context()})
    ota_context = AmphiOTAContext(ota_record=[_receipt("request_presentation_template_confirm", {
        "template_selection_id": "choice-1", "status": "selected", "artifact": artifact,
    })])
    ota_context.transition_think(PresentationStageState(stage="ppt_plan"))
    block = PresentationPlanThink().artifacts_block(ota_context, context)
    assert "Editorial template" in block
    assert '"template_id": "template-1"' in block
    assert "/private/previews/" not in block
    assert "representative_slides" not in block


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


async def test_presentation_step_contract_and_runtime_progress(tmp_path: Path) -> None:
    """A stage cannot hand off until each observable production step is reported."""
    worker = PresentationPlanThink()
    context = AmphiContext(workspace=Workspace("progress", tmp_path / "progress"))
    ota_context = AmphiOTAContext()
    ota_context.transition_think(PresentationStageState(stage="ppt_plan", goal="Explain the strategy"))
    switch = StepToolCall(
        tool="switch",
        tool_arguments=[ToolArgument(name="stage", value="ppt_compose")],
    )

    reason = await legality_reason(worker, switch, ota_context, context)
    assert reason is not None and "collect_evidence" in reason
    assert "Current step id: collect_evidence" in worker.progress_block(ota_context)

    report_call = StepToolCall(
        tool="report_presentation_step",
        tool_arguments=[
            ToolArgument(name="summary", value="Collected the selected sources."),
            ToolArgument(
                name="data",
                value=(
                    '{"sources":[{"kind":"web","title":"Primary reference",'
                    '"locator":"https://example.com/reference"}]}'
                ),
            ),
        ],
    )
    assert await legality_reason(worker, report_call, ota_context, context) is None

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
    view = presentation_view(ota_context.ota_record)
    assert view["presentation_reports"][0]["step_id"] == "collect_evidence"
    assert view["presentation_sources"][0]["id"] == "source-001"
    assert view["presentation_sources"][0]["kind"] == "web"
    receipt = ota_context.action_result.results[0].tool_result
    assert read_artifact(context, receipt["artifact"])["sources"] == view["presentation_sources"]
    assert state.model_dump() == {"mode": "presentation", "stage": "ppt_plan", "step_index": 1}
    assert "Current step id: map_slides" in worker.progress_block(ota_context)

    completed = AmphiOTAContext()
    completed.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=len(PRESENTATION_STAGE_STEPS["ppt_plan"]),
    ))
    (context.workspace.work_dir / ".ppt/plan.md").write_text("# Plan\nConfirmed visual direction.\n")
    assert await legality_reason(worker, switch, completed, context) is None


async def test_template_confirmation_must_be_the_plan_units_only_call() -> None:
    """The Plan ThinkUnit enforces the atomic template-selection handoff."""
    worker = PresentationPlanThink()
    context = AmphiContext()
    ppt_call = StepToolCall(call_id="template-confirm", tool="request_presentation_template_confirm", tool_arguments=[])
    ota_context = AmphiOTAContext(ota_record=[OTARecord(think_result=ThinkResult(
        step_content="Choose templates and continue.",
        tool_calls=[ppt_call, StepToolCall(call_id="switch", tool="switch", tool_arguments=[ToolArgument(name="mode", value="normal")])],
    ))])
    ota_context.transition_think(PresentationStageState(
        stage="ppt_plan",
        step_index=2,
        outline_confirmed=True,
    ))

    calls = ota_context.think_result.tool_calls
    verdicts = [CallVerdict(id=call.call_id, tool=call.tool, verdict="allow") for call in calls]
    ota_context.tools = worker.select_tools(ota_context, context)
    resolved = await worker._check_action_legality(ota_context, context, calls, verdicts, AmphiAgent())

    assert all(verdict.verdict == "deny" for verdict in resolved)
    assert all("control-flow rejected" in (verdict.reason or "") for verdict in resolved)

    ota_context.ota_record[-1].think_result = ThinkResult(
        step_content="Choose templates.",
        tool_calls=[ppt_call],
    )
    assert await legality_reason(worker, ppt_call, ota_context, context) is None


@pytest.mark.parametrize("selection_status", ["idle", "pending", "selected", "skipped"])
@pytest.mark.parametrize("tool_name", ["ppt_rag", "request_presentation_template_confirm"])
async def test_template_tool_admission_does_not_depend_on_previous_decisions(selection_status: str, tool_name: str) -> None:
    """Keeping the tool visible also permits its invocation after a selection or skip."""
    context = AmphiContext()
    ota_context = AmphiOTAContext(state={"think": PresentationStageState(
        stage="ppt_plan", step_index=2, outline_confirmed=True,
        template_selection_status=selection_status,
    )})
    call = tool_call(tool_name)
    assert await legality_reason(PresentationPlanThink(), call, ota_context, context) is None


def test_presentation_progress_event_contains_the_durable_cursor() -> None:
    """Live stage events expose the same progress data restored from the transcript."""
    publisher = SessionEventBroker().open("presentation-progress")
    ota_context = AmphiOTAContext(stream=publisher)
    state = PresentationStageState(stage="ppt_compose", step_index=1)
    ota_context.ota_record = [
        _receipt("request_presentation", {"goal": "Explain the strategy"}),
        _receipt("report_presentation_step", {"stage": "ppt_compose", "step_id": "build_slide_shells", "summary": "Created twelve slide shells.", "evidence": ["slides 1-12"]}),
    ]

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
        "presentation_template_candidates": [],
        "presentation_template_selection_id": None,
        "presentation_template_selection_status": "idle",
        "presentation_template_selection_error": None,
        "presentation_selected_template": None,
    }


def test_presentation_outline_confirmation_is_published_as_a_framework_interaction() -> None:
    """The parked outline review reaches the live conversation surface."""
    publisher = SessionEventBroker().open("presentation-outline-confirm")

    AgentInvocation._publish_interaction(
        publisher,
        AwaitingPresentationOutlineConfirm(request_id="outline-1"),
    )

    assert len(publisher._buffer) == 1
    event = publisher._buffer[0]
    assert isinstance(event, PresentationOutlineConfirmRequestEvent)
    assert event.payload() == {"request_id": "outline-1"}


def test_presentation_template_selection_is_published_as_a_framework_interaction() -> None:
    """A verified template shortlist reaches the dedicated user-selection surface."""
    publisher = SessionEventBroker().open("presentation-template-selection")

    AgentInvocation._publish_interaction(
        publisher,
        AwaitingPresentationTemplateSelection(request_id="template-selection-1"),
    )

    assert len(publisher._buffer) == 1
    event = publisher._buffer[0]
    assert isinstance(event, PresentationTemplateSelectionRequestEvent)
    assert event.payload() == {"request_id": "template-selection-1"}


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

    reason = await legality_reason(worker, switch, ota_context, context)
    assert reason is not None and ".ppt/brief.md" in reason

    artifact = workspace.work_dir / ".ppt" / "brief.md"
    assert worker.artifact_path(context, "ppt_brief") == artifact
    artifact.parent.mkdir(parents=True)
    artifact.write_text("# Brief\n\nAudience: board", encoding="utf-8")

    assert await legality_reason(worker, switch, ota_context, context) is None
    assert ".ppt/brief.md" in worker.artifacts_block(ota_context, context)
    assert "Audience: board" not in worker.artifacts_block(ota_context, context)


def test_presentation_step_catalog_matches_the_intended_production_order() -> None:
    """Plan derives its visual direction from the confirmed content blueprint."""
    assert [step.step_id for step in PRESENTATION_STAGE_STEPS["ppt_plan"]] == [
        "collect_evidence",
        "map_slides",
        "design_visual_direction",
    ]
    assert [step.step_id for step in PRESENTATION_STAGE_STEPS["ppt_compose"]] == [
        "build_slide_shells",
        "fill_slide_content",
        "create_visuals",
        "polish_deck",
    ]
    collect = PRESENTATION_STAGE_STEPS["ppt_plan"][0]
    assert "supplied files and conversation first" in collect.instruction
    assert "one sufficient source is enough" in collect.instruction
    assert "3–5 high-quality sources" in collect.instruction
    assert "content_outline" in PRESENTATION_PLAN_PERSONA


def test_legacy_plan_cursor_collapses_the_removed_chapter_step() -> None:
    """Saved four-step Plan sessions resume at the equivalent three-step cursor."""
    state = PresentationStageState.model_validate({
        "stage": "ppt_plan",
        "step_index": 3,
        "reports": [
            {"stage": "ppt_plan", "step_id": "collect_evidence", "summary": "Collected.", "evidence": []},
            {"stage": "ppt_plan", "step_id": "shape_chapters", "summary": "Shaped.", "evidence": []},
            {"stage": "ppt_plan", "step_id": "map_slides", "summary": "Mapped.", "evidence": []},
        ],
    })

    assert state.step_index == 2
    assert state.model_dump() == {"mode": "presentation", "stage": "ppt_plan", "step_index": 2}


def test_slide_map_requires_page_content_outlines() -> None:
    """A page title alone is not a sufficiently detailed production blueprint."""
    with pytest.raises(ValueError, match="non-empty `content_outline`"):
        PresentationPlanData().apply_plan_step_data(
            "map_slides",
            {"chapters": [{
                "title": "Opening",
                "slides": [{"title": "Why this matters"}],
            }]},
        )


async def test_outline_tool_parks_in_slide_mapping_without_reporting_completion() -> None:
    """The runtime owns outline ids and stops before visual design for review."""
    agent = AmphiAgent()
    data = PresentationPlanData().apply_plan_step_data(
        "collect_evidence",
        {"sources": [{
            "kind": "conversation",
            "title": "User request",
            "excerpt": "Focus on the life story.",
        }]},
    )
    publisher = SessionEventBroker().open("outline-review-step")
    ota_context = AmphiOTAContext(stream=publisher, ota_record=[OTARecord(action_result=ActionResult(results=[
        ActionStepResult(
            tool_id="call-map-slides",
            tool_name="request_presentation_outline_confirm",
            tool_arguments={},
            tool_result=RequestPresentationOutlineConfirm(
                {"chapters": [{
                    "title": "Opening",
                    "summary": "Establish the context.",
                    "slides": [{
                        "title": "Why this story matters",
                        "key_message": "The subject remains relevant.",
                        "content_outline": [
                            "Introduce the central question.",
                            "Connect the question to the audience.",
                        ],
                        "source_ids": ["source-001"],
                    }],
                }]},
            ),
        ),
    ]))])
    ota_context.ota_record.insert(0, _receipt("report_presentation_step", {"step_id": "collect_evidence", "data": {"sources": [item.model_dump() for item in data.sources]}}))
    ota_context.transition_think(PresentationStageState(stage="ppt_plan", step_index=1))

    async for _ in agent.after_action(ota_context, AmphiContext()):
        raise AssertionError("after_action must not yield a visible value")

    next_state = ota_context.think_status
    assert isinstance(next_state, PresentationStageState)
    assert next_state.step_index == 1
    view = presentation_view(ota_context.ota_record)
    assert all(report["step_id"] != "map_slides" for report in view["presentation_reports"])
    assert "Current step id: map_slides" in PresentationPlanThink().progress_block(ota_context)
    assert view["presentation_outline"][0]["id"] == "chapter-001"
    assert view["presentation_outline"][0]["slides"][0]["id"] == "slide-001"
    assert view["presentation_outline"][0]["slides"][0]["content_outline"] == [
        "Introduce the central question.",
        "Connect the question to the audience.",
    ]
    assert view["presentation_outline_confirmation_id"].startswith("presentation_outline_")
    assert view["presentation_outline_confirmed"] is False
    assert isinstance(ota_context.interaction_status, AwaitingPresentationOutlineConfirm)
    events = [event for event in publisher._buffer if isinstance(event, StageEvent)]
    assert events[-1].payload()["presentation_step_index"] == 1
    assert len(events[-1].payload()["presentation_reports"]) == 1
    assert events[-1].payload()["presentation_outline"] == view["presentation_outline"]

    # Replaying the handled receipt must not advance again or replace its confirmation.
    expected_state = next_state.model_dump()
    expected_interaction = ota_context.interaction_status.model_dump()
    expected_receipt = dict(ota_context.action_result.results[0].tool_result)
    async for _ in agent.after_action(ota_context, AmphiContext()):
        raise AssertionError("after_action must not yield a visible value")
    assert ota_context.think_status.model_dump() == expected_state
    assert ota_context.interaction_status.model_dump() == expected_interaction
    assert ota_context.action_result.results[0].tool_result == expected_receipt


@pytest.mark.parametrize("stage,step_index", [("ppt_brief", 0), ("ppt_plan", 0), ("ppt_plan", 1), ("ppt_plan", 2), ("ppt_compose", 1)])
async def test_outline_confirmation_is_only_available_during_slide_mapping(stage: str, step_index: int) -> None:
    """Outline review is a stage-local tool, separate from template selection."""
    worker = PresentationPlanThink()
    context = AmphiContext()
    ota_context = AmphiOTAContext(state={"think": PresentationStageState(stage=stage, step_index=step_index)})
    call = tool_call("request_presentation_outline_confirm", data=json.dumps({"chapters": [{
        "title": "Opening", "slides": [{"title": "Overview", "content_outline": ["Purpose"]}],
    }]}))
    visible = {tool.tool_name for tool in worker.select_tools(ota_context, context)}
    expected = stage == "ppt_plan" and step_index == 1
    assert (call.tool in visible) is expected
    assert (await legality_reason(worker, call, ota_context, context) is None) is expected


async def test_outline_confirmation_is_exclusive_and_required_before_step_report(tmp_path: Path) -> None:
    """Neither an unconfirmed outline nor a batched review can advance progress."""
    worker = PresentationPlanThink()
    context = AmphiContext(workspace=Workspace("report-outline", tmp_path / "report-outline"))
    data = {"chapters": [{
        "title": "Opening", "slides": [{"title": "Overview", "content_outline": ["Purpose"]}],
    }]}
    state = PresentationStageState(stage="ppt_plan", step_index=1)
    ota_context = AmphiOTAContext(state={"think": state})
    report = tool_call("report_presentation_step", summary="Mapped slides.")
    assert "has not been confirmed" in await legality_reason(worker, report, ota_context, context)
    invalid = tool_call("request_presentation_outline_confirm", data='{"chapters": []}')
    assert "non-empty" in await legality_reason(worker, invalid, ota_context, context)

    request = tool_call("request_presentation_outline_confirm", data=json.dumps(data))
    calls = [request, report]
    verdicts = [CallVerdict(id=str(index), tool=call.tool, verdict="allow") for index, call in enumerate(calls)]
    resolved = await worker._check_action_legality(ota_context, context, calls, verdicts, AmphiAgent())
    assert all(verdict.verdict == "deny" for verdict in resolved)
    assert all("control-flow rejected" in verdict.reason for verdict in resolved)
    assert ota_context.think_status.step_index == 1

    artifact = write_artifact(context, "outline", data)
    ota_context.ota_record.append(_receipt("request_presentation_outline_confirm", {"status": "confirmed", "artifact": artifact}))
    assert await legality_reason(worker, report, ota_context, context) is None
    overwrite = tool_call("report_presentation_step", summary="Replace outline.", data=json.dumps(data))
    assert "omit `chapters`" in await legality_reason(worker, overwrite, ota_context, context)


async def test_template_retrieval_can_share_a_batch_with_a_read() -> None:
    """Retrieval has no human-interaction handoff and is not an exclusive control."""
    worker = PresentationPlanThink()
    context = AmphiContext()
    calls = [tool_call("ppt_rag"), tool_call("read_file")]
    ota = AmphiOTAContext(ota_record=[OTARecord(think_result=ThinkResult(tool_calls=calls))])
    ota.transition_think(PresentationStageState(stage="ppt_plan", step_index=2, outline_confirmed=True))
    ota.tools = worker.select_tools(ota, context)
    verdicts = [CallVerdict(id=call.call_id, tool=call.tool, verdict="allow") for call in calls]
    resolved = await worker._check_action_legality(ota, context, calls, verdicts, AmphiAgent())
    assert all(verdict.verdict == "allow" for verdict in resolved)
