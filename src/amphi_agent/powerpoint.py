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

POWERPOINT_PROTOCOL_VERSION = 7

_CONTROLLER_TIMEOUT_SECONDS = 3.0
_ATTACH_TIMEOUT_SECONDS = 15.0
_BRIDGE_TIMEOUT_MS = 10_000
_MAX_RENDER_PAGES = 12
_STALE_REVISION_CODES = frozenset({"document_changed", "document_not_found", "page_changed"})


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


def _required_dict(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"PowerPoint renderer returned an invalid {name}")
    return value


def _json_transport_value(value: Any, name: str) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"PowerPoint {name} must be valid JSON") from exc


def _normalized_object(value: Any, name: str, *, allow_empty: bool = True) -> dict[str, Any]:
    parsed = _json_transport_value(value, name)
    if parsed is None:
        parsed = {}
    if not isinstance(parsed, dict) or (not allow_empty and not parsed):
        qualifier = "a non-empty object" if not allow_empty else "an object"
        raise ValueError(f"PowerPoint {name} must be {qualifier}")
    if "expected_revision" in parsed:
        raise ValueError("PowerPoint revisions are managed by the Session and must not be supplied")
    return dict(parsed)


def _normalized_operations(value: Any) -> list[dict[str, Any]]:
    parsed = _json_transport_value(value, "operations")
    if not isinstance(parsed, list) or not parsed:
        raise ValueError("PowerPoint operations must be a non-empty array")
    if not all(isinstance(operation, dict) for operation in parsed):
        raise ValueError("Every PowerPoint operation must be an object")
    return [dict(operation) for operation in parsed]


@dataclass(frozen=True)
class PowerPointIdentity:
    """The PPT identity visible to the backend and owned by one Agent Session."""

    session_id: str
    document_id: Optional[str] = None
    name: Optional[str] = None
    file_name: Optional[str] = None
    path: Optional[str] = None


@dataclass(frozen=True)
class _PowerPointSurface:
    session_id: str
    target_id: Optional[str]


