"""Keep Session and Workflow permission boundaries intact across worker dispatch."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.amphi_agent._workspace import Workspace
from src.amphi_agent.cognitive import base as cognitive_base
from src.amphi_agent.cognitive.normal.state import NormalStageState
from src.amphi_agent.cognitive.state import CallVerdict
from src.amphi_agent.security import LlmSafetyClassifier
from src.amphi_store import SessionMountRecord, UserInput
from tests.agent.core.test_action_boundary import _call
from tests.agent.core.test_orchestration import _Harness, _save_workflow, _start_run, orchestration as orchestration_fixture


orchestration = orchestration_fixture


@pytest.mark.parametrize(("mode", "explicit_mode", "expected_mode"), [
    pytest.param("normal", None, "request", id="normal-with-retained-run"),
    pytest.param("workflow", None, "full", id="workflow-mode-override"),
    pytest.param("workflow", "request", "request", id="explicit-round-mode"),
])
async def test_permission_context_preserves_active_mode_boundaries(
    orchestration: _Harness,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    explicit_mode: str | None,
    expected_mode: str,
) -> None:
    """A retained Run grants its pinned inputs only while its execution worker is active."""
    external_root = orchestration.paths.root / "mounted-reference"
    current_input_run = SimpleNamespace(
        result_dir=orchestration.paths.root / "current-input-run" / "result",
        background_work_dir=orchestration.paths.root / "current-input-run" / "background" / "work",
    )
    saved_input_run = SimpleNamespace(
        result_dir=orchestration.paths.root / "saved-input-run" / "result",
        background_work_dir=orchestration.paths.root / "saved-input-run" / "background" / "work",
    )
    mounts = [
        SessionMountRecord(
            id=f"mount-{index}",
            session_id=orchestration.record.id,
            user_id=orchestration.record.user_id,
            name=path.name,
            abs_path=str(path),
            kind="folder",
        )
        for index, path in enumerate([
            external_root,
            current_input_run.result_dir,
            external_root,
        ])
    ]
    workspace = Workspace(orchestration.record.id, orchestration.workspace.session_root, mounts)
    harness = replace(orchestration, workspace=workspace)
    harness.context.workspace = workspace
    harness.context.execution_mode = "request"
    saved = await _save_workflow(harness, "permission-context")
    original_input = UserInput(text="Create the report using the original Run reference.")
    ota_context = await _start_run(harness, saved.workflow_id, original_input)
    assert workspace.run_workflow is not None
    active_run = harness.workflow_runs.require_run_workflow(workspace.run_workflow.root)
    pinned_source = harness.workflows.require_package(active_run.source_dir).source_root
    assert pinned_source != saved.source_root

    current_input = UserInput(text="Use the current Run reference for this follow-up.")
    ota_context.user_input = current_input
    if mode == "normal":
        ota_context.transition_think(NormalStageState())

    def referenced_runs(user_input: UserInput) -> list[SimpleNamespace]:
        if user_input == current_input:
            return [current_input_run, current_input_run]
        assert user_input == original_input
        return [saved_input_run, current_input_run, saved_input_run]

    monkeypatch.setattr(harness.workflow_runs, "referenced_runs", referenced_runs)
    bound_llm = object()
    monkeypatch.setattr(harness.agent, "_llm", bound_llm)
    worker = harness.agent._current_think_worker(ota_context, harness.context)
    monkeypatch.setattr(worker, "_llm", object())
    calls = [
        _call("read-current-result", "read_file", file_path=str(current_input_run.result_dir / "report.md")),
        _call("read-mounted-file", "read_file", file_path=str(external_root / "notes.md")),
    ]
    engine_verdicts = [
        CallVerdict(
            id=f"engine-generated-{index}",
            tool=call.tool,
            arguments={argument.name: argument.value for argument in call.tool_arguments},
            verdict=verdict,
        )
        for index, (call, verdict) in enumerate(zip(calls, ["allow", "ask"]))
    ]
    engine = SimpleNamespace(evaluate=AsyncMock(return_value=engine_verdicts))
    engine_factory = Mock(return_value=engine)
    monkeypatch.setattr(cognitive_base, "PermissionEngine", engine_factory)

    verdicts = await harness.agent.permission_check(
        ota_context, harness.context, calls, execution_mode=explicit_mode,
    )

    engine_factory.assert_called_once()
    args, options = engine_factory.call_args
    assert args == (str(workspace.work_dir),)
    expected_roots = [
        str(external_root),
        str(current_input_run.result_dir),
        str(current_input_run.background_work_dir),
    ]
    if mode == "workflow":
        expected_roots += [
            str(pinned_source),
            str(saved_input_run.result_dir),
            str(saved_input_run.background_work_dir),
        ]
    assert options["mount_roots"] == expected_roots
    assert options["mode"] == expected_mode
    assert options["audit_dir"] == workspace.permission_dir
    classifier = options["classifier"]
    assert isinstance(classifier, LlmSafetyClassifier)
    assert classifier._llm is harness.agent.llm is bound_llm
    assert classifier._audit_dir == workspace.permission_dir
    engine.evaluate.assert_awaited_once()
    assert engine.evaluate.call_args.args[0] is calls
    assert engine.evaluate.call_args.args[1] == [current_input.text]
    assert [verdict.id for verdict in verdicts] == [call.call_id for call in calls]
    assert [verdict.verdict for verdict in verdicts] == ["allow", "ask"]
    assert [verdict.arguments for verdict in verdicts] == [verdict.arguments for verdict in engine_verdicts]
    assert [verdict.id for verdict in engine_verdicts] == ["engine-generated-0", "engine-generated-1"]
