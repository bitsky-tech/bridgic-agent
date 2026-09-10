"""Protect tool contracts and dependency boundaries across business packages."""

import ast
import hashlib
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from src.amphi_agent import AmphiContext, AmphiOTAContext, MainThink, Session, tools
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.cognitive import (
    ClarifyThink,
    ExploreThink,
    GenerateThink,
    PresentationBriefThink,
    PresentationComposeThink,
    PresentationPlanThink,
    PresentationReviewThink,
    SubAgentThink,
    VerifyThink,
    WorkflowThink,
)
from src.amphi_agent.tools._switch import switch_tool
from src.amphi_agent.tools.powerpoint import powerpoint_tool_specs
from src.amphi_store import SessionRecord


# Captured before moving definitions, including descriptions and registration order.
BASELINE = json.loads((Path(__file__).parent / "fixtures" / "tool_contracts.json").read_text())
CASES = {
    "main": (MainThink, {"mode": "normal", "stage": "main"}),
    "child": (SubAgentThink, {"mode": "normal", "stage": "main"}),
    "clarify": (ClarifyThink, {"mode": "build", "stage": "clarify"}),
    "explore": (ExploreThink, {"mode": "build", "stage": "explore"}),
    "generate": (GenerateThink, {"mode": "build", "stage": "generate"}),
    "verify": (VerifyThink, {"mode": "build", "stage": "verify"}),
    "execute": (WorkflowThink, {
        "mode": "run_workflow", "stage": "execute",
        "workflow_id": "workflow-a", "generation": "generation-a",
    }),
    "ppt_brief": (PresentationBriefThink, {"mode": "presentation", "stage": "ppt_brief"}),
    "ppt_plan": (PresentationPlanThink, {"mode": "presentation", "stage": "ppt_plan"}),
    "ppt_compose": (PresentationComposeThink, {"mode": "presentation", "stage": "ppt_compose"}),
    "ppt_review": (PresentationReviewThink, {"mode": "presentation", "stage": "ppt_review"}),
    "ppt_plan_confirmed": (PresentationPlanThink, {
        "mode": "presentation", "stage": "ppt_plan", "step_index": 2,
        "outline_confirmed": True,
    }),
    "ppt_plan_pending": (PresentationPlanThink, {
        "mode": "presentation", "stage": "ppt_plan", "step_index": 2,
        "outline_confirmed": True, "template_selection_status": "pending",
    }),
}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def test_ppt_rag_module_supports_dependency_replacement(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dotted imports expose the module while the root tool API keeps its function."""
    import src.amphi_agent.tools.powerpoint.ppt_rag as rag_module

    assert isinstance(rag_module, ModuleType)
    assert tools.ppt_rag is rag_module.ppt_rag
    assert tools.ppt_rag_tool is rag_module.ppt_rag_tool

    catalog = object()
    monkeypatch.setattr(
        "src.amphi_agent.tools.powerpoint.ppt_rag.get_ppt_template_catalog",
        lambda: catalog,
    )
    assert rag_module.get_ppt_template_catalog() is catalog


def test_catalog_preserves_schemas_and_registration_order() -> None:
    """Descriptions, parameters, defaults, and catalog order are unchanged."""
    assert tools.__all__ == BASELINE["exports"]
    for key, specs in (
        ("registered_schemas", TOOL_LIBRARY.all()),
        ("dormant_schemas", powerpoint_tool_specs),
    ):
        assert [spec.tool_name for spec in specs] == list(BASELINE[key])
        for spec in specs:
            assert _digest(spec.to_tool().model_dump()) == BASELINE[key][spec.tool_name], spec.tool_name
    assert _digest(switch_tool.to_tool().model_dump()) == BASELINE["switch_schema"]
    assert TOOL_LIBRARY.select(BASELINE["dormant_schemas"]) == []


@pytest.mark.parametrize("profile, expected", BASELINE["surfaces"].items())
def test_stage_tool_visibility_and_order_match_the_contract(profile: str, expected: str) -> None:
    """Each stage keeps its ordered tools, with Build and Run entry reserved for Main."""
    label, flags = profile.split(":")
    worker_type, state = CASES[label]
    context = AmphiContext(session=Session(SessionRecord(
        id="session-tools",
        user_id="local",
        workspace_root="/sessions/session-tools",
        parent_session_id="root-session" if label == "child" else None,
    ), []))
    ota_context = AmphiOTAContext(user_input="Inspect tools", state={"think": state})
    for flag, enabled in zip(
        ("browser_tool_loaded", "workspace_tools_loaded", "skills_tool_loaded"), flags,
    ):
        setattr(ota_context, flag, enabled == "1")
    names = [spec.tool_name for spec in worker_type().select_tools(ota_context, context)]
    entry_tools = {"request_build", "request_run_workflow"}
    assert entry_tools.intersection(names) == (entry_tools if label == "main" else set())
    assert _digest(names) == expected, names


def test_common_tools_do_not_import_business_packages() -> None:
    """Only the root aggregator may import business tools."""
    root = Path(tools.__file__).parent
    forbidden = tuple(
        f"{tools.__name__}.{path.stem}"
        for path in root.iterdir()
        if path.is_dir() and (path / "__init__.py").is_file()
    )
    for path in root.glob("*.py"):
        if path.name == "__init__.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                dependencies = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                origin = "." * node.level + (node.module or "")
                module = importlib.util.resolve_name(origin, tools.__name__)
                dependencies = [module, *(f"{module}.{alias.name}" for alias in node.names)]
            else:
                continue
            for dependency in dependencies:
                assert not any(
                    dependency == owner or dependency.startswith(f"{owner}.")
                    for owner in forbidden
                ), f"Common tool {path.name} imports business tool {dependency}"
