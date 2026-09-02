from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import mimetypes
import time
import urllib.error
import urllib.request
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from playwright.async_api import Browser as PlaywrightBrowser
from playwright.async_api import BrowserContext, Page, Playwright, async_playwright

from .runtime._environment import bundled_node_runtime

logger = logging.getLogger(__name__)

POWERPOINT_PROTOCOL_VERSION = 5

_CONTROLLER_TIMEOUT_SECONDS = 3.0
_ATTACH_TIMEOUT_SECONDS = 15.0
_BRIDGE_TIMEOUT_MS = 10_000
_MAX_PAGE_MARKDOWN_BYTES = 64 * 1024


class PowerPointUnavailableError(RuntimeError):
    """Raised when the desktop App cannot provide the Session's PPT surface."""


class PowerPointOperationError(ValueError):
    """Raised when the renderer rejects a PPT domain request."""

    def __init__(self, message: str, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


def _powerpoint_unavailable(cause: Optional[BaseException] = None) -> PowerPointUnavailableError:
    error = PowerPointUnavailableError(
        "PowerPoint is unavailable because the desktop app is not running or its "
        "PowerPoint connection was interrupted. Open the desktop app and retry."
    )
    if cause is not None:
        error.__cause__ = cause
    return error


def _required_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"PowerPoint renderer returned an invalid {name}")
    return value.strip()


def _optional_string(value: Any, name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise RuntimeError(f"PowerPoint renderer returned an invalid {name}")
    normalized = value.strip()
    return normalized or None


@dataclass(frozen=True)
class PowerPointIdentity:
    """The PPT identity visible to the backend and owned by one Agent Session."""

    session_id: str
    name: Optional[str] = None
    file_name: Optional[str] = None
    path: Optional[str] = None


@dataclass(frozen=True)
class PowerPointAsset:
    """A lightweight path reference for a resource used by the current PPT."""

    path: str
    file_name: Optional[str] = None
    mime_type: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Any) -> "PowerPointAsset":
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid asset")
        return cls(
            path=_required_string(payload.get("path"), "asset path"),
            file_name=_optional_string(payload.get("file_name"), "asset file name"),
            mime_type=_optional_string(payload.get("mime_type"), "asset MIME type"),
        )


@dataclass(frozen=True)
class PowerPointDiagnostic:
    """One compiler or layout diagnostic for a single PPT page."""

    code: str
    message: str
    severity: str = "error"
    line: Optional[int] = None
    column: Optional[int] = None
    suggestion: Optional[str] = None

    @classmethod
    def from_payload(cls, payload: Any) -> "PowerPointDiagnostic":
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid diagnostic")

        def optional_position(name: str) -> Optional[int]:
            value = payload.get(name)
            if value is None:
                return None
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise RuntimeError(f"PowerPoint renderer returned an invalid diagnostic {name}")
            return value

        return cls(
            code=_required_string(payload.get("code"), "diagnostic code"),
            message=_required_string(payload.get("message"), "diagnostic message"),
            severity=_required_string(payload.get("severity", "error"), "diagnostic severity"),
            line=optional_position("line"),
            column=optional_position("column"),
            suggestion=_optional_string(payload.get("suggestion"), "diagnostic suggestion"),
        )


@dataclass(frozen=True)
class PowerPointPage:
    """One current page entry in the live PPT overview."""

    page_id: str
    index: int
    revision: str
    title: Optional[str] = None
    layout: Optional[str] = None
    summary: Optional[str] = None
    has_content: bool = False

    @classmethod
    def from_payload(cls, payload: Any) -> "PowerPointPage":
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid page")
        index = payload.get("index")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            raise RuntimeError("PowerPoint renderer returned an invalid page index")
        revision = _required_string(payload.get("revision"), "page revision")
        markdown = payload.get("markdown", "")
        has_content = payload.get("has_content", isinstance(markdown, str) and bool(markdown.strip()))
        if not isinstance(has_content, bool):
            raise RuntimeError("PowerPoint renderer returned invalid page content metadata")
        return cls(
            page_id=_required_string(payload.get("page_id"), "page id"),
            index=index,
            revision=revision,
            title=_optional_string(payload.get("title"), "page title"),
            layout=_optional_string(payload.get("layout"), "page layout"),
            summary=_optional_string(payload.get("summary"), "page summary"),
            has_content=has_content,
        )


