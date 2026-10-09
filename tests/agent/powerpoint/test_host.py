import base64
from pathlib import Path
from typing import Any

import pytest

from src.amphi_agent.powerpoint import (
    PowerPointHost,
    PowerPointIdentity,
    PowerPointOperationError,
    _SessionPowerPointClient,
)


def _deck(revision: str = "document-v1") -> dict[str, Any]:
    return {
        "document_id": "deck-1",
        "revision": revision,
        "deck": {
            "id": "deck-1",
            "title": "Buddhism",
            "file_name": "buddhism.pptx",
            "total_pages": 2,
            "active_page_id": "cover",
            "pages": [
                {"id": "cover", "index": 0, "name": "Cover", "revision": f"page-cover-{revision}", "has_content": True},
                {"id": "history", "index": 1, "name": "History", "revision": f"page-history-{revision}", "has_content": True},
            ],
        },
    }


def _page(page_id: str, revision: str) -> dict[str, Any]:
    return {
        "document_id": "deck-1",
        "page_id": page_id,
        "revision": revision,
        "page": {
            "id": page_id,
            "index": 0 if page_id == "cover" else 1,
            "name": page_id.title(),
            "revision": revision,
            "has_content": True,
            "refs": [f"{page_id}-title"],
            "markdown": f'<PptText ref="{page_id}-title">Live {page_id}</PptText>',
        },
        "assets": [],
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
        self.document_revision = "document-v1"
        self.page_revisions = {"cover": "page-cover-v1", "history": "page-history-v1"}

    async def connect(self, target_id: str, session_id: str) -> None:
        self.connected = (target_id, session_id)
        self.live = True

    def is_live(self) -> bool:
        return self.live

    async def dispatch(self, request: dict[str, Any]) -> Any:
        self.requests.append(request)
        method = request["method"]
        params = request.get("params", {})
        if method == "open":
            return {**_deck(self.document_revision), "target": params["target"]}
        if method == "read_deck":
            return _deck(self.document_revision)
        if method == "read_page":
            page_id = params["page_id"]
            return _page(page_id, self.page_revisions[page_id])
        if method == "edit_page":
            page_id = params["page_id"]
            if params["expected_revision"] != self.page_revisions[page_id]:
                raise PowerPointOperationError("Page changed", code="page_changed")
            if params.get("validate_only"):
                return {"status": "validated", "document_id": "deck-1", "page_id": page_id}
            self.page_revisions[page_id] = f"{self.page_revisions[page_id]}-next"
            self.document_revision = "document-v2"
            return {"status": "ready", "document_id": "deck-1", "page_id": page_id, "revision": self.page_revisions[page_id], "changed_page_ids": [page_id]}
        if method == "manage_deck":
            if params["expected_revision"] != self.document_revision:
                raise PowerPointOperationError("Deck changed", code="document_changed")
            if params.get("validate_only"):
                return {"status": "validated", "document_id": "deck-1"}
            self.document_revision = "document-v2"
            return {"status": "ready", "document_id": "deck-1", "revision": self.document_revision, "changed_page_ids": ["new-page"]}
        if method == "inspect":
            page_id = params.get("page_id", "cover")
            return {"kind": "render", "document_id": "deck-1", "document_revision": 1, "page_id": page_id, "revision": self.page_revisions[page_id], "index": 0}
        if method == "save":
            return {"status": "saved", "document_id": params["document_id"], "target": params.get("save_as", "/workspace/deck.pptx")}
        raise AssertionError(f"Unexpected request: {request}")

    async def screenshot_page(self, page_id: str, document_revision: int, target: Path) -> None:
        assert document_revision == 1
        target.write_bytes(f"png:{page_id}".encode())

    async def disconnect(self) -> None:
        self.live = False


def _host(factory: Any = _Client) -> tuple[PowerPointHost, _Controller]:
    host = PowerPointHost(prepare_playwright=lambda: None, session_factory=factory)
    controller = _Controller()
    host._controller = controller  # type: ignore[assignment]
    host._connected_generation = controller.generation
    return host, controller


async def test_session_keeps_document_identity_and_private_read_leases() -> None:
    clients: list[_Client] = []

    def factory(endpoint: str) -> _Client:
        client = _Client(endpoint)
        clients.append(client)
        return client

    host, controller = _host(factory)
    ppt = host.for_session("session-a")
    assert ppt.identity == PowerPointIdentity(session_id="session-a")
    opened = await ppt.open("/workspace/buddhism.pptx")
    assert opened["deck"]["id"] == "deck-1"
    assert ppt.identity.document_id == "deck-1"
    page = await ppt.read_page("deck-1", "cover")
    assert '<PptText ref="cover-title">' in page["page"]["markdown"]
    assert ppt._deck_revisions["deck-1"].revision == "document-v1"
    assert ppt._page_revisions[("deck-1", "cover")].revision == "page-cover-v1"
    assert clients[0].connected == ("target-session-a", "session-a")
    await host.release_sessions(["session-a"])
    assert controller.released == ["session-a"]
    assert ppt.identity == PowerPointIdentity(session_id="session-a")


async def test_structured_page_edit_uses_private_revision_and_refreshes_only_its_lease() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    await ppt.read_page("deck-1", "cover")
    result = await ppt.edit_page("deck-1", "cover", [{
        "type": "patch", "id": "cover-title", "element_type": "text", "patch": {"text": "Updated"},
    }])
    assert result["status"] == "ready"
    client = ppt._client
    assert client is not None
    request = next(item for item in client.requests if item["method"] == "edit_page")
    assert request["params"]["expected_revision"] == "page-cover-v1"
    assert "expected_revision" not in request["params"]["operations"][0]
    assert "deck-1" not in ppt._deck_revisions
    assert ppt._page_revisions[("deck-1", "cover")].revision.endswith("-next")


async def test_deck_management_requires_a_deck_read_and_honors_validate_only() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    validated = await ppt.manage_deck("deck-1", [{"type": "set-design", "patch": {"title": "New"}}], {"validate_only": True})
    assert validated["status"] == "validated"
    assert ppt._deck_revisions["deck-1"].revision == "document-v1"
    ready = await ppt.manage_deck("deck-1", [{"type": "insert-page", "page": {"id": "new-page"}}])
    assert ready["revision"] == "document-v2"
    assert not any(key[0] == "deck-1" for key in ppt._page_revisions)


async def test_stale_revision_invalidates_all_document_leases() -> None:
    class StaleClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "edit_page":
                raise PowerPointOperationError("Page changed", code="page_changed")
            return await super().dispatch(request)

    host, _ = _host(StaleClient)
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    await ppt.read_page("deck-1", "cover")
    with pytest.raises(PowerPointOperationError, match="Page changed"):
        await ppt.edit_page("deck-1", "cover", [{"type": "remove", "id": "cover-title"}])
    assert "deck-1" not in ppt._deck_revisions
    assert ("deck-1", "cover") not in ppt._page_revisions
    with pytest.raises(ValueError, match="ppt_read_page"):
        await ppt.edit_page("deck-1", "cover", [{"type": "remove", "id": "cover-title"}])


async def test_write_transport_failure_is_not_retried() -> None:
    clients: list[_Client] = []

    class AmbiguousClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "edit_page":
                self.requests.append(request)
                raise ConnectionError("Connection lost after dispatch")
            return await super().dispatch(request)

    def factory(endpoint: str) -> _Client:
        client = AmbiguousClient(endpoint)
        clients.append(client)
        return client

    host, _ = _host(factory)
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    await ppt.read_page("deck-1", "cover")
    with pytest.raises(ConnectionError, match="after dispatch"):
        await ppt.edit_page("deck-1", "cover", [{"type": "remove", "id": "cover-title"}])
    assert sum(request["method"] == "edit_page" for client in clients for request in client.requests) == 1
    assert ("deck-1", "cover") not in ppt._page_revisions


async def test_structured_media_paths_are_bounded_and_materialized(tmp_path: Path) -> None:
    host, _ = _host()
    ppt = host.for_session("session-a", workspace_root=tmp_path)
    (tmp_path / "hero.png").write_bytes(b"png")
    await ppt.open(str(tmp_path / "deck.pptx"))
    await ppt.read_page("deck-1", "cover")
    operations = '[{"type":"add","element":{"id":"hero","type":"image","src":"hero.png"}}]'
    await ppt.edit_page("deck-1", "cover", operations)  # type: ignore[arg-type]
    assert ppt._client is not None
    request = next(item for item in ppt._client.requests if item["method"] == "edit_page")
    assert request["params"]["operations"][0]["element"]["src"] == "hero.png"
    assert request["params"]["assets"]["hero.png"] == {
        "assetId": "8f8cbb7dcf46e0bc7d532657",
        "dataUrl": "data:image/png;base64,cG5n",
        "fileName": "hero.png",
        "mimeType": "image/png",
        "path": "hero.png",
    }

    await ppt.read_page("deck-1", "cover")
    with pytest.raises(ValueError, match="workspace-relative"):
        await ppt.edit_page("deck-1", "cover", [{"type": "add", "element": {"id": "bad", "type": "image", "src": str(tmp_path / "hero.png")}}])


async def test_inspect_captures_the_exact_session_surface(tmp_path: Path) -> None:
    host, _ = _host()
    ppt = host.for_session("session-a", workspace_root=tmp_path)
    await ppt.open(str(tmp_path / "deck.pptx"))
    result = await ppt.inspect("deck-1", {"kind": "render", "page_ids": ["cover"]})
    target = Path(result["renders"][0]["path"])
    assert target.is_relative_to(tmp_path)
    assert target.read_bytes() == b"png:cover"


async def test_embedded_assets_are_materialized_for_agent_inspection(tmp_path: Path) -> None:
    class EmbeddedAssetClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "read_page":
                result = _page("cover", "page-cover-v1")
                result["assets"] = [{
                    "path": ".ppt-assets/cover.png",
                    "file_name": "cover.png",
                    "mime_type": "image/png",
                    "data_url": "data:image/png;base64," + base64.b64encode(b"png").decode("ascii"),
                }]
                return result
            return await super().dispatch(request)

    host, _ = _host(EmbeddedAssetClient)
    ppt = host.for_session("session-a", workspace_root=tmp_path)
    await ppt.open(str(tmp_path / "deck.pptx"))
    result = await ppt.read_page("deck-1", "cover")
    assert (tmp_path / ".ppt-assets/cover.png").read_bytes() == b"png"
    assert result["assets"] == [{
        "path": ".ppt-assets/cover.png",
        "file_name": "cover.png",
        "mime_type": "image/png",
    }]


async def test_save_targets_an_explicit_document() -> None:
    host, _ = _host()
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    saved = await ppt.save("deck-1")
    assert saved["document_id"] == "deck-1"
    copied = await ppt.save("deck-1", "/workspace/copy.pptx")
    assert copied["target"] == "/workspace/copy.pptx"
    assert ppt.identity.file_name == "copy.pptx"
    assert ppt.identity.path == "/workspace/copy.pptx"
    assert ppt._client is not None
    assert ppt._client.requests[-1]["method"] == "save"


async def test_response_scope_mismatch_invalidates_private_leases() -> None:
    class WrongDocumentClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            result = await super().dispatch(request)
            if request["method"] == "read_page":
                result["document_id"] = "another-deck"
            return result

    host, _ = _host(WrongDocumentClient)
    ppt = host.for_session("session-a")
    await ppt.open("/workspace/deck.pptx")
    with pytest.raises(RuntimeError, match="wrong document"):
        await ppt.read_page("deck-1", "cover")
    assert ppt._deck_revisions == {}
    assert ppt._page_revisions == {}


async def test_inspect_rejects_a_renderer_that_selects_the_wrong_page(tmp_path: Path) -> None:
    class WrongPageClient(_Client):
        async def dispatch(self, request: dict[str, Any]) -> Any:
            if request["method"] == "inspect":
                return {"kind": "render", "document_id": "deck-1", "document_revision": 1, "page_id": "history", "revision": "page-history-v1", "index": 1}
            return await super().dispatch(request)

    host, _ = _host(WrongPageClient)
    ppt = host.for_session("session-a", workspace_root=tmp_path)
    await ppt.open(str(tmp_path / "deck.pptx"))
    with pytest.raises(RuntimeError, match="wrong page"):
        await ppt.inspect("deck-1", {"kind": "render", "page_ids": ["cover"]})
    assert ppt._deck_revisions == {}


async def test_render_capture_exports_the_clean_native_canvas(tmp_path: Path) -> None:
    class Locator:
        async def wait_for(self, **_kwargs: Any) -> None:
            return None

        async def get_attribute(self, name: str) -> str | None:
            assert name == "data-presentation-render-status"
            return "ready"

    class Page:
        def is_closed(self) -> bool:
            return False

        def get_by_test_id(self, test_id: str) -> Locator:
            assert test_id == "presentation-editing-canvas"
            return Locator()

        async def wait_for_function(self, _expression: str, **kwargs: Any) -> None:
            assert kwargs["arg"] == {"pageId": "cover", "revision": 7}

        async def evaluate(self, expression: str, argument: Any = None) -> Any:
            if "requestAnimationFrame" in expression:
                return None
            assert argument == {"pageId": "cover", "revision": 7}
            return "data:image/png;base64," + base64.b64encode(b"clean-canvas").decode()

    client = _SessionPowerPointClient("http://127.0.0.1:43101")
    client._page = Page()  # type: ignore[assignment]
    target = tmp_path / "render.png"
    await client.screenshot_page("cover", 7, target)
    assert target.read_bytes() == b"clean-canvas"