@dataclass(frozen=True)
class _RevisionLease:
    revision: str
    connection_generation: int


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

    async def screenshot_page(self, page_id: str, document_revision: int, target: Path) -> None:
        page = self._page
        if page is None or page.is_closed():
            raise RuntimeError("The PowerPoint target is closed")
        locator = page.get_by_test_id("presentation-editing-canvas")
        await locator.wait_for(state="visible", timeout=_BRIDGE_TIMEOUT_MS)
        await page.wait_for_function(
            "expected => {"
            " const root = document.querySelector('[data-testid=\"presentation-editing-canvas\"]');"
            " return root?.getAttribute('data-presentation-page-id') === expected.pageId"
            " && root.getAttribute('data-presentation-document-revision') === String(expected.revision)"
            " && ['ready', 'error'].includes(root.getAttribute('data-presentation-render-status'));"
            "}",
            arg={"pageId": page_id, "revision": document_revision},
            timeout=_BRIDGE_TIMEOUT_MS,
        )
        render_status = await locator.get_attribute("data-presentation-render-status")
        if render_status != "ready":
            raise RuntimeError(f"PowerPoint page {page_id} could not finish rendering")
        await page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
        data_url = await page.evaluate(
            """expected => {
                const root = document.querySelector('[data-testid="presentation-editing-canvas"]')
                if (!root || root.getAttribute('data-presentation-page-id') !== expected.pageId
                  || root.getAttribute('data-presentation-document-revision') !== String(expected.revision)) {
                    throw new Error('PowerPoint render surface changed before capture')
                }
                const canvas = root.querySelector('canvas.lower-canvas') ?? root.querySelector('canvas')
                if (!(canvas instanceof HTMLCanvasElement)) {
                    throw new Error('PowerPoint render canvas is unavailable')
                }
                return canvas.toDataURL('image/png')
            }""",
            {"pageId": page_id, "revision": document_revision},
        )
        if not isinstance(data_url, str):
            raise RuntimeError("PowerPoint renderer returned invalid PNG data")
        header, separator, encoded = data_url.partition(",")
        if not separator or header != "data:image/png;base64":
            raise RuntimeError("PowerPoint renderer returned invalid PNG data")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError("PowerPoint renderer returned invalid PNG data") from exc
        await asyncio.to_thread(target.write_bytes, content)

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
        self._target: Optional[Path] = None
        self._workspace_root = workspace_root
        self._deck_revisions: dict[str, _RevisionLease] = {}
        self._page_revisions: dict[tuple[str, str], _RevisionLease] = {}
        self._state_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._connection_lock = asyncio.Lock()
        self._client: Optional[_SessionPowerPointClient] = None
        self._connection_generation = 0
        self._owner_generation: Optional[int] = None
        self._controller: Optional[_PowerPointController] = None

    @property
    def session_id(self) -> str:
        return self.identity.session_id

    def set_workspace_root(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root.expanduser().resolve()

    async def open(self, target: str) -> dict[str, Any]:
        """Open or create one Session-owned PowerPoint document."""
        normalized = str(target or "").strip()
        if not normalized:
            raise ValueError("target is required to open PowerPoint")
        target_path = Path(normalized).expanduser().resolve()
        if target_path.exists() and not target_path.is_file():
            raise ValueError("PowerPoint target must be a file")
        params: dict[str, Any] = {"target": str(target_path), "file_name": target_path.name}
        if target_path.exists():
            content = await asyncio.to_thread(target_path.read_bytes)
            params["content_base64"] = base64.b64encode(content).decode("ascii")
        async with self._operation_lock:
            result = _required_dict(
                await self._invoke({"method": "open", "params": params}, retry_on_failure=True),
                "open result",
            )
            self._target = Path(result.get("target", str(target_path)))
            await self._remember_deck(result, reset=True)
            return result

    async def read_deck(self, document_id: str, query: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Read a compact deck overview and acquire its private write revision."""
        normalized_id = str(document_id or "").strip()
        if not normalized_id:
            raise ValueError("document_id is required to read a PowerPoint deck")
        params = _normalized_object(query, "deck query")
        unexpected = set(params) - {"include_theme"}
        if unexpected:
            raise ValueError(f"Unsupported PowerPoint deck query: {sorted(unexpected)[0]}")
        params["document_id"] = normalized_id
        async with self._operation_lock:
            result = _required_dict(
                await self._invoke({"method": "read_deck", "params": params}, retry_on_failure=True),
                "deck read result",
            )
            await self._validate_response_scope(result, normalized_id)
            await self._remember_deck(result, expected_document_id=normalized_id)
            return result

    async def edit_page(self, document_id: str, page_id: str, operations: list[dict[str, Any]], options: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Apply one structured, all-or-nothing command batch to a page."""
        normalized_document_id = str(document_id or "").strip()
        normalized_page_id = str(page_id or "").strip()
        if not normalized_document_id:
            raise ValueError("document_id is required to edit a PowerPoint page")
        if not normalized_page_id:
            raise ValueError("page_id is required to edit a PowerPoint page")
        normalized_operations = _normalized_operations(operations)
        normalized_options = _normalized_object(options, "edit options")
        unexpected = set(normalized_options) - {"validate_only"}
        if unexpected:
            raise ValueError(f"Unsupported PowerPoint edit option: {sorted(unexpected)[0]}")
        async with self._operation_lock:
            async with self._state_lock:
                lease = self._page_revisions.get((normalized_document_id, normalized_page_id))
            if lease is None:
                raise ValueError("Call ppt_read_page for that document and page before editing")
            client = await self._host._client_for(self)
            generation = self._connection_generation
            if lease.connection_generation != generation:
                await self._clear_revisions()
                raise ValueError("Call ppt_read_page again because the PowerPoint connection changed")
            params = {
                **normalized_options,
                "document_id": normalized_document_id,
                "page_id": normalized_page_id,
                "expected_revision": lease.revision,
                "operations": normalized_operations,
                "assets": await self._resolve_operation_assets(normalized_operations),
            }
            try:
                result = _required_dict(
                    await self._invoke_write(client, {"method": "edit_page", "params": params}),
                    "page edit result",
                )
                await self._validate_response_scope(result, normalized_document_id, normalized_page_id)
                next_revision = None if normalized_options.get("validate_only") is True else _required_string(result.get("revision"), "page revision")
            except PowerPointOperationError as exc:
                if exc.code in _STALE_REVISION_CODES:
                    await self._clear_document_revisions(normalized_document_id)
                raise
            except Exception:
                await self._clear_page_write_revision(normalized_document_id, normalized_page_id)
                raise
            if next_revision is not None:
                async with self._state_lock:
                    self._deck_revisions.pop(normalized_document_id, None)
                    self._page_revisions = {
                        key: value for key, value in self._page_revisions.items()
                        if key[0] != normalized_document_id
                    }
                    self._page_revisions[(normalized_document_id, normalized_page_id)] = _RevisionLease(next_revision, generation)
            return result

    async def manage_deck(self, document_id: str, operations: list[dict[str, Any]], options: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Apply one structured, all-or-nothing command batch to deck structure or design."""
        normalized_id = str(document_id or "").strip()
        if not normalized_id:
            raise ValueError("document_id is required to manage a PowerPoint deck")
        normalized_operations = _normalized_operations(operations)
        normalized_options = _normalized_object(options, "management options")
        unexpected = set(normalized_options) - {"validate_only"}
        if unexpected:
            raise ValueError(f"Unsupported PowerPoint management option: {sorted(unexpected)[0]}")
        async with self._operation_lock:
            async with self._state_lock:
                lease = self._deck_revisions.get(normalized_id)
            if lease is None:
                raise ValueError("Call ppt_read_deck for that document before managing it")
            client = await self._host._client_for(self)
            generation = self._connection_generation
            if lease.connection_generation != generation:
                await self._clear_revisions()
                raise ValueError("Call ppt_read_deck again because the PowerPoint connection changed")
            params = {
                **normalized_options,
                "document_id": normalized_id,
                "expected_revision": lease.revision,
                "operations": normalized_operations,
            }
            try:
                result = _required_dict(
                    await self._invoke_write(client, {"method": "manage_deck", "params": params}),
                    "deck management result",
                )
                await self._validate_response_scope(result, normalized_id)
                next_revision = None if normalized_options.get("validate_only") is True else _required_string(result.get("revision"), "deck revision")
            except PowerPointOperationError as exc:
                if exc.code in _STALE_REVISION_CODES:
                    await self._clear_document_revisions(normalized_id)
                raise
            except Exception:
                await self._clear_document_revisions(normalized_id)
                raise
            if next_revision is not None:
                async with self._state_lock:
                    self._deck_revisions[normalized_id] = _RevisionLease(next_revision, generation)
                    self._page_revisions = {key: value for key, value in self._page_revisions.items() if key[0] != normalized_id}
            return result

    async def inspect(self, document_id: str, query: dict[str, Any]) -> dict[str, Any]:
        """Inspect the live editor, currently by rendering exact page canvases."""
        normalized_id = str(document_id or "").strip()
        if not normalized_id:
            raise ValueError("document_id is required to inspect PowerPoint")
        normalized_query = _normalized_object(query, "inspection query", allow_empty=False)
        unexpected = set(normalized_query) - {"kind", "page_ids"}
        if unexpected:
            raise ValueError(f"Unsupported PowerPoint inspection query: {sorted(unexpected)[0]}")
        if normalized_query.get("kind") != "render":
            raise ValueError("PowerPoint inspection kind must be render")
        raw_page_ids = normalized_query.get("page_ids")
        if raw_page_ids is not None and (not isinstance(raw_page_ids, list) or not raw_page_ids):
            raise ValueError("PowerPoint render page_ids must be a non-empty array")
        requested = None if raw_page_ids is None else list(dict.fromkeys(str(value or "").strip() for value in raw_page_ids))
        if requested is not None and any(not page_id for page_id in requested):
            raise ValueError("Every PowerPoint render page id must be non-empty")
        if requested is not None and len(requested) > _MAX_RENDER_PAGES:
            raise ValueError(f"PowerPoint rendering accepts at most {_MAX_RENDER_PAGES} pages per call")
        if self._workspace_root is None:
            raise RuntimeError("PowerPoint rendering requires an active Session workspace")
        output_dir = self._workspace_root / ".ppt" / "renders"
        await asyncio.to_thread(output_dir.mkdir, parents=True, exist_ok=True)
        renders: list[dict[str, Any]] = []
        async with self._operation_lock:
            for page_id in requested or [None]:
                params = {"document_id": normalized_id, "kind": "render", **({} if page_id is None else {"page_id": page_id})}
                result = _required_dict(
                    await self._invoke({"method": "inspect", "params": params}, retry_on_failure=True),
                    "inspection result",
                )
                rendered_id = _required_string(result.get("page_id"), "render page id")
                await self._validate_response_scope(result, normalized_id, rendered_id)
                if page_id is not None and rendered_id != page_id:
                    await self._clear_revisions()
                    raise RuntimeError("PowerPoint renderer returned the wrong page")
                revision = _required_string(result.get("revision"), "render revision")
                document_revision = result.get("document_revision")
                if not isinstance(document_revision, int) or isinstance(document_revision, bool) or document_revision < 0:
                    raise RuntimeError("PowerPoint renderer returned an invalid document revision")
                safe_id = "".join(character if character.isalnum() or character in "-_." else "-" for character in rendered_id)
                revision_token = hashlib.sha256(revision.encode("utf-8")).hexdigest()[:16]
                target = output_dir / f"{safe_id}-{revision_token}.png"
                client = await self._host._client_for(self)
                await client.screenshot_page(rendered_id, document_revision, target)
                renders.append({"page_id": rendered_id, "revision": revision, "path": str(target)})
        return {"kind": "render", "renders": renders}

    async def save(self, document_id: str, target: Optional[str] = None) -> dict[str, Any]:
        """Flush one open document to its associated PPTX file."""
        normalized_id = str(document_id or "").strip()
        if not normalized_id:
            raise ValueError("document_id is required to save PowerPoint")
        params: dict[str, Any] = {"document_id": normalized_id}
        if target is not None:
            params["save_as"] = str(Path(target).expanduser().resolve())
        async with self._operation_lock:
            result = _required_dict(
                await self._invoke({"method": "save", "params": params}, retry_on_failure=False),
                "save result",
            )
        if result.get("status") != "saved":
            raise RuntimeError("PowerPoint draft was not saved")
        await self._validate_response_scope(result, normalized_id)
        saved_target = _required_string(result.get("target"), "save target")
        if target is not None and Path(saved_target).resolve() != Path(params["save_as"]):
            raise RuntimeError("PowerPoint renderer returned the wrong save target")
        if self.identity.document_id == normalized_id:
            self._target = Path(saved_target)
            self.identity = PowerPointIdentity(
                session_id=self.session_id,
                document_id=self.identity.document_id,
                name=self.identity.name,
                file_name=self._target.name,
                path=str(self._target),
            )
        return result

    async def read_page(self, document_id: str, page_id: str, query: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Read one page and acquire its private write revision."""
        normalized_document_id = str(document_id or "").strip()
        normalized_page_id = str(page_id or "").strip()
        if not normalized_document_id:
            raise ValueError("document_id is required to read a PowerPoint page")
        if not normalized_page_id:
            raise ValueError("page_id is required to read a PowerPoint page")
        params = _normalized_object(query, "page query")
        unexpected = set(params) - {"format", "element_ids"}
        if unexpected:
            raise ValueError(f"Unsupported PowerPoint page query: {sorted(unexpected)[0]}")
        params.update({"document_id": normalized_document_id, "page_id": normalized_page_id})
        async with self._operation_lock:
            result = _required_dict(
                await self._invoke({"method": "read_page", "params": params}, retry_on_failure=True),
                "page read result",
            )
            revision = _required_string(result.get("revision"), "page revision")
            page = _required_dict(result.get("page"), "page")
            await self._validate_response_scope(result, normalized_document_id, normalized_page_id)
            if _required_string(page.get("id"), "page id") != normalized_page_id:
                await self._clear_revisions()
                raise RuntimeError("PowerPoint renderer returned the wrong page")
            result["assets"] = await self._materialize_assets(result.get("assets", []))
            async with self._state_lock:
                self._page_revisions[(normalized_document_id, normalized_page_id)] = _RevisionLease(
                    revision, self._connection_generation
                )
            return result

    async def close(self) -> bool:
        return await self._host._release_handle(self, discard=False)

    async def _resolve_operation_assets(self, operations: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
        def collect(value: Any) -> list[str]:
            if isinstance(value, dict):
                found = [value["src"]] if isinstance(value.get("src"), str) else []
                return [*found, *(path for nested in value.values() for path in collect(nested))]
            if isinstance(value, list):
                return [path for nested in value for path in collect(nested)]
            return []

        raw_paths = list(dict.fromkeys(collect(operations)))
        root = self._workspace_root
        if root is None and raw_paths:
            raise RuntimeError("PowerPoint assets require an active Session workspace")
        assets: dict[str, dict[str, str]] = {}
        for raw_path in raw_paths:
            relative_path = _required_string(raw_path, "asset path")
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

    async def _remember_deck(self, payload: Any, expected_document_id: Optional[str] = None, reset: bool = False) -> None:
        def validate_pages(raw_pages: Any) -> None:
            if not isinstance(raw_pages, list):
                raise RuntimeError("PowerPoint renderer returned an invalid page list")
            page_ids: set[str] = set()
            page_indexes: set[int] = set()
            for raw_page in raw_pages:
                item = _required_dict(raw_page, "page summary")
                page_id = _required_string(item.get("id"), "page id")
                index = item.get("index")
                if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                    raise RuntimeError("PowerPoint renderer returned an invalid page index")
                _required_string(item.get("revision"), "page revision")
                if page_id in page_ids or index in page_indexes:
                    raise RuntimeError("PowerPoint renderer returned duplicate page metadata")
                page_ids.add(page_id)
                page_indexes.add(index)

        result = _required_dict(payload, "deck result")
        revision = _required_string(result.get("revision"), "deck revision")
        deck = _required_dict(result.get("deck"), "deck")
        document_id = _required_string(deck.get("id"), "document id")
        if _required_string(result.get("document_id"), "document id") != document_id:
            raise RuntimeError("PowerPoint renderer returned the wrong document")
        if expected_document_id is not None and document_id != expected_document_id:
            raise RuntimeError("PowerPoint renderer returned the wrong document")
        validate_pages(deck.get("pages"))
        async with self._state_lock:
            if reset:
                self._deck_revisions.clear()
                self._page_revisions.clear()
            self._deck_revisions[document_id] = _RevisionLease(revision, self._connection_generation)
            self.identity = PowerPointIdentity(
                session_id=self.session_id,
                document_id=document_id,
                name=_optional_string(deck.get("title"), "PPT title"),
                file_name=_optional_string(deck.get("file_name"), "PPT file name"),
                path=str(self._target) if self._target is not None else None,
            )

    async def _materialize_assets(self, payload: Any) -> list[dict[str, str]]:
        if not isinstance(payload, list):
            raise RuntimeError("PowerPoint renderer returned an invalid asset list")
        materialized: list[dict[str, str]] = []
        for raw_asset in payload:
            item = _required_dict(raw_asset, "asset")
            path = _required_string(item.get("path"), "asset path")
            relative = Path(path)
            data_url = item.get("data_url")
            if data_url is not None:
                if not isinstance(data_url, str) or self._workspace_root is None:
                    raise RuntimeError("PowerPoint renderer returned invalid embedded asset data")
                if not relative.parts or relative.parts[0] != ".ppt-assets":
                    raise RuntimeError("PowerPoint renderer returned an unsafe embedded asset path")
                resolved = (self._workspace_root / relative).resolve()
                if relative.is_absolute() or ".." in relative.parts or not resolved.is_relative_to(self._workspace_root):
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
            file_name = _optional_string(item.get("file_name"), "asset file name")
            mime_type = _optional_string(item.get("mime_type"), "asset MIME type")
            materialized.append({
                "path": path,
                **({"file_name": file_name} if file_name is not None else {}),
                **({"mime_type": mime_type} if mime_type is not None else {}),
            })
        return materialized

    async def _clear_page_write_revision(self, document_id: str, page_id: str) -> None:
        async with self._state_lock:
            self._deck_revisions.pop(document_id, None)
            self._page_revisions.pop((document_id, page_id), None)

    async def _clear_document_revisions(self, document_id: str) -> None:
        async with self._state_lock:
            self._deck_revisions.pop(document_id, None)
            self._page_revisions = {key: value for key, value in self._page_revisions.items() if key[0] != document_id}

    async def _clear_revisions(self) -> None:
        async with self._state_lock:
            self._deck_revisions.clear()
            self._page_revisions.clear()

    async def _validate_response_scope(self, result: dict[str, Any], document_id: str, page_id: Optional[str] = None) -> None:
        try:
            returned_document_id = _required_string(result.get("document_id"), "document id")
            returned_page_id = None if page_id is None else _required_string(result.get("page_id"), "page id")
        except RuntimeError:
            await self._clear_revisions()
            raise
        if returned_document_id != document_id:
            await self._clear_revisions()
            raise RuntimeError("PowerPoint renderer returned the wrong document")
        if page_id is not None and returned_page_id != page_id:
            await self._clear_revisions()
            raise RuntimeError("PowerPoint renderer returned the wrong page")

    async def _invoke(self, request: dict[str, Any], retry_on_failure: bool = True) -> Any:
        attempts = 2 if retry_on_failure else 1
        for attempt in range(attempts):
            client: Optional[_SessionPowerPointClient] = None
            try:
                client = await self._host._client_for(self)
                return await client.dispatch(request)
            except PowerPointOperationError:
                raise
            except Exception:
                if client is not None:
                    await self._host._discard_client(self, client)
                if attempt + 1 >= attempts:
                    raise
        raise RuntimeError("PowerPoint request failed")

    async def _invoke_write(self, client: _SessionPowerPointClient, request: dict[str, Any]) -> Any:
        try:
            return await client.dispatch(request)
        except PowerPointOperationError:
            raise
        except Exception:
            await self._host._discard_client(self, client)
            raise

    async def _clear(self) -> None:
        async with self._state_lock:
            self.identity = PowerPointIdentity(session_id=self.session_id)
            self._target = None
            self._deck_revisions.clear()
            self._page_revisions.clear()



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
                ppt._connection_generation += 1
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
    "PowerPointHost",
    "PowerPointIdentity",
    "PowerPointOperationError",
    "PowerPointUnavailableError",
    "SessionPowerPoint",
]