@dataclass(frozen=True)
class PowerPointPageSnapshot:
    """The exact Agent-read Markdown and revision used as an edit lease."""

    page_id: str
    base_revision: str
    markdown: str
    asset_paths: tuple[str, ...] = ()
    refs: tuple[str, ...] = ()

    @classmethod
    def from_payload(cls, payload: Any) -> "PowerPointPageSnapshot":
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid page snapshot")
        markdown = payload.get("markdown")
        if not isinstance(markdown, str):
            raise RuntimeError("PowerPoint renderer returned invalid page Markdown")
        raw_asset_paths = payload.get("asset_paths", ())
        if not isinstance(raw_asset_paths, (list, tuple)):
            raise RuntimeError("PowerPoint renderer returned invalid page assets")
        asset_paths: list[str] = []
        for raw_path in raw_asset_paths:
            path = _required_string(raw_path, "page asset path")
            if path not in asset_paths:
                asset_paths.append(path)
        raw_refs = payload.get("refs", ())
        if not isinstance(raw_refs, (list, tuple)):
            raise RuntimeError("PowerPoint renderer returned invalid page refs")
        refs: list[str] = []
        for raw_ref in raw_refs:
            ref = _required_string(raw_ref, "PowerPoint element ref")
            if ref in refs:
                raise RuntimeError("PowerPoint renderer returned duplicate page refs")
            refs.append(ref)
        return cls(
            page_id=_required_string(payload.get("page_id"), "page id"),
            base_revision=_required_string(payload.get("revision"), "page revision"),
            markdown=markdown,
            asset_paths=tuple(asset_paths),
            refs=tuple(refs),
        )


@dataclass(frozen=True)
class PowerPointPageView:
    """One current page entry paired with its Agent-read source snapshot."""

    page: PowerPointPage
    snapshot: PowerPointPageSnapshot
    assets: tuple[PowerPointAsset, ...]


@dataclass(frozen=True)
class PowerPointWriteResult:
    """Atomic result of compiling and writing one PPT page."""

    status: str
    page: Optional[PowerPointPage] = None
    diagnostics: tuple[PowerPointDiagnostic, ...] = ()
    element_ref: Optional[str] = None


@dataclass(frozen=True)
class _PowerPointSurface:
    session_id: str
    target_id: Optional[str]


