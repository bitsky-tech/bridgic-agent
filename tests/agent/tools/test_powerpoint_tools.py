import json
from pathlib import Path
from typing import Any

from src.amphi_agent.tools.powerpoint import (
    powerpoint_tool_specs,
    ppt_edit_page,
    ppt_inspect,
    ppt_manage_deck,
    ppt_open,
    ppt_read_deck,
    ppt_read_page,
    ppt_save,
)
from tests.agent.tools._harness import ToolHarness


class _RecordingPowerPoint:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def open(self, target: str) -> Any:
        self.calls.append(("open", target))
        return {"revision": "open-v1", "deck": {"id": "deck-1", "file_name": Path(target).name}}

    async def read_deck(self, document_id: str, query: Any) -> Any:
        self.calls.append(("read_deck", (document_id, query)))
        return {"revision": "deck-v1", "deck": {"id": document_id, "document_revision": "nested-v1"}}

    async def read_page(self, document_id: str, page_id: str, query: Any) -> Any:
        self.calls.append(("read_page", (document_id, page_id, query)))
        return {
            "revision": "page-v1",
            "page": {"id": page_id, "revision": "nested-page-v1", "markdown": '<PptText ref="title">Page</PptText>'},
        }

    async def edit_page(self, document_id: str, page_id: str, operations: Any, options: Any) -> Any:
        self.calls.append(("edit_page", (document_id, page_id, operations, options)))
        return {"status": "ready", "revision": "page-v2", "deck_revision": "deck-v2", "changed_page_ids": [page_id]}

    async def manage_deck(self, document_id: str, operations: Any, options: Any) -> Any:
        self.calls.append(("manage_deck", (document_id, operations, options)))
        return {"status": "ready", "revision": "deck-v2", "changed_page_ids": ["new-page"]}

    async def inspect(self, document_id: str, query: Any) -> Any:
        self.calls.append(("inspect", (document_id, query)))
        return {
            "kind": "render", "document_revision": 2,
            "renders": [{"page_id": "page-a", "revision": "page-v2", "path": "/workspace/page-a.png"}],
        }

    async def save(self, document_id: str, target: Any) -> Any:
        self.calls.append(("save", (document_id, target)))
        return {"status": "saved", "document_id": document_id, "target": target or "deck.pptx"}


def test_powerpoint_tool_surface_uses_structured_domain_commands() -> None:
    schemas = {spec.tool_name: spec.tool_parameters for spec in powerpoint_tool_specs}
    assert set(schemas) == {
        "ppt_open", "ppt_read_deck", "ppt_read_page", "ppt_inspect",
        "ppt_edit_page", "ppt_manage_deck", "ppt_save",
    }
    page_operations = schemas["ppt_edit_page"]["properties"]["operations"]
    deck_operations = schemas["ppt_manage_deck"]["properties"]["operations"]
    assert {variant["properties"]["type"]["const"] for variant in page_operations["items"]["oneOf"]} == {
        "set-page", "add", "patch", "remove", "reorder", "add-comment", "patch-comment", "remove-comment",
    }
    assert {variant["properties"]["type"]["const"] for variant in deck_operations["items"]["oneOf"]} == {
        "set-design", "insert-page", "duplicate-page", "remove-page", "move-page",
    }
    assert "markdown" not in schemas["ppt_edit_page"]["properties"]
    add_operation = next(
        variant for variant in page_operations["items"]["oneOf"]
        if variant["properties"]["type"]["const"] == "add"
    )
    element_schema = add_operation["properties"]["element"]
    assert {"text", "image", "audio", "video", "table", "chart"}.issubset(
        element_schema["properties"]["type"]["enum"]
    )
    assert "src" in element_schema["properties"]
    patch_variants = [
        variant for variant in page_operations["items"]["oneOf"]
        if variant["properties"]["type"]["const"] == "patch"
    ]
    assert len(patch_variants) == 1
    assert all("element_type" in variant["required"] for variant in patch_variants)
    group_id_schema = patch_variants[0]["properties"]["patch"]["properties"]["groupId"]
    assert {"type": "null"} in group_id_schema["anyOf"]


async def test_powerpoint_tools_use_the_session_capability(tool_harness: ToolHarness) -> None:
    powerpoint = _RecordingPowerPoint()
    tool_harness.context.powerpoint = powerpoint  # type: ignore[assignment]
    workspace = Path(tool_harness.workspace.work_dir).resolve()
    page_ops = [{"type": "patch", "id": "title", "element_type": "text", "patch": {"text": "Updated"}}]
    deck_ops = [{"type": "insert-page", "page": {"id": "new-page"}}]

    opened = json.loads(await ppt_open("deck"))
    deck = json.loads(await ppt_read_deck("deck-1", {"include_theme": True}))
    page = json.loads(await ppt_read_page("deck-1", "page-a", {"format": "both"}))
    assert opened["deck"]["file_name"] == "deck.pptx"
    assert "revision" not in opened
    assert "revision" not in deck
    assert "document_revision" not in deck["deck"]
    assert "revision" not in page
    assert "revision" not in page["page"]
    edited = json.loads(await ppt_edit_page("deck-1", "page-a", page_ops))
    managed = json.loads(await ppt_manage_deck("deck-1", deck_ops, {"validate_only": True}))
    inspected = json.loads(await ppt_inspect("deck-1", {"kind": "render"}))
    assert edited["status"] == "ready"
    assert "revision" not in edited and "deck_revision" not in edited
    assert managed["status"] == "ready"
    assert "revision" not in managed
    assert inspected["renders"][0]["page_id"] == "page-a"
    assert "document_revision" not in inspected
    assert "revision" not in inspected["renders"][0]
    assert json.loads(await ppt_save("deck-1"))["status"] == "saved"
    assert powerpoint.calls == [
        ("open", str(workspace / "deck.pptx")),
        ("read_deck", ("deck-1", {"include_theme": True})),
        ("read_page", ("deck-1", "page-a", {"format": "both"})),
        ("edit_page", ("deck-1", "page-a", page_ops, None)),
        ("manage_deck", ("deck-1", deck_ops, {"validate_only": True})),
        ("inspect", ("deck-1", {"kind": "render"})),
        ("save", ("deck-1", None)),
    ]
