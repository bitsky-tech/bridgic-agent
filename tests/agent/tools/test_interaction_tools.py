import json

import pytest

from src.amphi_agent.tools._help import help as product_help
from src.amphi_agent.tools._request_human import (
    RequestHumanRejection,
    request_build,
    request_human_choice,
    request_human_task_confirm,
    request_human_workflow_confirm,
    request_run_workflow,
)
from src.amphi_agent.tools._subagent import run_subagent, start_subagent
from src.amphi_agent.tools._switch import switch


async def test_build_request() -> None:
    """Final Build decisions:

    {
      "ask": {"goal": "Create a review workflow", "reason": "This repeats", "request_id": "assigned"},
      "start": {"goal": "Create now", "request_id": null}
    }

    Checks:
    1. An ask request trims its content and receives a correlation identity.
    2. An explicit start enters Build without creating a confirmation identity.
    3. An empty Build goal is rejected instead of creating an unusable request.
    """
    # Check 1: An ask request trims its content and receives a correlation identity.
    ask = await request_build("  Create a review workflow  ", reason="  This repeats  ")
    assert (ask.goal, ask.mode, ask.reason) == ("Create a review workflow", "ask", "This repeats")
    assert ask.request_id.startswith("build_confirm_")

    # Check 2: An explicit start enters Build without creating a confirmation identity.
    start = await request_build(" Create now ", mode="start")
    assert (start.goal, start.mode, start.reason, start.request_id) == ("Create now", "start", None, None)

    # Check 3: An empty Build goal is rejected instead of creating an unusable request.
    with pytest.raises(RequestHumanRejection, match="goal.*non-empty"):
        await request_build("  ")


async def test_workflow_request() -> None:
    """Final Workflow entry decisions:

    {
      "start": {"workflow_id": "workflow-1", "reason": null},
      "ask": {"workflow_id": "workflow-1", "reason": "Continue the pinned run?"}
    }

    Checks:
    1. Direct Run actions preserve the selected Workflow and omit blank reasons.
    2. An ambiguous Run action carries the explanation needed by the user.
    3. Missing identifiers, missing ask reasons, and oversized reasons are rejected.
    """
    # Check 1: Direct Run actions preserve the selected Workflow and omit blank reasons.
    direct = await request_run_workflow(" workflow-1 ", action="start")
    assert (direct.workflow_id, direct.action, direct.reason) == ("workflow-1", "start", None)

    # Check 2: An ambiguous Run action carries the explanation needed by the user.
    ask = await request_run_workflow("workflow-1", action="ask", reason=" Continue the pinned run? ")
    assert (ask.action, ask.reason) == ("ask", "Continue the pinned run?")

    # Check 3: Missing identifiers, missing ask reasons, and oversized reasons are rejected.
    with pytest.raises(RequestHumanRejection, match="workflow_id.*non-empty"):
        await request_run_workflow(" ")
    with pytest.raises(RequestHumanRejection, match="reason.*ambiguous"):
        await request_run_workflow("workflow-1", action="ask")
    with pytest.raises(RequestHumanRejection, match="exceeds 300"):
        await request_run_workflow("workflow-1", reason="x" * 301)


async def test_choice_card() -> None:
    """Final choice card:

    {
      "single": {"layout": "compact", "allowOther": true, "limits": [1, 1]},
      "multiple": {"layout": "review-list", "allowOther": false, "limits": [0, 2]}
    }

    Checks:
    1. A single-choice question receives compact, one-selection defaults.
    2. A multi-select question receives review-list defaults and retains previews.
    3. The surrounding Markdown prompt is trimmed and preserved with the normalized questions.
    """
    payload = json.dumps({
        "questions": [
            {
                "question": "Choose a format",
                "header": "Format",
                "options": [{"label": "Markdown"}, {"label": "HTML"}],
            },
            {
                "question": "Select checks",
                "options": [
                    {"label": "Lint", "preview": "`ruff check`"},
                    {"label": "Tests", "preview": "`pytest`"},
                ],
                "multiSelect": True,
                "allowEmpty": True,
            },
        ],
    })
    request = await request_human_choice(payload, "  The output format controls the next step.  ")
    single, multiple = request.questions

    # Check 1: A single-choice question receives compact, one-selection defaults.
    assert single == {
        "question": "Choose a format",
        "options": [{"label": "Markdown"}, {"label": "HTML"}],
        "layout": "compact",
        "multiSelect": False,
        "allowOther": True,
        "allowEmpty": False,
        "minSelections": 1,
        "maxSelections": 1,
        "header": "Format",
    }

    # Check 2: A multi-select question receives review-list defaults and retains previews.
    assert multiple["layout"] == "review-list"
    assert multiple["allowOther"] is False
    assert multiple["allowEmpty"] is True
    assert (multiple["minSelections"], multiple["maxSelections"]) == (0, 2)
    assert multiple["options"][0]["preview"] == "`ruff check`"

    # Check 3: The surrounding Markdown prompt is trimmed and preserved with the normalized questions.
    assert request.prompt == "The output format controls the next step."


