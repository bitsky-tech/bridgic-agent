from src.amphi_agent import AmphiContext
from src.amphi_agent.cognitive import ClarifyThink, ExploreThink, GenerateThink, VerifyThink
from src.amphi_agent._workflows import WorkflowLibrary
from tests._support.sandbox import IsolatedPaths
from tests.agent.cognitive._harness import (
    USER_ID,
    make_session,
    make_workspace,
    tool_call,
    write_workflow_source,
)


async def test_build_gates(test_sandbox: IsolatedPaths) -> None:
    """Final Build handoff decisions:

    {
      "clarify": {
        "missing_task": "blocked",
        "malformed_diagram": "blocked",
        "reviewed_task": "confirmable"
      },
      "explore": {"missing_plan": "blocked", "written_plan": "generate_allowed"},
      "generate": {"invalid_package": "blocked", "valid_package": "verify_allowed"},
      "verify": {"missing_or_failed_report": "blocked", "passing_report": "confirmable"}
    }

    Checks:
    1. Clarify requires a structurally valid task before confirmation.
    2. Explore hands off only after a valid implementation plan exists.
    3. Generate hands off only after the Workflow package is executable and validatable.
    4. Verify requests final confirmation only after a valid report ends in PASS.
    """
    workspace = make_workspace(test_sandbox, "build-gates")
    build = await workspace.prepare_build_space("create", stage="clarify")
    workflows = WorkflowLibrary(USER_ID)
    workflows.open_package(build.root)
    context = AmphiContext(
        session=make_session(workspace.session_root),
        workflows=workflows,
        workspace=workspace,
    )
    clarify = ClarifyThink()
    confirm_task = tool_call("request_human_task_confirm")

    def write(name: str, body: str) -> None:
        (build.root / name).write_text(body, encoding="utf-8")

    # Check 1: Clarify requires a valid task before confirmation.
    assert "write task.md" in (await clarify.legality_check(confirm_task, None, context) or "")
    write(
        "task.md",
        """# Report workflow

## Goal
Create the requested report.

```mermaid
flowchart TD
Input -->
```
""",
    )
    assert "connector without nodes" in (
        await clarify.legality_check(confirm_task, None, context) or ""
    )
    write(
        "task.md",
        """# Report workflow

## Goal
Create the requested report.

## Task
Read the supplied source material and create a report.

## Workflow
Collect the inputs, prepare the report, and deliver it.

## Final deliverables
A report containing the requested summary.
""",
    )
    assert await clarify.legality_check(confirm_task, None, context) is None
    assert "reviewed by the user" in (
        await clarify.legality_check(
            tool_call("switch", mode="build", stage="explore"),
            None,
            context,
        ) or ""
    )

    # Check 2: Explore hands off only after a valid implementation plan exists.
    explore = ExploreThink()
    generate = tool_call("switch", mode="build", stage="generate")
    assert "write explore.md" in (await explore.legality_check(generate, None, context) or "")
    write(
        "explore.md",
        """# Implementation plan

## Steps
Read the input, create the report, and validate its contents.
""",
    )
    assert await explore.legality_check(generate, None, context) is None

    # Check 3: Generate hands off only after the Workflow package is executable and validatable.
    generate_worker = GenerateThink()
    verify = tool_call("switch", mode="build", stage="verify")
    assert "workflow/ is missing" in (
        await generate_worker.legality_check(verify, None, context) or ""
    )
    write_workflow_source(build.root)
    assert await generate_worker.legality_check(verify, None, context) is None

    # Check 4: Verify requests final confirmation only after a valid report ends in PASS.
    verify_worker = VerifyThink()
    confirm_workflow = tool_call("request_human_workflow_confirm")
    assert "write verify.md" in (
        await verify_worker.legality_check(confirm_workflow, None, context) or ""
    )
    write(
        "verify.md",
        """# Verification

The isolated checks completed, but one Workflow check failed.

## Overall verdict
FAIL
""",
    )
    assert "followed by `PASS`" in (
        await verify_worker.legality_check(confirm_workflow, None, context) or ""
    )
    write(
        "verify.md",
        """# Verification

The isolated checks completed successfully.

## Overall verdict
PASS
""",
    )
    assert await verify_worker.legality_check(confirm_workflow, None, context) is None
