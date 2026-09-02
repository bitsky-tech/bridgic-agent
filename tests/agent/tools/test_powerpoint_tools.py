import json
from pathlib import Path
from typing import Any

import pytest

from src.amphi_agent._powerpoint import (
    PowerPointAsset,
    PowerPointDiagnostic,
    PowerPointPage,
    PowerPointPageSnapshot,
    PowerPointPageView,
    PowerPointWriteResult,
)
from src.amphi_agent.tools._powerpoint import (
    edit_ppt_page,
    get_ppt_page,
    goto_ppt_page,
    insert_ppt_element,
    insert_ppt_page,
    move_ppt_page,
    powerpoint_tool_specs,
    remove_ppt_element,
    remove_ppt_page,
    update_ppt_design,
    view_ppt,
)
from tests.agent.tools._harness import ToolHarness


def _page(revision: str = "page-v1") -> PowerPointPage:
    return PowerPointPage(
        page_id="page-a",
        index=0,
        revision=revision,
        title="Page A",
    )


def _snapshot(markdown: str = '<PptText ref="title">Page</PptText>\n', revision: str = "page-v1") -> PowerPointPageSnapshot:
    return PowerPointPageSnapshot(
        page_id="page-a",
        base_revision=revision,
        markdown=markdown,
        asset_paths=("assets/figure.png",),
        refs=("title",),
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
            snapshot=_snapshot(),
            assets=(PowerPointAsset(path="assets/figure.png", mime_type="image/png"),),
        )

    async def edit_page(self, page_id: str, ref: str, replacement: str) -> PowerPointWriteResult:
        self.calls.append(("edit", (page_id, ref, replacement)))
        return PowerPointWriteResult(
            status="ready",
            page=_page("page-v2"),
            diagnostics=(PowerPointDiagnostic(code="layout-ok", message="Layout is valid", severity="info"),),
            element_ref=ref,
        )

    async def insert_element(self, page_id: str, element: str) -> PowerPointWriteResult:
        self.calls.append(("insert-element", (page_id, element)))
        return PowerPointWriteResult(status="ready", page=_page("page-v2"), element_ref="new-element")

    async def remove_element(self, page_id: str, ref: str) -> PowerPointWriteResult:
        self.calls.append(("remove-element", (page_id, ref)))
        return PowerPointWriteResult(status="ready", page=_page("page-v2"), element_ref=ref)

    async def update_design(self, design: dict[str, Any]) -> Any:
        self.calls.append(("design", design))
        return {"identity": {"file_name": "deck.pptx"}, "meta": {"theme": design}, "pages": []}

    async def insert_page(self, markdown: str, after_page_id: str | None = None) -> PowerPointWriteResult:
        self.calls.append(("insert", (markdown, after_page_id)))
        return PowerPointWriteResult(status="ready", page=_page())

    async def remove_page(self, page_id: str) -> Any:
        self.calls.append(("remove", page_id))
        return {"removed": page_id}

    async def move_page(self, page_id: str, target_page_id: str, position: str) -> Any:
        self.calls.append(("move", (page_id, target_page_id, position)))
        return {"moved": page_id}

    async def goto_page(self, page_id: str) -> Any:
        self.calls.append(("goto", page_id))
        return {"visible": page_id}


def test_powerpoint_tool_surface_has_page_and_document_tools_without_revision() -> None:
    schemas = {spec.tool_name: spec.tool_parameters for spec in powerpoint_tool_specs}
    assert set(schemas) == {
        "view_ppt",
        "get_ppt_page",
        "update_ppt_design",
        "edit_ppt_page",
        "insert_ppt_element",
        "remove_ppt_element",
        "insert_ppt_page",
        "remove_ppt_page",
        "move_ppt_page",
        "goto_ppt_page",
    }
    assert all("revision" not in schema.get("properties", {}) for schema in schemas.values())
    assert set(schemas["edit_ppt_page"]["properties"]) == {"page_id", "ref", "replacement"}
    assert set(schemas["insert_ppt_element"]["properties"]) == {"page_id", "element"}
    assert set(schemas["remove_ppt_element"]["properties"]) == {"page_id", "ref"}

async def test_powerpoint_tools_use_the_page_level_session_contract(tool_harness: ToolHarness) -> None:
    powerpoint = _RecordingPowerPoint()
    tool_harness.context.powerpoint = powerpoint  # type: ignore[assignment]
    workspace = Path(tool_harness.workspace.work_dir).resolve()

    assert json.loads(await view_ppt("deck"))["identity"]["file_name"] == "deck.pptx"
    page_source = await get_ppt_page("page-a")
    assert "revision" not in page_source
    assert '"path": "assets/figure.png"' in page_source
    assert page_source.endswith('<PptText ref="title">Page</PptText>\n')
    assert json.loads(await update_ppt_design(
        theme="midnight", show_slide_number=True, transition_through_black=True,
    ))["meta"]["theme"] == {
        "theme": "midnight",
        "footer": {"show_slide_number": True},
        "transition": {"through_black": True},
    }
    replacement = '<PptText ref="title">Updated</PptText>'
    assert json.loads(await edit_ppt_page("page-a", "title", replacement))["ref"] == "title"
    assert json.loads(await insert_ppt_element("page-a", "<PptShape kind=\"rect\" />"))["ref"] == "new-element"
    assert json.loads(await remove_ppt_element("page-a", "title"))["ref"] == "title"
    assert json.loads(await insert_ppt_page("# Inserted\n", "page-a"))["status"] == "ready"
    assert json.loads(await remove_ppt_page("page-a")) == {"removed": "page-a"}
    assert json.loads(await move_ppt_page("page-a", "page-b", "after")) == {"moved": "page-a"}
    assert json.loads(await goto_ppt_page("page-a")) == {"visible": "page-a"}
    assert powerpoint.calls == [
        ("view", str(workspace / "deck.pptx")),
        ("read", "page-a"),
        ("design", {
            "theme": "midnight",
            "footer": {"show_slide_number": True},
            "transition": {"through_black": True},
        }),
        ("edit", ("page-a", "title", replacement)),
        ("insert-element", ("page-a", "<PptShape kind=\"rect\" />")),
        ("remove-element", ("page-a", "title")),
        ("insert", ("# Inserted\n", "page-a")),
        ("remove", "page-a"),
        ("move", ("page-a", "page-b", "after")),
        ("goto", "page-a"),
    ]


async def test_powerpoint_page_writes_reject_empty_and_oversized_markdown(tool_harness: ToolHarness) -> None:
    tool_harness.context.powerpoint = _RecordingPowerPoint()  # type: ignore[assignment]

    with pytest.raises(ValueError, match="non-empty"):
        await edit_ppt_page("page-a", "title", "  ")
    with pytest.raises(ValueError, match="per-element limit"):
        await insert_ppt_element("page-a", "x" * (64 * 1024 + 1))
    with pytest.raises(ValueError, match="per-page limit"):
        await insert_ppt_page("x" * (64 * 1024 + 1))
