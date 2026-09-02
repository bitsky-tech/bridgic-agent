import asyncio
import base64
import re
from pathlib import Path
from typing import Any

import pytest

from src.amphi_agent._powerpoint import PowerPointHost, PowerPointIdentity, PowerPointOperationError


def _overview(page_ids: tuple[str, ...] = ("cover", "history")) -> dict[str, Any]:
    return {
        "identity": {"name": "Buddhism", "file_name": "buddhism.pptx"},
        "meta": {"title": "Buddhism", "total_pages": len(page_ids)},
        "deck_revision": "deck-" + "-".join(page_ids),
        "document_revision": "document-v1",
        "pages": [
            {
                "page_id": page_id,
                "index": index,
                "title": page_id.title(),
                "revision": f"revision-{page_id}",
                "has_content": True,
            }
            for index, page_id in enumerate(page_ids)
        ],
    }


def _page(page_id: str, markdown: str, revision: str, index: int = 0) -> dict[str, Any]:
    asset_paths = ["assets/cover.png"] if page_id == "cover" and "Live" in markdown else []
    return {
        "page_id": page_id,
        "index": index,
        "title": page_id.title(),
        "revision": revision,
        "markdown": markdown,
        "asset_paths": asset_paths,
        "refs": re.findall(r'\bref="([A-Za-z0-9_.:-]+)"', markdown),
    }


class _Controller:
    controller_id = "desktop"
    generation = "generation-1"
    cdp_endpoint = "http://127.0.0.1:43101"

    def __init__(self) -> None:
        self.released: list[str] = []

    async def ensure_session(self, session_id: str) -> Any:
        return type("Surface", (), {"target_id": f"target-{session_id}"})()

    async def release_session(self, session_id: str) -> None:
        self.released.append(session_id)


class _Client:
    def __init__(self, cdp_endpoint: str) -> None:
        self.cdp_endpoint = cdp_endpoint
        self.connected: tuple[str, str] | None = None
        self.requests: list[dict[str, Any]] = []
        self.live = False
        self.elements = {
            page_id: {
                f"{page_id}-title": f'<PptText ref="{page_id}-title">Live {page_id}</PptText>',
                f"{page_id}-body": f'<PptText ref="{page_id}-body">Body {page_id}</PptText>',
            }
            for page_id in ("cover", "history")
        }

    def _page_markdown(self, page_id: str) -> str:
        return "\n\n".join(self.elements.get(page_id, {}).values()) + "\n"

    async def connect(self, target_id: str, session_id: str) -> None:
        self.connected = (target_id, session_id)
        self.live = True

    def is_live(self) -> bool:
        return self.live

    async def dispatch(self, request: dict[str, Any]) -> Any:
        self.requests.append(request)
        method = request["method"]
        params = request.get("params", {})
        if method == "view_ppt":
            return _overview(()) if params["target"].endswith("blank.pptx") else _overview()
        if method == "inspect_ppt_assets":
            return []
        if method == "get_ppt_page":
            page_id = params["page_id"]
            return {
                "page": _page(
                    page_id,
                    self._page_markdown(page_id),
                    f"revision-{page_id}",
                    0 if page_id == "cover" else 1,
                ),
                "assets": [
                    {
                        "path": "assets/cover.png",
                        "file_name": "cover.png",
                        "mime_type": "image/png",
                    }
                ] if page_id == "cover" else [],
            }
        if method == "update_ppt_design":
            overview = _overview()
            overview["meta"] = {**overview["meta"], "design": params["design"]}
            overview["document_revision"] = "document-v2"
            return overview
        if method == "edit_ppt_page":
            await asyncio.sleep(0)
            if params["replacement"] == "invalid":
                return {
                    "status": "invalid",
                    "diagnostics": [{
                        "code": "unknown-layout",
                        "message": "Unknown layout",
                        "line": 2,
                        "column": 9,
                        "suggestion": "Use timeline",
                    }],
                }
            page_id = params["page_id"]
            self.elements[page_id][params["ref"]] = params["replacement"]
            index = 0 if page_id in {"cover", "page-0"} else 1
            return {
                "status": "ready",
                "page": _page(page_id, self._page_markdown(page_id), f"{params['expected_revision']}-next", index),
                "assets": [],
                "diagnostics": [],
                "document_revision": "document-v2",
                "element_ref": params["ref"],
            }
        if method == "insert_ppt_element":
            page_id = params["page_id"]
            ref = f"{page_id}-inserted-{len(self.elements[page_id]) + 1}"
            self.elements[page_id][ref] = re.sub(
                r"^<(Ppt\w+)", rf'<\1 ref="{ref}"', params["element"].strip(), count=1,
            )
            index = 0 if page_id == "cover" else 1
            return {
                "status": "ready",
                "page": _page(page_id, self._page_markdown(page_id), f"{params['expected_revision']}-next", index),
                "assets": [],
                "diagnostics": [],
                "document_revision": "document-v2",
                "element_ref": ref,
            }
        if method == "remove_ppt_element":
            page_id = params["page_id"]
            self.elements[page_id].pop(params["ref"])
            index = 0 if page_id == "cover" else 1
            return {
                "status": "ready",
                "page": _page(page_id, self._page_markdown(page_id), f"{params['expected_revision']}-next", index),
                "assets": [],
                "diagnostics": [],
                "document_revision": "document-v2",
                "element_ref": params["ref"],
            }
        if method == "insert_ppt_page":
            overview = _overview(("cover", "inserted", "history"))
            overview.update({
                "status": "ready",
                "page": _page("inserted", params["markdown"], "revision-inserted", 1),
                "assets": [],
                "diagnostics": [],
            })
            return overview
        if method == "remove_ppt_page":
            return _overview(("history",))
        if method == "move_ppt_page":
            return _overview(("history", "cover"))
        if method == "goto_ppt_page":
            return {"page_id": params["page_id"], "visible": True}
        raise AssertionError(f"Unexpected request: {request}")

    async def disconnect(self) -> None:
        self.live = False