@dataclass(frozen=True)
class _PowerPointController:
    """Authenticated Electron controller shared with the embedded browser."""

    controller_id: str
    generation: str
    control_url: str
    control_token: str
    cdp_endpoint: str
    owner_pid: int

    async def health(self) -> None:
        await asyncio.to_thread(self._request, "GET", "/v1/health", None)

    async def ensure_session(self, session_id: str) -> _PowerPointSurface:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/powerpoint/sessions/ensure",
            {"session_id": session_id},
        )
        return self._surface(response, session_id)

    async def release_session(self, session_id: str) -> None:
        await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/powerpoint/sessions/release",
            {"session_id": session_id},
        )

    def public_status(self) -> dict[str, Any]:
        return {
            "available": True,
            "controller_id": self.controller_id,
            "generation": self.generation,
            "owner_pid": self.owner_pid,
        }

    @staticmethod
    def _surface(response: dict[str, Any], expected_session_id: str) -> _PowerPointSurface:
        if response.get("session_id") != expected_session_id:
            raise RuntimeError("Electron PowerPoint controller returned the wrong Session")
        target_id = response.get("target_id")
        if target_id is not None and (not isinstance(target_id, str) or not target_id):
            raise RuntimeError("Electron PowerPoint controller returned an invalid target")
        return _PowerPointSurface(session_id=expected_session_id, target_id=target_id)

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]]) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.control_url.rstrip('/')}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.control_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=_CONTROLLER_TIMEOUT_SECONDS) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 401 or exc.code >= 500:
                raise _powerpoint_unavailable(exc)
            try:
                parsed_error = json.loads(exc.read().decode("utf-8"))
                detail = parsed_error.get("error") if isinstance(parsed_error, dict) else None
            except (OSError, UnicodeError, json.JSONDecodeError):
                detail = None
            suffix = f": {detail.strip()}" if isinstance(detail, str) and detail.strip() else ""
            raise RuntimeError(
                f"Electron PowerPoint controller rejected the request (HTTP {exc.code}){suffix}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise _powerpoint_unavailable(exc)
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("Electron PowerPoint controller returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("Electron PowerPoint controller returned an invalid response")
        return parsed


class _SessionPowerPointClient:
    """One Playwright connection bound to one Electron-owned PPT target."""

    def __init__(self, cdp_endpoint: str) -> None:
        self._cdp_endpoint = cdp_endpoint
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[PlaywrightBrowser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None

    def is_live(self) -> bool:
        return (
            self._browser is not None
            and self._browser.is_connected()
            and self._page is not None
            and not self._page.is_closed()
        )

    async def connect(self, target_id: str, session_id: str) -> None:
        if self._playwright is not None:
            raise RuntimeError("The PowerPoint client is already connected")
        try:
            async with asyncio.timeout(_ATTACH_TIMEOUT_SECONDS):
                self._playwright = await async_playwright().start()
                self._browser = await self._playwright.chromium.connect_over_cdp(self._cdp_endpoint)
                self._context, self._page = await self._wait_for_target(target_id)
                await self._page.wait_for_function(
                    f"expected => window.__bridgicPowerPoint?.protocolVersion === {POWERPOINT_PROTOCOL_VERSION} "
                    "&& window.__bridgicPowerPoint?.sessionId === expected",
                    arg=session_id,
                    timeout=_BRIDGE_TIMEOUT_MS,
                )
        except BaseException:
            await self.disconnect()
            raise

    async def dispatch(self, request: dict[str, Any]) -> Any:
        page = self._page
        if page is None or page.is_closed():
            raise RuntimeError("The PowerPoint target is closed")
        response = await page.evaluate(
            "request => window.__bridgicPowerPoint.dispatch(request)",
            request,
        )
        if not isinstance(response, dict) or not isinstance(response.get("ok"), bool):
            raise RuntimeError("The PowerPoint renderer returned an invalid response")
        if response["ok"]:
            return response.get("value")
        message = response.get("error")
        code = response.get("code")
        raise PowerPointOperationError(
            message if isinstance(message, str) and message else "PowerPoint operation rejected",
            code=code if isinstance(code, str) and code else None,
        )

    async def disconnect(self) -> None:
        browser = self._browser
        playwright = self._playwright
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None
        if browser is not None:
            with suppress(Exception):
                await browser.close()
        if playwright is not None:
            with suppress(Exception):
                await playwright.stop()

    async def _wait_for_target(self, target_id: str) -> tuple[BrowserContext, Page]:
        browser = self._browser
        if browser is None:
            raise RuntimeError("The PowerPoint CDP connection is not active")
        deadline = time.monotonic() + _ATTACH_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            for context in browser.contexts:
                for page in context.pages:
                    if not page.is_closed() and await self._target_id(context, page) == target_id:
                        return context, page
            await asyncio.sleep(0.02)
        raise TimeoutError(f"Electron PowerPoint target {target_id!r} did not attach")

    @staticmethod
    async def _target_id(context: BrowserContext, page: Page) -> str:
        session = await context.new_cdp_session(page)
        try:
            result = await session.send("Target.getTargetInfo")
            return str(result["targetInfo"]["targetId"])
        finally:
            with suppress(Exception):
                await session.detach()


class SessionPowerPoint:
    """Live PPT state and private concurrency leases for one Agent Session."""

    def __init__(self, host: "PowerPointHost", session_id: str, workspace_root: Optional[Path] = None) -> None:
        self._host = host
        self.identity = PowerPointIdentity(session_id=session_id)
        self.assets: dict[str, PowerPointAsset] = {}
        self.ppt: tuple[PowerPointPage, ...] = ()
        self._meta: dict[str, Any] = {}
        self._target: Optional[Path] = None
        self._workspace_root = workspace_root
        self._page_snapshots: dict[str, PowerPointPageSnapshot] = {}
        self._deck_revision: Optional[str] = None
        self._document_revision: Optional[str] = None
        self._state_lock = asyncio.Lock()
        self._page_write_locks: dict[str, asyncio.Lock] = {}
        self._connection_lock = asyncio.Lock()
        self._client: Optional[_SessionPowerPointClient] = None
        self._owner_generation: Optional[int] = None
        self._controller: Optional[_PowerPointController] = None

    @property
    def session_id(self) -> str:
        return self.identity.session_id

    def set_workspace_root(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root.expanduser().resolve()

    def page(self, page_id: str) -> PowerPointPage:
        normalized = str(page_id or "").strip()
        for page in self.ppt:
            if page.page_id == normalized:
                return page
        raise KeyError(f"Unknown PowerPoint page: {normalized}")

    def page_assets(self, page_id: str) -> tuple[PowerPointAsset, ...]:
        normalized = self.page(page_id).page_id
        snapshot = self._page_snapshots.get(normalized)
        if snapshot is None:
            return ()
        return tuple(self.assets[path] for path in snapshot.asset_paths if path in self.assets)

    def describe(self) -> dict[str, Any]:
        return {
            "identity": {
                "session_id": self.identity.session_id,
                "name": self.identity.name,
                "file_name": self.identity.file_name,
                "path": self.identity.path,
            },
            "meta": dict(self._meta),
            "pages": [
                {
                    "page_id": page.page_id,
                    "index": page.index,
                    "title": page.title,
                    "layout": page.layout,
                    "summary": page.summary,
                    "has_content": page.has_content,
                }
                for page in self.ppt
            ],
        }

    async def view_ppt(self, target: str) -> dict[str, Any]:
        normalized = str(target or "").strip()
        if not normalized:
            raise ValueError("target is required to view PowerPoint")
        target_path = Path(normalized).expanduser().resolve()
        if target_path.exists() and not target_path.is_file():
            raise ValueError("PowerPoint target must be a file")
        params: dict[str, Any] = {
            "target": str(target_path),
            "file_name": target_path.name,
        }
        if target_path.exists():
            params["content_base64"] = base64.b64encode(await asyncio.to_thread(target_path.read_bytes)).decode("ascii")
        result = await self._invoke({"method": "view_ppt", "params": params})
        self._target = target_path
        await self._apply_overview(result, reset_reads=True)
        return self.describe()

    async def read_page(self, page_id: str) -> PowerPointPageView:
        normalized = str(page_id or "").strip()
        if not normalized:
            raise ValueError("page_id is required to read a PowerPoint page")
        result = await self._invoke({"method": "get_ppt_page", "params": {"page_id": normalized}})
        return await self._merge_page_result(result, expected_page_id=normalized, remember_read=True)

    async def update_design(self, design: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(design, dict) or not design:
            raise ValueError("PowerPoint design changes are required")
        expected_revision = self._document_revision
        if expected_revision is None:
            raise ValueError("Call view_ppt before updating the PowerPoint design")
        params = {"design": design, "expected_document_revision": expected_revision}
        try:
            result = await self._invoke({"method": "update_ppt_design", "params": params})
        except PowerPointOperationError as exc:
            if exc.code == "document_changed":
                self._document_revision = None
            raise
        await self._apply_overview(result)
        return self.describe()

    async def edit_page(self, page_id: str, ref: str, replacement: str) -> PowerPointWriteResult:
        normalized = str(page_id or "").strip()
        normalized_ref = str(ref or "").strip()
        if not normalized or not normalized_ref:
            raise ValueError("page_id and ref are required to edit a PowerPoint page")
        if not isinstance(replacement, str) or not replacement.strip():
            raise ValueError("replacement must be a non-empty PowerPoint element fragment")
        if len(replacement.encode("utf-8")) > _MAX_PAGE_MARKDOWN_BYTES:
            raise ValueError("PowerPoint element replacement exceeds the per-element limit")
        page_lock = await self._write_lock(normalized)
        async with page_lock:
            snapshot = await self._snapshot_for_write(normalized, "editing")
            if normalized_ref not in snapshot.refs:
                raise ValueError(f"Unknown PowerPoint element ref in the last page read: {normalized_ref}")
            params = {
                "page_id": normalized,
                "ref": normalized_ref,
                "replacement": replacement,
                "expected_revision": snapshot.base_revision,
                "assets": await self._resolve_markdown_assets(replacement),
            }
            result = await self._invoke_page_write("edit_ppt_page", params, snapshot)
            return await self._apply_write_result(result, expected_page_id=normalized)

    async def insert_element(self, page_id: str, element: str) -> PowerPointWriteResult:
        normalized = str(page_id or "").strip()
        if not normalized:
            raise ValueError("page_id is required to insert a PowerPoint element")
        if not isinstance(element, str) or not element.strip():
            raise ValueError("element must be a non-empty PowerPoint element fragment")
        if len(element.encode("utf-8")) > _MAX_PAGE_MARKDOWN_BYTES:
            raise ValueError("PowerPoint element exceeds the per-element limit")
        page_lock = await self._write_lock(normalized)
        async with page_lock:
            snapshot = await self._snapshot_for_write(normalized, "inserting an element into")
            params = {
                "page_id": normalized,
                "element": element,
                "expected_revision": snapshot.base_revision,
                "assets": await self._resolve_markdown_assets(element),
            }
            result = await self._invoke_page_write("insert_ppt_element", params, snapshot)
            return await self._apply_write_result(result, expected_page_id=normalized)

    async def remove_element(self, page_id: str, ref: str) -> PowerPointWriteResult:
        normalized = str(page_id or "").strip()
        normalized_ref = str(ref or "").strip()
        if not normalized or not normalized_ref:
            raise ValueError("page_id and ref are required to remove a PowerPoint element")
        page_lock = await self._write_lock(normalized)
        async with page_lock:
            snapshot = await self._snapshot_for_write(normalized, "removing an element from")
            if normalized_ref not in snapshot.refs:
                raise ValueError(f"Unknown PowerPoint element ref in the last page read: {normalized_ref}")
            params = {
                "page_id": normalized,
                "ref": normalized_ref,
                "expected_revision": snapshot.base_revision,
            }
            result = await self._invoke_page_write("remove_ppt_element", params, snapshot)
            return await self._apply_write_result(result, expected_page_id=normalized)

    async def _write_lock(self, page_id: str) -> asyncio.Lock:
        async with self._state_lock:
            return self._page_write_locks.setdefault(page_id, asyncio.Lock())

    async def _snapshot_for_write(self, page_id: str, operation: str) -> PowerPointPageSnapshot:
        async with self._state_lock:
            snapshot = self._page_snapshots.get(page_id)
        if snapshot is None:
            raise ValueError(f"Call get_ppt_page('{page_id}') before {operation} this page")
        return snapshot

    async def _invoke_page_write(self, method: str, params: dict[str, Any], snapshot: PowerPointPageSnapshot) -> Any:
        try:
            return await self._invoke({"method": method, "params": params})
        except PowerPointOperationError as exc:
            if exc.code == "page_changed":
                async with self._state_lock:
                    current = self._page_snapshots.get(snapshot.page_id)
                    if current is not None and current.base_revision == snapshot.base_revision:
                        self._page_snapshots.pop(snapshot.page_id, None)
            raise

    async def insert_page(self, markdown: str, after_page_id: Optional[str] = None) -> PowerPointWriteResult:
        if not isinstance(markdown, str) or not markdown.strip():
            raise ValueError("markdown is required to insert a PowerPoint page")
        normalized_after = str(after_page_id or "").strip() or None
        params: dict[str, Any] = {
            "markdown": markdown,
            "assets": await self._resolve_markdown_assets(markdown),
        }
        if normalized_after is not None:
            params["after_page_id"] = normalized_after
        result = await self._invoke({"method": "insert_ppt_page", "params": params})
        return await self._apply_write_result(result, expected_page_id=None)

    async def remove_page(self, page_id: str) -> dict[str, Any]:
        normalized = str(page_id or "").strip()
        if not normalized:
            raise ValueError("page_id is required to remove a PowerPoint page")
        page_lock = await self._write_lock(normalized)
        async with page_lock:
            snapshot = await self._snapshot_for_write(normalized, "removing")
            params = {"page_id": normalized, "expected_revision": snapshot.base_revision}
            if self._deck_revision is not None:
                params["expected_deck_revision"] = self._deck_revision
            try:
                result = await self._invoke_page_write("remove_ppt_page", params, snapshot)
            except PowerPointOperationError as exc:
                if exc.code == "deck_changed":
                    self._deck_revision = None
                raise
            async with self._state_lock:
                self._page_snapshots.pop(normalized, None)
            await self._apply_overview(result)
            return self.describe()

    async def move_page(self, page_id: str, target_page_id: str, position: str) -> dict[str, Any]:
        normalized = str(page_id or "").strip()
        normalized_target = str(target_page_id or "").strip()
        if not normalized or not normalized_target:
            raise ValueError("page_id and target_page_id are required to move a PowerPoint page")
        if position not in {"before", "after"}:
            raise ValueError("position must be 'before' or 'after'")
        if self._deck_revision is None:
            raise ValueError("Call view_ppt again before moving pages because the page order changed")
        params = {
            "page_id": normalized,
            "target_page_id": normalized_target,
            "position": position,
            "expected_deck_revision": self._deck_revision,
        }
        try:
            result = await self._invoke({"method": "move_ppt_page", "params": params})
        except PowerPointOperationError as exc:
            if exc.code == "deck_changed":
                self._deck_revision = None
            raise
        await self._apply_overview(result)
        return self.describe()

    async def goto_page(self, page_id: str) -> Any:
        normalized = str(page_id or "").strip()
        if not normalized:
            raise ValueError("page_id is required to navigate PowerPoint")
        return await self._invoke({"method": "goto_ppt_page", "params": {"page_id": normalized}})

    async def close(self) -> bool:
        return await self._host._release_handle(self, discard=False)

    async def _resolve_markdown_assets(self, markdown: str) -> dict[str, dict[str, str]]:
        raw_paths = await self._invoke({"method": "inspect_ppt_assets", "params": {"markdown": markdown}})
        if not isinstance(raw_paths, list):
            raise RuntimeError("PowerPoint renderer returned invalid Markdown asset paths")
        root = self._workspace_root
        if root is None and raw_paths:
            raise RuntimeError("PowerPoint assets require an active Session workspace")
        assets: dict[str, dict[str, str]] = {}
        for raw_path in raw_paths:
            relative_path = _required_string(raw_path, "Markdown asset path")
            candidate = Path(relative_path)
            if candidate.is_absolute() or ".." in candidate.parts:
                raise ValueError(f"PowerPoint asset must be Session-workspace-relative: {relative_path}")
            resolved = (root / candidate).resolve() if root is not None else candidate
            if root is None or not resolved.is_relative_to(root):
                raise ValueError(f"PowerPoint asset escapes the Session workspace: {relative_path}")
            if not resolved.is_file():
                raise ValueError(f"PowerPoint asset does not exist: {relative_path}")
            content = await asyncio.to_thread(resolved.read_bytes)
            mime_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
            asset_id = hashlib.sha256(content).hexdigest()[:24]
            assets[relative_path] = {
                "assetId": asset_id,
                "dataUrl": f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}",
                "fileName": resolved.name,
                "mimeType": mime_type,
                "path": relative_path,
            }
        return assets

    async def _apply_overview(self, payload: Any, reset_reads: bool = False) -> None:
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid PPT overview")
        raw_identity = payload.get("identity")
        if not isinstance(raw_identity, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid PPT identity")
        raw_meta = payload.get("meta", {})
        if not isinstance(raw_meta, dict):
            raise RuntimeError("PowerPoint renderer returned invalid PPT metadata")
        raw_pages = payload.get("pages")
        if not isinstance(raw_pages, list):
            raise RuntimeError("PowerPoint renderer returned an invalid PPT page overview")
        deck_revision = _required_string(payload.get("deck_revision"), "deck revision")
        document_revision = _required_string(payload.get("document_revision"), "document revision")
        identity = PowerPointIdentity(
            session_id=self.session_id,
            name=_optional_string(raw_identity.get("name"), "PPT name"),
            file_name=_optional_string(raw_identity.get("file_name"), "PPT file name"),
            path=str(self._target) if self._target is not None else None,
        )
        async with self._state_lock:
            pages: list[PowerPointPage] = []
            for item in raw_pages:
                if not isinstance(item, dict):
                    raise RuntimeError("PowerPoint renderer returned an invalid page overview")
                pages.append(PowerPointPage.from_payload(item))
            parsed_pages = tuple(pages)
            self._validate_pages(parsed_pages)
            current_pages = {page.page_id: page for page in parsed_pages}
            snapshots = {} if reset_reads else {
                page_id: snapshot
                for page_id, snapshot in self._page_snapshots.items()
                if page_id in current_pages and current_pages[page_id].revision == snapshot.base_revision
            }
            referenced_paths = {path for snapshot in snapshots.values() for path in snapshot.asset_paths}
            self.identity = identity
            self._meta = dict(raw_meta)
            self._deck_revision = deck_revision
            self._document_revision = document_revision
            self.assets = {path: asset for path, asset in self.assets.items() if path in referenced_paths}
            self._page_snapshots = snapshots
            self.ppt = tuple(sorted(parsed_pages, key=lambda page: page.index))

    async def _merge_page_result(self, payload: Any, expected_page_id: Optional[str], remember_read: bool = True) -> PowerPointPageView:
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid page result")
        raw_page = payload.get("page")
        page = PowerPointPage.from_payload(raw_page)
        snapshot = PowerPointPageSnapshot.from_payload(raw_page)
        if snapshot.page_id != page.page_id or snapshot.base_revision != page.revision:
            raise RuntimeError("PowerPoint renderer returned a mismatched page snapshot")
        if expected_page_id is not None and page.page_id != expected_page_id:
            raise RuntimeError("PowerPoint renderer returned the wrong page")
        raw_assets = payload.get("assets")
        if not isinstance(raw_assets, list):
            raise RuntimeError("PowerPoint renderer returned an invalid asset list")
        for raw_asset in raw_assets:
            if not isinstance(raw_asset, dict):
                raise RuntimeError("PowerPoint renderer returned an invalid asset")
            data_url = raw_asset.get("data_url")
            if data_url is None:
                continue
            if not isinstance(data_url, str):
                raise RuntimeError("PowerPoint renderer returned invalid embedded asset data")
            root = self._workspace_root
            if root is None:
                raise RuntimeError("Embedded PowerPoint assets require an active Session workspace")
            relative_path = Path(_required_string(raw_asset.get("path"), "asset path"))
            resolved = (root / relative_path).resolve()
            if relative_path.is_absolute() or ".." in relative_path.parts or not resolved.is_relative_to(root):
                raise RuntimeError("PowerPoint renderer returned an unsafe embedded asset path")
            header, separator, encoded = data_url.partition(",")
            if not separator or not header.startswith("data:") or not header.endswith(";base64"):
                raise RuntimeError("PowerPoint renderer returned invalid embedded asset data")
            try:
                content = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise RuntimeError("PowerPoint renderer returned invalid embedded asset data") from exc

            def write_asset() -> None:
                resolved.parent.mkdir(parents=True, exist_ok=True)
                resolved.write_bytes(content)

            await asyncio.to_thread(write_asset)
        page_assets = self._parse_assets(raw_assets)
        missing_assets = set(snapshot.asset_paths).difference(page_assets)
        if missing_assets:
            raise RuntimeError("PowerPoint renderer omitted a resource used by the page")
        async with self._state_lock:
            pages = [item for item in self.ppt if item.page_id != page.page_id]
            pages.append(page)
            if len({item.index for item in pages}) != len(pages):
                raise RuntimeError("PowerPoint renderer returned a duplicate page index")
            snapshots = dict(self._page_snapshots)
            if remember_read:
                snapshots[page.page_id] = snapshot
            combined_assets = {**self.assets, **page_assets}
            referenced_paths = {path for item in snapshots.values() for path in item.asset_paths}
            self.assets = {path: asset for path, asset in combined_assets.items() if path in referenced_paths}
            self._page_snapshots = snapshots
            self.ppt = tuple(sorted(pages, key=lambda item: item.index))
        return PowerPointPageView(
            page=page,
            snapshot=snapshot,
            assets=tuple(page_assets[path] for path in snapshot.asset_paths),
        )

    async def _apply_write_result(self, payload: Any, expected_page_id: Optional[str]) -> PowerPointWriteResult:
        if not isinstance(payload, dict):
            raise RuntimeError("PowerPoint renderer returned an invalid page write result")
        status = _required_string(payload.get("status"), "page write status")
        raw_diagnostics = payload.get("diagnostics", [])
        if not isinstance(raw_diagnostics, list):
            raise RuntimeError("PowerPoint renderer returned invalid page diagnostics")
        diagnostics = tuple(PowerPointDiagnostic.from_payload(item) for item in raw_diagnostics)
        if status == "invalid":
            if payload.get("page") is not None:
                raise RuntimeError("PowerPoint renderer mutated an invalid page write")
            return PowerPointWriteResult(status=status, diagnostics=diagnostics)
        if status != "ready":
            raise RuntimeError("PowerPoint renderer returned an unknown page write status")
        if "identity" in payload or "pages" in payload:
            await self._apply_overview(payload)
        elif "document_revision" in payload:
            async with self._state_lock:
                self._document_revision = _required_string(payload.get("document_revision"), "document revision")
        page_view = await self._merge_page_result(payload, expected_page_id)
        element_ref = _optional_string(payload.get("element_ref"), "PowerPoint element ref")
        return PowerPointWriteResult(
            status=status,
            page=page_view.page,
            diagnostics=diagnostics,
            element_ref=element_ref,
        )

    @staticmethod
    def _parse_assets(payload: Any) -> dict[str, PowerPointAsset]:
        if not isinstance(payload, list):
            raise RuntimeError("PowerPoint renderer returned an invalid asset list")
        assets: dict[str, PowerPointAsset] = {}
        for item in payload:
            asset = PowerPointAsset.from_payload(item)
            if asset.path in assets:
                raise RuntimeError("PowerPoint renderer returned a duplicate asset path")
            assets[asset.path] = asset
        return assets

    @staticmethod
    def _validate_pages(pages: tuple[PowerPointPage, ...]) -> None:
        if len({page.page_id for page in pages}) != len(pages):
            raise RuntimeError("PowerPoint renderer returned a duplicate page id")
        if len({page.index for page in pages}) != len(pages):
            raise RuntimeError("PowerPoint renderer returned a duplicate page index")

    async def _invoke(self, request: dict[str, Any]) -> Any:
        for attempt in range(2):
            client = await self._host._client_for(self)
            try:
                return await client.dispatch(request)
            except PowerPointOperationError:
                raise
            except Exception:
                if attempt > 0:
                    raise
                await self._host._discard_client(self, client)
        raise RuntimeError("PowerPoint request failed")

    async def _clear(self) -> None:
        async with self._state_lock:
            self.identity = PowerPointIdentity(session_id=self.session_id)
            self.assets = {}
            self.ppt = ()
            self._meta = {}
            self._target = None
            self._page_snapshots.clear()
            self._page_write_locks.clear()
            self._deck_revision = None
            self._document_revision = None


class PowerPointHost:
    """Global owner that exposes one PPT state object per Agent Session."""

    def __init__(self, *, prepare_playwright: Optional[Callable[[], None]] = None, session_factory: Callable[[str], _SessionPowerPointClient] = _SessionPowerPointClient) -> None:
        self._prepare_playwright = prepare_playwright or bundled_node_runtime.apply_playwright_env
        self._session_factory = session_factory
        self._lock = asyncio.Lock()
        self._connection_lock = asyncio.Lock()
        self._sessions: dict[str, SessionPowerPoint] = {}
        self._controller: Optional[_PowerPointController] = None
        self._connected_generation: Optional[str] = None
        self._owner_generation = 0
        self._shutdown = False

    def for_session(self, session_id: str, workspace_root: Optional[Path] = None) -> SessionPowerPoint:
        key = str(session_id or "").strip()
        if not key:
            raise ValueError("session_id is required to use PowerPoint")
        if self._shutdown:
            raise RuntimeError("The PowerPoint service has shut down")
        ppt = self._sessions.get(key)
        if ppt is None:
            ppt = SessionPowerPoint(self, key, workspace_root)
            self._sessions[key] = ppt
        elif workspace_root is not None:
            ppt.set_workspace_root(workspace_root)
        return ppt

    async def register_controller(
        self,
        *,
        controller_id: str,
        generation: str,
        control_url: str,
        control_token: str,
        cdp_endpoint: str,
        owner_pid: int,
    ) -> None:
        controller = _PowerPointController(
            controller_id=controller_id,
            generation=generation,
            control_url=control_url,
            control_token=control_token,
            cdp_endpoint=cdp_endpoint,
            owner_pid=owner_pid,
        )
        async with self._lock:
            if self._controller == controller:
                return
            self._controller = controller
            self._connected_generation = None
            self._owner_generation += 1

    async def unregister_controller(self, controller_id: str) -> bool:
        async with self._lock:
            if self._controller is None or self._controller.controller_id != controller_id:
                return False
            self._controller = None
            self._connected_generation = None
            self._owner_generation += 1
            return True

    def controller_status(self) -> dict[str, Any]:
        controller = self._controller
        return controller.public_status() if controller is not None else {"available": False}

    async def release_sessions(self, session_ids: Iterable[str]) -> None:
        for session_id in dict.fromkeys(str(item) for item in session_ids):
            ppt = self._sessions.get(session_id)
            if ppt is not None:
                await self._release_handle(ppt, discard=True)
                continue
            controller = self._controller
            if controller is not None:
                with suppress(Exception):
                    await controller.release_session(session_id)

    async def shutdown(self) -> None:
        async with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            ppts = tuple(self._sessions.values())
        for ppt in ppts:
            await self._release_handle(ppt, discard=True)

    async def _client_for(self, ppt: SessionPowerPoint) -> _SessionPowerPointClient:
        async with ppt._connection_lock:
            async with self._lock:
                if self._shutdown or self._sessions.get(ppt.session_id) is not ppt:
                    raise RuntimeError("The PowerPoint connection has been released")
                current = ppt._client
                if (
                    current is not None
                    and current.is_live()
                    and ppt._owner_generation == self._owner_generation
                ):
                    return current
            if current is not None:
                await self._discard_client(ppt, current)

            controller = await self._ensure_controller()
            surface = await controller.ensure_session(ppt.session_id)
            if surface.target_id is None:
                raise RuntimeError("Electron PowerPoint Session has no CDP target")
            client = self._session_factory(controller.cdp_endpoint)
            try:
                await client.connect(surface.target_id, ppt.session_id)
            except BaseException:
                await client.disconnect()
                raise
            async with self._lock:
                if self._shutdown or self._controller is not controller:
                    await client.disconnect()
                    raise RuntimeError("The PowerPoint controller changed during attach")
                ppt._client = client
                ppt._owner_generation = self._owner_generation
                ppt._controller = controller
                return client

    async def _ensure_controller(self) -> _PowerPointController:
        async with self._connection_lock:
            async with self._lock:
                controller = self._controller
                if self._shutdown:
                    raise RuntimeError("The PowerPoint service has shut down")
                if controller is None:
                    raise _powerpoint_unavailable()
                if self._connected_generation == controller.generation:
                    return controller
            try:
                await controller.health()
            except Exception as exc:
                async with self._lock:
                    if self._controller is controller:
                        self._connected_generation = None
                        self._owner_generation += 1
                raise _powerpoint_unavailable(exc) from exc
            await asyncio.to_thread(self._prepare_playwright)
            async with self._lock:
                if self._controller is not controller:
                    raise _powerpoint_unavailable()
                self._connected_generation = controller.generation
                return controller

    async def _discard_client(self, ppt: SessionPowerPoint, client: _SessionPowerPointClient) -> None:
        async with self._lock:
            if ppt._client is client:
                ppt._client = None
                ppt._owner_generation = None
        await client.disconnect()

    async def _release_handle(self, ppt: SessionPowerPoint, *, discard: bool) -> bool:
        async with ppt._connection_lock:
            async with self._lock:
                client = ppt._client
                controller = self._controller or ppt._controller
                ppt._client = None
                ppt._owner_generation = None
                ppt._controller = None
                if discard and self._sessions.get(ppt.session_id) is ppt:
                    self._sessions.pop(ppt.session_id, None)
            if client is not None:
                await client.disconnect()
            await ppt._clear()
            if controller is None:
                return client is not None
            try:
                await controller.release_session(ppt.session_id)
                return True
            except Exception:
                if not discard:
                    raise
                logger.warning(
                    "Could not release PowerPoint surface for Session %s",
                    ppt.session_id,
                    exc_info=True,
                )
                return client is not None


__all__ = [
    "POWERPOINT_PROTOCOL_VERSION",
    "PowerPointAsset",
    "PowerPointDiagnostic",
    "PowerPointHost",
    "PowerPointIdentity",
    "PowerPointOperationError",
    "PowerPointPage",
    "PowerPointPageSnapshot",
    "PowerPointPageView",
    "PowerPointUnavailableError",
    "PowerPointWriteResult",
    "SessionPowerPoint",
]
