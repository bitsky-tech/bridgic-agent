from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest
from bridgic.amphibious.builtin_tools import current_agent

from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.tools._workflow import (
    WorkflowToolRejection,
    remove_workflow,
    remove_workflow_tool,
)


class FakeWorkflowLibrary:
    def __init__(self, *, deleted: bool = True) -> None:
        self.deleted = deleted
        self.calls: list[str] = []
        self.package = SimpleNamespace(name="Weekly report")

    def get(self, workflow_id: str):
        return self.package if workflow_id == "wf_report" else None

    async def delete(self, workflow_id: str) -> bool:
        self.calls.append(workflow_id)
        return self.deleted


def test_remove_workflow_schema_and_registration() -> None:
    assert inspect.iscoroutinefunction(remove_workflow)
    assert remove_workflow_tool.tool_parameters["required"] == ["workflow_id"]
    assert "remove_workflow" in {tool.tool_name for tool in TOOL_LIBRARY.all()}


async def test_remove_workflow_uses_the_bound_domain_library() -> None:
    workflows = FakeWorkflowLibrary()
    token = current_agent.set(SimpleNamespace(ctx=SimpleNamespace(workflows=workflows)))
    try:
        result = await remove_workflow("  wf_report  ")
    finally:
        current_agent.reset(token)

    assert workflows.calls == ["wf_report"]
    assert "Weekly report" in result
    assert "wf_report" in result
    assert "saved source package" in result
    assert "Run results were retained" in result


async def test_remove_workflow_rejects_invalid_or_unavailable_targets() -> None:
    with pytest.raises(WorkflowToolRejection, match="must be non-empty"):
        await remove_workflow("  ")

    token = current_agent.set(SimpleNamespace(ctx=SimpleNamespace(workflows=None)))
    try:
        with pytest.raises(WorkflowToolRejection, match="catalogue is unavailable"):
            await remove_workflow("wf_report")
    finally:
        current_agent.reset(token)

    workflows = FakeWorkflowLibrary(deleted=False)
    token = current_agent.set(SimpleNamespace(ctx=SimpleNamespace(workflows=workflows)))
    try:
        with pytest.raises(WorkflowToolRejection, match="Workflow `wf_missing` is unavailable"):
            await remove_workflow("wf_missing")
    finally:
        current_agent.reset(token)