def _host(factory: Any = _Client) -> tuple[PowerPointHost, _Controller]:
    host = PowerPointHost(prepare_playwright=lambda: None, session_factory=factory)
    controller = _Controller()
    host._controller = controller  # type: ignore[assignment]
    host._connected_generation = controller.generation
    return host, controller


async def test_session_state_is_identity_assets_and_lazy_page_markdown() -> None:
    clients: list[_Client] = []

    def factory(cdp_endpoint: str) -> _Client:
        client = _Client(cdp_endpoint)
        clients.append(client)
        return client

    host, controller = _host(factory)
    ppt = host.for_session("session-a")
    assert ppt is host.for_session("session-a")
    assert ppt.identity == PowerPointIdentity(session_id="session-a")
    assert ppt.assets == {}
    assert ppt.ppt == ()

    info = await ppt.view_ppt("/workspace/buddhism.pptx")
    assert info["identity"]["file_name"] == "buddhism.pptx"
    assert [page["page_id"] for page in info["pages"]] == ["cover", "history"]
    assert ppt._page_snapshots == {}

    view = await ppt.read_page("cover")
    assert '<PptText ref="cover-title">Live cover</PptText>' in view.snapshot.markdown
    assert view.snapshot.base_revision == view.page.revision
    assert view.snapshot.refs == ("cover-title", "cover-body")
    assert [asset.path for asset in view.assets] == ["assets/cover.png"]
    assert ppt.page("cover") is view.page
    assert ppt._page_snapshots["cover"] is view.snapshot

    assert len(clients) == 1
    assert clients[0].connected == ("target-session-a", "session-a")

    await host.release_sessions(["session-a"])
    assert controller.released == ["session-a"]
    assert clients[0].live is False
    assert ppt.identity == PowerPointIdentity(session_id="session-a")
    assert ppt.assets == {}
    assert ppt.ppt == ()
    assert ppt._page_snapshots == {}


async def test_read_pages_can_be_edited_concurrently_and_invalid_writes_are_atomic() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/deck.pptx")
    await asyncio.gather(ppt.read_page("cover"), ppt.read_page("history"))

    first, second = await asyncio.gather(
        ppt.edit_page("cover", "cover-title", '<PptText ref="cover-title">First</PptText>'),
        ppt.edit_page("history", "history-title", '<PptText ref="history-title">Second</PptText>'),
    )
    assert first.status == second.status == "ready"
    assert {page.page_id for page in ppt.ppt} == {"cover", "history"}

    before = ppt.page("cover")
    invalid = await ppt.edit_page("cover", "cover-title", "invalid")
    assert invalid.status == "invalid"
    assert invalid.page is None
    assert invalid.diagnostics[0].line == 2
    assert ppt.page("cover") is before


async def test_edit_insert_and_remove_element_refresh_the_page_snapshot() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/deck.pptx")
    await ppt.read_page("history")

    edited = await ppt.edit_page(
        "history", "history-title", '<PptText ref="history-title">Edited history</PptText>',
    )
    inserted = await ppt.insert_element("history", '<PptShape kind="ellipse" />')
    assert inserted.element_ref is not None
    removed = await ppt.remove_element("history", inserted.element_ref)

    assert edited.element_ref == "history-title"
    assert removed.element_ref == inserted.element_ref
    assert "Edited history" in ppt._page_snapshots["history"].markdown
    assert inserted.element_ref not in ppt._page_snapshots["history"].refs
    client = ppt._client
    assert client is not None
    writes = [request for request in client.requests if request["method"] in {
        "edit_ppt_page", "insert_ppt_element", "remove_ppt_element",
    }]
    assert [request["method"] for request in writes] == [
        "edit_ppt_page", "insert_ppt_element", "remove_ppt_element",
    ]
    assert writes[0]["params"]["expected_revision"] == "revision-history"
    assert writes[1]["params"]["expected_revision"] == "revision-history-next"
    assert writes[2]["params"]["expected_revision"] == "revision-history-next-next"