async def test_choice_validation() -> None:
    """Final rejected choice cards:

    {
      "empty_prompt": "rejected",
      "one_option": "rejected",
      "duplicate_labels": "rejected",
      "invalid_limits": "rejected"
    }

    Checks:
    1. The card requires explanatory prompt text and at least two options.
    2. Duplicate labels are rejected because the response would be ambiguous.
    3. Selection bounds must agree with the selected interaction mode.
    """
    valid = {"question": "Choose", "options": [{"label": "A"}, {"label": "B"}]}

    # Check 1: The card requires explanatory prompt text and at least two options.
    with pytest.raises(RequestHumanRejection, match="prompt.*non-empty"):
        await request_human_choice(json.dumps([valid]), " ")
    with pytest.raises(RequestHumanRejection, match="at least 2 options"):
        await request_human_choice(
            json.dumps([{"question": "Choose", "options": [{"label": "A"}]}]),
            "Need a choice.",
        )

    # Check 2: Duplicate labels are rejected because the response would be ambiguous.
    duplicate = {"question": "Choose", "options": [{"label": "A"}, {"label": "A"}]}
    with pytest.raises(RequestHumanRejection, match="duplicate option labels"):
        await request_human_choice(json.dumps([duplicate]), "Need a choice.")

    # Check 3: Selection bounds must agree with the selected interaction mode.
    invalid = {**valid, "multiSelect": True, "allowEmpty": True, "minSelections": 1}
    with pytest.raises(RequestHumanRejection, match="minSelections must be 0"):
        await request_human_choice(json.dumps([invalid]), "Need a choice.")


async def test_confirmation_cards() -> None:
    """Final confirmation requests:

    {
      "task_confirm": "assigned",
      "workflow_confirm": {"default_name": "Weekly review", "summary": "Verified"}
    }

    Checks:
    1. Task confirmation receives its own stable correlation identity.
    2. Workflow confirmation parses and trims the final naming payload.
    3. A missing Workflow name is rejected.
    """
    # Check 1: Task confirmation receives its own stable correlation identity.
    task = await request_human_task_confirm()
    assert task.request_id.startswith("task_confirm_")

    # Check 2: Workflow confirmation parses and trims the final naming payload.
    workflow = await request_human_workflow_confirm(
        '{"default_name": " Weekly review ", "summary": " Verified "}',
    )
    assert (workflow.default_name, workflow.summary) == ("Weekly review", "Verified")
    assert workflow.request_id.startswith("workflow_confirm_")

    # Check 3: A missing Workflow name is rejected.
    with pytest.raises(RequestHumanRejection, match="default_name"):
        await request_human_workflow_confirm("{}")


async def test_control_signals() -> None:
    """Final Agent control signals:

    {
      "blocking_child": "Review the change",
      "background_child": "Index the files",
      "mode_switch": {"mode": "normal", "stage": null},
      "stage_switch": {"mode": null, "stage": "generate"}
    }

    Checks:
    1. Blocking and background delegation return distinct typed requests with trimmed goals.
    2. Empty Child goals are rejected before the runtime can create a Session.
    3. Switch independently preserves mode-only and stage-only handoffs.
    4. Product help exposes the durable capabilities that the user can invoke.
    """
    # Check 1: Blocking and background delegation return distinct typed requests with trimmed goals.
    blocking = await run_subagent("  Review the change  ")
    background = await start_subagent("  Index the files  ")
    assert blocking.model_dump() == {"goal": "Review the change"}
    assert background.model_dump() == {"goal": "Index the files"}
    assert type(blocking) is not type(background)

    # Check 2: Empty Child goals are rejected before the runtime can create a Session.
    with pytest.raises(ValueError, match="goal cannot be empty"):
        await run_subagent(" ")
    with pytest.raises(ValueError, match="goal cannot be empty"):
        await start_subagent(" ")

    # Check 3: Switch independently preserves mode-only and stage-only handoffs.
    mode_signal = await switch(mode="normal", reason="Build is complete")
    stage_signal = await switch(stage="generate", reason="Exploration is complete")
    assert mode_signal == {"mode": "normal", "stage": None, "reason": "Build is complete"}
    assert stage_signal == {"mode": None, "stage": "generate", "reason": "Exploration is complete"}

    # Check 4: Product help exposes the durable capabilities that the user can invoke.
    reference = await product_help()
    assert all(section in reference for section in ("# Reusable Workflows", "# Multi-Agent work", "# Scheduling"))
