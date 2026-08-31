import json
from pathlib import Path
from typing import Any

import pytest

from src.amphi_agent._powerpoint import (
    PowerPointAsset,
    PowerPointDiagnostic,
    PowerPointPage,
    PowerPointPageView,
    PowerPointWriteResult,
)
from src.amphi_agent.tools._powerpoint import (
    get_ppt_page,
    goto_ppt_page,
    insert_ppt_page,
    move_ppt_page,
    powerpoint_tool_specs,
    remove_ppt_page,
    update_ppt_page,
    view_ppt,
)
from tests.agent.tools._harness import ToolHarness


def _page(markdown: str = "# Page\n", revision: str = "page-v1") -> PowerPointPage:
    return PowerPointPage(
        page_id="page-a",
        index=0,
        revision=revision,
        markdown=markdown,
        title="Page A",
        asset_paths=("assets/figure.png",),
    )


class _RecordingPowerPoint:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def view_ppt(self, target: str) -> Any:
        self.calls.append(("view", target))
        return {"identity": {"file_name": Path(target).name}, "pages": []}

    async def read_page(self, page_id: str) -> PowerPointPageView:
        self.calls.append(("read", page_id))
        return PowerPointPageView(
            page=_page(),
            assets=(PowerPointAsset(path="assets/figure.png", mime_type="image/png"),),
        )

    async def update_page(self, page_id: str, markdown: str) -> PowerPointWriteResult:
        self.calls.append(("update", (page_id, markdown)))
        return PowerPointWriteResult(
            status="ready",
            page=_page(markdown, "page-v2"),
            diagnostics=(PowerPointDiagnostic(code="layout-ok", message="Layout is valid", severity="info"),),
        )

    async def insert_page(self, markdown: str, after_page_id: str | None = None) -> PowerPointWriteResult:
        self.calls.append(("insert", (markdown, after_page_id)))
        return PowerPointWriteResult(status="ready", page=_page(markdown))

    async def remove_page(self, page_id: str) -> Any:
        self.calls.append(("remove", page_id))
        return {"removed": page_id}

    async def move_page(self, page_id: str, target_page_id: str, position: str) -> Any:
        self.calls.append(("move", (page_id, target_page_id, position)))
        return {"moved": page_id}

    async def goto_page(self, page_id: str) -> Any:
        self.calls.append(("goto", page_id))
        return {"visible": page_id}


def test_powerpoint_tool_surface_has_seven_page_level_tools_without_revision() -> None:
    schemas = {spec.tool_name: spec.tool_parameters for spec in powerpoint_tool_specs}
    assert set(schemas) == {
        "view_ppt",
        "get_ppt_page",
        "update_ppt_page",
        "insert_ppt_page",
        "remove_ppt_page",
        "move_ppt_page",
        "goto_ppt_page",
    }
    assert all("revision" not in schema.get("properties", {}) for schema in schemas.values())

async def test_powerpoint_tools_use_the_page_level_session_contract(tool_harness: ToolHarness) -> None:
    powerpoint = _RecordingPowerPoint()
    tool_harness.context.powerpoint = powerpoint  # type: ignore[assignment]
    workspace = Path(tool_harness.workspace.work_dir).resolve()

    assert json.loads(await view_ppt("deck"))["identity"]["file_name"] == "deck.pptx"
    page_source = await get_ppt_page("page-a")
    assert "revision" not in page_source
    assert '"path": "assets/figure.png"' in page_source
    assert page_source.endswith("# Page\n")
    assert "revision" not in json.loads(await update_ppt_page("page-a", "# Updated\n",))["page"]
    assert json.loads(await insert_ppt_page("# Inserted\n", "page-a"))["status"] == "ready"
    assert json.loads(await remove_ppt_page("page-a")) == {"removed": "page-a"}
    assert json.loads(await move_ppt_page("page-a", "page-b", "after")) == {"moved": "page-a"}
    assert json.loads(await goto_ppt_page("page-a")) == {"visible": "page-a"}
    assert powerpoint.calls == [
        ("view", str(workspace / "deck.pptx")),
        ("read", "page-a"),
        ("update", ("page-a", "# Updated\n")),
        ("insert", ("# Inserted\n", "page-a")),
        ("remove", "page-a"),
        ("move", ("page-a", "page-b", "after")),
        ("goto", "page-a"),
    ]


async def test_powerpoint_page_writes_reject_empty_and_oversized_markdown(tool_harness: ToolHarness) -> None:
    tool_harness.context.powerpoint = _RecordingPowerPoint()  # type: ignore[assignment]

    with pytest.raises(ValueError, match="non-empty"):
        await update_ppt_page("page-a", "  ")
    with pytest.raises(ValueError, match="per-page limit"):
        await insert_ppt_page("x" * (64 * 1024 + 1))