async def test_element_writes_reject_unknown_refs_before_dispatch() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/deck.pptx")
    await ppt.read_page("history")
    client = ppt._client
    assert client is not None
    request_count = len(client.requests)

    with pytest.raises(ValueError, match="Unknown PowerPoint element ref"):
        await ppt.edit_page("history", "missing", '<PptText ref="missing">No</PptText>')
    with pytest.raises(ValueError, match="Unknown PowerPoint element ref"):
        await ppt.remove_element("history", "missing")

    assert len(client.requests) == request_count
    assert "Live history" in ppt._page_snapshots["history"].markdown


async def test_same_page_element_writes_are_serialized_with_fresh_revisions() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/deck.pptx")
    await ppt.read_page("history")

    await asyncio.gather(
        ppt.edit_page("history", "history-title", '<PptText ref="history-title">Title</PptText>'),
        ppt.edit_page("history", "history-body", '<PptText ref="history-body">Body</PptText>'),
    )

    client = ppt._client
    assert client is not None
    writes = [request for request in client.requests if request["method"] == "edit_ppt_page"]
    assert [request["params"]["expected_revision"] for request in writes] == [
        "revision-history", "revision-history-next",
    ]


async def test_overview_drops_only_snapshots_whose_page_revision_changed() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/deck.pptx")
    await asyncio.gather(ppt.read_page("cover"), ppt.read_page("history"))
    overview = _overview()
    overview["pages"][0]["revision"] = "revision-cover-next"

    await ppt._apply_overview(overview)

    assert "cover" not in ppt._page_snapshots
    assert ppt._page_snapshots["history"].base_revision == "revision-history"


async def test_structural_and_navigation_requests() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/buddhism.pptx")

    inserted = await ppt.insert_page("# Inserted\n", after_page_id="cover")
    assert inserted.page is not None and inserted.page.page_id == "inserted"
    assert [page.page_id for page in ppt.ppt] == ["cover", "inserted", "history"]

    await ppt.read_page("cover")
    await ppt.move_page("history", "cover", "before")
    assert [page.page_id for page in ppt.ppt] == ["history", "cover"]
    await ppt.remove_page("cover")
    assert [page.page_id for page in ppt.ppt] == ["history"]
    assert await ppt.goto_page("history") == {"page_id": "history", "visible": True}


async def test_edit_requires_a_fresh_page_read() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/buddhism.pptx")

    with pytest.raises(ValueError, match="get_ppt_page"):
        await ppt.edit_page("cover", "cover-title", '<PptText ref="cover-title">Changed</PptText>')


async def test_document_design_update_uses_the_private_view_revision() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/buddhism.pptx")

    result = await ppt.update_design({"theme": "midnight", "page_size": "wide"})

    assert result["meta"]["design"] == {"theme": "midnight", "page_size": "wide"}
    client = ppt._client
    assert client is not None
    assert client.requests[-1] == {
        "method": "update_ppt_design",
        "params": {
            "design": {"theme": "midnight", "page_size": "wide"},
            "expected_document_revision": "document-v1",
        },
    }


async def test_stale_renderer_rejection_requires_another_page_read() -> None:
    class StaleClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "edit_ppt_page":
                raise PowerPointOperationError("Page changed", code="page_changed")
            return await super().dispatch(request)

    host, _ = _host(StaleClient)
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/buddhism.pptx")
    await ppt.read_page("cover")

    with pytest.raises(PowerPointOperationError, match="Page changed"):
        await ppt.edit_page("cover", "cover-title", '<PptText ref="cover-title">Changed</PptText>')
    with pytest.raises(ValueError, match="get_ppt_page"):
        await ppt.edit_page("cover", "cover-title", '<PptText ref="cover-title">Retry</PptText>')


async def test_embedded_page_assets_are_materialized_for_agent_inspection(tmp_path: Path) -> None:
    class EmbeddedAssetClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "view_ppt":
                return _overview(("cover",))
            if request["method"] == "get_ppt_page":
                return {
                    "page": {
                        **_page("cover", "![cover](@existing/cover-image)", "revision-cover"),
                        "asset_paths": [".ppt-assets/cover.png"],
                    },
                    "assets": [{
                        "path": ".ppt-assets/cover.png",
                        "file_name": "cover.png",
                        "mime_type": "image/png",
                        "data_url": "data:image/png;base64," + base64.b64encode(b"png").decode("ascii"),
                    }],
                }
            return await super().dispatch(request)

    host, _ = _host(EmbeddedAssetClient)
    ppt = host.for_session("session-a", workspace_root=tmp_path)
    await ppt.view_ppt(str(tmp_path / "buddhism.pptx"))

    view = await ppt.read_page("cover")
    assert view.assets[0].path == ".ppt-assets/cover.png"
    assert (tmp_path / ".ppt-assets/cover.png").read_bytes() == b"png"


async def test_renderer_page_result_rejects_missing_assets() -> None:
    class InvalidClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "view_ppt":
                return _overview()
            return {
                "page": {
                    **_page("cover", "![cover](assets/missing.png)", "revision-cover"),
                    "asset_paths": ["assets/missing.png"],
                },
                "assets": [],
            }

    host, _ = _host(InvalidClient)
    ppt = host.for_session("session-a")
    await ppt.view_ppt("/workspace/buddhism.pptx")

    with pytest.raises(RuntimeError, match="omitted a resource"):
        await ppt.read_page("cover")
