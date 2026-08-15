from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
import urllib.error
import urllib.request
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Optional

from bridgic.browser.session import Browser
from bridgic.browser.utils import find_page_by_id, generate_page_id
from playwright.async_api import BrowserContext, Page
from playwright.async_api import async_playwright

from .runtime._environment import bundled_node_runtime

logger = logging.getLogger(__name__)

_TARGET_PAGE_TIMEOUT_SECONDS = 10.0
_POST_ACTION_SNAPSHOT_LIMIT = 10_000
_INLINE_SNAPSHOT_PREVIEW_MAX_CHARS = 10_000
_POST_ACTION_FULL_SETTLE_SECONDS = 3.0
_POST_ACTION_SHORT_SETTLE_SECONDS = 1.0
_POST_ACTION_RENDER_SETTLE_SECONDS = 0.2
_POST_ACTION_DOM_QUIET_SECONDS = 0.4
_POST_ACTION_SETTLE_MARGIN_SECONDS = 0.05
_CONTROLLER_TIMEOUT_SECONDS = 3.0
_EMBEDDED_ATTACH_TIMEOUT_SECONDS = 15.0
_EMBEDDED_CLEANUP_TIMEOUT_SECONDS = 5.0
_EMBEDDED_TAB_CLOSE_TIMEOUT_SECONDS = 5.0
_EMBEDDED_POPUP_OWNERSHIP_TIMEOUT_SECONDS = 1.0
_SESSION_STATE_TIMEOUT_SECONDS = 1.0
_SNAPSHOT_REF_PATTERN = re.compile(r"\[ref=([^\]]+)\]")
_DOM_QUIET_SCRIPT = """({quietMs, timeoutMs}) => new Promise((resolve) => {
    let finished = false;
    let quietTimer;
    let timeoutTimer;
    const root = document.documentElement || document;
    const finish = (reason) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        resolve(reason);
    };
    const armQuietTimer = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish("quiet"), quietMs);
    };
    const observer = new MutationObserver(armQuietTimer);
    observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
            "aria-busy", "aria-label", "aria-hidden", "aria-disabled",
            "aria-expanded", "aria-selected", "aria-checked", "class",
            "contenteditable", "disabled", "hidden", "href", "name", "open",
            "placeholder", "role", "src", "style", "tabindex", "type", "value"
        ]
    });
    armQuietTimer();
    timeoutTimer = setTimeout(() => finish("timeout"), timeoutMs);
})"""


class _EmbeddedTargetAttachTimeout(TimeoutError):
    """Raised when Electron owns a target Playwright has not attached."""


class EmbeddedBrowserUnavailableError(RuntimeError):
    """Raised when the desktop App cannot provide its embedded browser."""


_EMBEDDED_BROWSER_UNAVAILABLE_MESSAGE = (
    "The browser is unavailable because the desktop app is not running "
    "or its browser connection was interrupted. Open the desktop app (it may remain "
    "hidden in the tray) and retry."
)


def _embedded_browser_unavailable(
    cause: Optional[BaseException] = None,
) -> EmbeddedBrowserUnavailableError:
    error = EmbeddedBrowserUnavailableError(_EMBEDDED_BROWSER_UNAVAILABLE_MESSAGE)
    if cause is not None:
        error.__cause__ = cause
    return error


@dataclass(frozen=True)
class _EmbeddedSessionTabs:
    """Exact target projection owned by one Electron Session surface."""

    active_target_id: Optional[str]
    target_ids: frozenset[str]
    state: Optional["SessionBrowserState"] = None


@dataclass(frozen=True)
class SessionBrowserTab:
    """Lightweight prompt-safe description of one open browser tab."""

    title: str
    url: str


@dataclass(frozen=True)
class SessionBrowserState:
    """Read-only projection of a Session's currently allocated browser surface."""

    tabs: tuple[SessionBrowserTab, ...]
    active_tab: Optional[SessionBrowserTab]


@dataclass(frozen=True)
class _EmbeddedBrowserController:
    """Authenticated loopback controller published by the Electron App."""

    controller_id: str
    generation: str
    control_url: str
    control_token: str
    cdp_endpoint: str
    owner_pid: int

    async def health(self) -> None:
        await asyncio.to_thread(self._request, "GET", "/v1/health", None)

    async def ensure_session(self, session_id: str) -> _EmbeddedSessionTabs:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/ensure",
            {"session_id": session_id},
        )
        return self._session_tabs(response, session_id)

    async def list_tabs(self, session_id: str) -> _EmbeddedSessionTabs:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/tabs/list",
            {"session_id": session_id},
        )
        return self._session_tabs(response, session_id)

    async def create_tab(self, session_id: str) -> _EmbeddedSessionTabs:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/tabs/create",
            {"session_id": session_id},
        )
        return self._session_tabs(response, session_id)

    async def activate_tab(self, session_id: str, target_id: str) -> _EmbeddedSessionTabs:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/tabs/activate",
            {"session_id": session_id, "target_id": target_id},
        )
        return self._session_tabs(response, session_id)

    async def close_tab(self, session_id: str, target_id: str) -> _EmbeddedSessionTabs:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/tabs/close",
            {"session_id": session_id, "target_id": target_id},
        )
        return self._session_tabs(response, session_id)

    async def release_session(self, session_id: str) -> None:
        await asyncio.to_thread(
            self._request,
            "POST",
            "/v1/sessions/release",
            {"session_id": session_id},
        )

    def public_status(self) -> dict[str, Any]:
        return {
            "available": True,
            "controller_id": self.controller_id,
            "generation": self.generation,
            "owner_pid": self.owner_pid,
        }

    def _session_tabs(
        self, response: dict[str, Any], expected_session_id: str,
    ) -> _EmbeddedSessionTabs:
        session_id = response.get("session_id")
        if session_id != expected_session_id:
            raise RuntimeError("Electron browser controller returned the wrong session")
        tabs = response.get("tabs")
        if not isinstance(tabs, list):
            raise RuntimeError("Electron browser controller returned no tab inventory")
        active_tab_id = response.get("active_tab_id")
        if active_tab_id is not None and (not isinstance(active_tab_id, str) or not active_tab_id):
            raise RuntimeError("Electron browser controller returned an invalid active tab")
        target_ids: set[str] = set()
        target_by_tab_id: dict[str, Optional[str]] = {}
        tab_ids: set[str] = set()
        tab_states: list[SessionBrowserTab] = []
        active_tab_index: Optional[int] = None
        for tab in tabs:
            if not isinstance(tab, dict):
                raise RuntimeError("Electron browser controller returned an invalid tab")
            tab_id = tab.get("tab_id")
            if not isinstance(tab_id, str) or not tab_id or tab_id in tab_ids:
                raise RuntimeError("Electron browser controller returned an invalid tab id")
            tab_ids.add(tab_id)
            target_id = tab.get("target_id")
            if target_id is not None and (not isinstance(target_id, str) or not target_id):
                raise RuntimeError("Electron browser controller returned an invalid target")
            if target_id is not None:
                if target_id in target_ids:
                    raise RuntimeError("Electron browser controller returned a duplicate target")
                target_ids.add(target_id)
            target_by_tab_id[tab_id] = target_id
            title = tab.get("title", "")
            url = tab.get("url", "")
            if not isinstance(title, str) or not isinstance(url, str):
                raise RuntimeError("Electron browser controller returned invalid tab metadata")
            if tab_id == active_tab_id:
                active_tab_index = len(tab_states)
            tab_states.append(SessionBrowserTab(title=title, url=url))
        if active_tab_id is not None and active_tab_id not in tab_ids:
            raise RuntimeError("Electron browser controller returned an unknown active tab")
        active_target_id = response.get("active_target_id")
        if active_target_id is not None and (
            not isinstance(active_target_id, str) or active_target_id not in target_ids
        ):
            raise RuntimeError("Electron browser controller returned an invalid active target")
        if active_tab_id is not None and target_by_tab_id[active_tab_id] != active_target_id:
            raise RuntimeError("Electron browser controller returned mismatched active targets")
        state = None
        if tab_states:
            state_tabs = tuple(tab_states)
            state = SessionBrowserState(
                tabs=state_tabs,
                active_tab=(
                    state_tabs[active_tab_index]
                    if active_tab_index is not None
                    else None
                ),
            )
        return _EmbeddedSessionTabs(
            active_target_id=active_target_id,
            target_ids=frozenset(target_ids),
            state=state,
        )

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
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
            # Authentication failures and server failures indicate that the App
            # controller itself is unusable. Ordinary domain 4xx responses are
            # operation errors and must not invalidate sibling Sessions.
            if exc.code == 401 or exc.code >= 500:
                raise _embedded_browser_unavailable(exc)
            try:
                error_payload = exc.read()
                parsed_error = json.loads(error_payload.decode("utf-8"))
                error = parsed_error.get("error") if isinstance(parsed_error, dict) else None
                detail = (
                    f": {error.strip()}"
                    if isinstance(error, str) and error.strip()
                    else ""
                )
            except (OSError, UnicodeError, json.JSONDecodeError):
                detail = ""
            raise RuntimeError(
                f"Electron browser controller rejected the request (HTTP {exc.code}){detail}",
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise _embedded_browser_unavailable(exc)
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("Electron browser controller returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("Electron browser controller returned an invalid response")
        return parsed


class _SessionBrowserClient(Browser):
    """Bind one bridgic client to one Session-owned embedded page.

    This compatibility adapter deliberately contains every dependency on
    bridgic-browser's private Page ownership hooks. The dependency is pinned by
    the application lockfile and covered by focused contract tests, keeping the
    rest of the Agent independent of those implementation details.
    """

    def __init__(
        self,
        *,
        snapshot_output_dir: Optional[Path] = None,
        embedded_controller: Optional[_EmbeddedBrowserController] = None,
        embedded_session_id: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        self._snapshot_output_dir = (
            Path(snapshot_output_dir).expanduser().resolve()
            if snapshot_output_dir is not None
            else None
        )
        self._embedded_controller = embedded_controller
        self._embedded_session_id = embedded_session_id
        self._adoption_tasks: set[asyncio.Task[None]] = set()
        self._page_event_revision = 0
        self._facility_lock = asyncio.Lock()
        self._facilities_page: Optional[Page] = None
        self._embedded = False
        super().__init__(**kwargs)

    def _write_snapshot_file(self, content: str, file: Optional[str] = None) -> str:
        """Route automatically spilled snapshots into this Session's tool results."""
        if file is not None or self._snapshot_output_dir is None:
            return super()._write_snapshot_file(content, file)

        day_dir = self._snapshot_output_dir / datetime.now().strftime("%Y-%m-%d")
        timestamp = datetime.now().strftime("%H%M%S_%f")
        while True:
            path = day_dir / f"browser_snapshot_{timestamp}_{secrets.token_hex(4)}.txt"
            if not path.exists():
                break
        return super()._write_snapshot_file(content, str(path))

    async def get_snapshot_text(
        self,
        limit: int = _POST_ACTION_SNAPSHOT_LIMIT,
        interactive: bool = False,
        full_page: bool = True,
        file: Optional[str] = None,
    ) -> str:
        """Retain actionable refs inline when the complete snapshot spills."""
        rendered = await super().get_snapshot_text(
            limit=limit,
            interactive=interactive,
            full_page=full_page,
            file=file,
        )
        if "[notice] Snapshot file (" not in rendered:
            return rendered

        snapshot = getattr(self, "_last_snapshot", None)
        if snapshot is None:
            return rendered
        preview_lines = self._actionable_snapshot_lines(snapshot.tree, snapshot.refs)
        budget = min(max(int(limit), 0), _INLINE_SNAPSHOT_PREVIEW_MAX_CHARS)
        selected: list[str] = []
        used = 0
        for line in preview_lines:
            required = len(line) + (1 if selected else 0)
            if used + required > budget:
                break
            selected.append(line)
            used += required

        header, separator, notice = rendered.rstrip("\n").partition("\n")
        parts = [header]
        if separator and notice:
            parts.append(notice)
        if not preview_lines:
            parts.append(
                "[Actionable preview from the same saved snapshot: no actionable "
                "element refs were present.]"
            )
            return "\n".join(parts)

        parts.append(
            "[Actionable preview from the same saved snapshot: "
            f"showing {len(selected)} of {len(preview_lines)} ref lines within "
            f"the {budget}-character inline budget.]"
        )
        parts.extend(selected)
        if len(selected) < len(preview_lines):
            parts.append(
                "[Actionable preview truncated; inspect the reported full-snapshot "
                "file for the remaining state instead of recapturing this page.]"
            )
        return "\n".join(parts)

    async def discard_prefetched_snapshot(self) -> None:
        """Cancel and join snapshot prewarming before the canonical capture."""
        task = getattr(self, "_prefetch_task", None)
        self._cancel_prefetch()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    def _actionable_snapshot_lines(self, tree: str, refs: dict[str, Any]) -> list[str]:
        """Select actionable ref lines without generating a second snapshot."""
        generator = getattr(self, "_snapshot_generator", None)
        interactive_roles = set(getattr(generator, "INTERACTIVE_ROLES", ()))
        aria_action_markers = (
            "[checked",
            "[expanded",
            "[pressed",
            "[selected",
        )
        lines: list[str] = []
        for line in tree.splitlines():
            match = _SNAPSHOT_REF_PATTERN.search(line)
            if match is None:
                continue
            ref_data = refs.get(match.group(1))
            role = str(getattr(ref_data, "role", "") or "").lower()
            if (
                role in interactive_roles
                or "[cursor=pointer]" in line
                or any(marker in line for marker in aria_action_markers)
            ):
                lines.append(line.lstrip())
        return lines

    async def start_and_bind_embedded(self, target_id: str) -> None:
        """Attach directly to an Electron-owned page without creating a bootstrap tab."""
        if self._playwright is not None:
            raise RuntimeError("The browser connection is already active")
        if not self._cdp_raw:
            raise RuntimeError("The browser connection has no CDP endpoint")

        self._closing = False
        stage = "starting Playwright"
        try:
            async with asyncio.timeout(_EMBEDDED_ATTACH_TIMEOUT_SECONDS):
                self._playwright = await async_playwright().start()
                self._cdp_resolved = str(self._cdp_raw)
                stage = "connecting to Electron CDP"
                self._browser = await self._playwright.chromium.connect_over_cdp(
                    self._cdp_resolved,
                )
                if not self._browser.contexts:
                    raise RuntimeError("Electron CDP exposed no browser context")
                self._cdp_context_owned = False
                stage = "binding the Session page"
                context, target_page = await self._wait_for_embedded_target_page(target_id)
                self._context = context
                self._embedded = True
                self._mark_owned(target_page)
                self._page = target_page
                self._context.on("page", self._on_new_page)
                stage = "activating page facilities"
                await self._activate_page_facilities(target_page)
        except TimeoutError as exc:
            with suppress(Exception):
                await asyncio.wait_for(
                    self.disconnect_embedded(),
                    timeout=_EMBEDDED_CLEANUP_TIMEOUT_SECONDS,
                )
            raise TimeoutError(f"Timed out while {stage}") from exc
        except BaseException:
            with suppress(Exception):
                await asyncio.wait_for(
                    self.disconnect_embedded(),
                    timeout=_EMBEDDED_CLEANUP_TIMEOUT_SECONDS,
                )
            raise

    async def disconnect_embedded(self) -> str:
        """Disconnect Playwright without closing Electron-owned pages."""
        if self._embedded:
            self._owned_pages.clear()
            self._focus_stack.clear()
        try:
            return await super().close()
        finally:
            self._embedded = False

    async def settle_page_events(self, deadline: Optional[float] = None) -> bool:
        """Wait for popup/tab ownership decisions within a shared deadline."""
        loop = asyncio.get_running_loop()
        event_deadline = deadline if deadline is not None else loop.time() + 0.1
        while True:
            revision = self._page_event_revision
            pending = tuple(self._adoption_tasks)
            if pending:
                remaining = event_deadline - loop.time()
                if remaining <= 0:
                    return False
                done, still_pending = await asyncio.wait(
                    pending,
                    timeout=remaining,
                )
                if done:
                    await asyncio.gather(*done, return_exceptions=True)
                    self._adoption_tasks.difference_update(done)
                if still_pending:
                    return False
                continue

            remaining = event_deadline - loop.time()
            if remaining <= 0:
                return True
            await asyncio.sleep(min(0.01, remaining))
            if revision == self._page_event_revision and not self._adoption_tasks:
                return True

    async def settle_page_state(self, max_wait_seconds: float) -> bool:
        """Wait for DOM quiet and report whether page ownership is safe to capture.

        A DOM that remains dynamic through the bounded wait is still captured
        best-effort; unresolved page or popup adoption is not.
        """
        if max_wait_seconds <= 0:
            return True
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max_wait_seconds
        initial_delay = min(0.3, max_wait_seconds / 2)
        await asyncio.sleep(initial_delay)

        while True:
            if not await self.settle_page_events(deadline):
                return False
            remaining = deadline - loop.time()
            if remaining <= 0:
                return True
            page = self._page
            if page is None or page.is_closed():
                return True
            quiet_seconds = min(
                _POST_ACTION_DOM_QUIET_SECONDS,
                max(0.05, remaining * 0.8),
            )
            try:
                reason = await asyncio.wait_for(
                    page.evaluate(
                        _DOM_QUIET_SCRIPT,
                        {
                            "quietMs": max(1, int(quiet_seconds * 1000)),
                            "timeoutMs": max(1, int(remaining * 1000)),
                        },
                    ),
                    timeout=remaining,
                )
                if not await self.settle_page_events(deadline):
                    return False
                if page is not self._page:
                    continue
                if reason != "quiet":
                    logger.debug("DOM remained dynamic through the snapshot settle budget")
                return True
            except asyncio.CancelledError:
                raise
            except Exception:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    logger.debug("DOM quiet wait reached its deadline; capturing best-effort")
                    return not self._adoption_tasks
                await asyncio.sleep(min(0.05, remaining))

    def _on_new_page(self, page: Page) -> None:
        if self._closing:
            return
        self._page_event_revision += 1
        try:
            task = asyncio.create_task(self._maybe_adopt_page(page))
        except RuntimeError:
            return
        self._adoption_tasks.add(task)
        task.add_done_callback(self._adoption_tasks.discard)

    async def _maybe_adopt_page(self, page: Page) -> None:
        if self._closing:
            return
        if self._embedded:
            if page in self._owned_pages:
                return
            binding = self._embedded_binding()
            if binding is None:
                return
            controller, session_id = binding
            try:
                target_id = await self._target_id(page)
                tabs = await self._wait_for_embedded_page_owner(
                    controller, session_id, target_id,
                )
            except Exception:
                logger.debug("Could not reconcile a new embedded page", exc_info=True)
                return
            if tabs is None or self._closing:
                return
            self._mark_owned(page)
            if self._auto_follow_popups and tabs.active_target_id == target_id:
                with suppress(Exception):
                    await self._switch_local_page_to(page)
            return

    async def _new_page(
        self,
        url: Optional[str] = None,
        wait_until: Literal["domcontentloaded", "load", "networkidle", "commit"] = "domcontentloaded",
        timeout: Optional[float] = None,
    ) -> Page:
        """Open a Session-owned tab in the embedded surface."""
        controller, session_id = self._require_embedded_binding()
        tabs = await controller.create_tab(session_id)
        target_id = tabs.active_target_id
        if target_id is None:
            raise RuntimeError("Electron did not activate the new browser tab")
        _context, page = await self._wait_for_embedded_target_page(target_id)
        self._mark_owned(page)
        await self._switch_local_page_to(page)
        if url:
            await self.navigate_to(url, wait_until=wait_until, timeout=timeout)
        return page

    async def _switch_self_page_to(self, new_page: Page) -> None:
        binding = self._embedded_binding()
        if binding is not None:
            controller, session_id = binding
            target_id = await self._target_id(new_page)
            tabs = await controller.activate_tab(session_id, target_id)
            if tabs.active_target_id != target_id:
                raise RuntimeError("Electron did not activate the requested browser tab")
        await self._switch_local_page_to(new_page)

    async def _switch_local_page_to(self, new_page: Page) -> None:
        await super()._switch_self_page_to(new_page)
        if self._page is new_page:
            await self._activate_page_facilities(new_page)

    async def switch_to_page(self, page_id: str) -> tuple[bool, str]:
        """Select the Agent's logical page without changing OS or Chrome focus."""
        if self._context is None:
            return False, "No context is open, can't switch to page"
        page = find_page_by_id(self.get_pages(), page_id)
        if page is None:
            return False, f"Page with page_id '{page_id}' not found"
        await self._switch_self_page_to(page)
        title = await self._get_page_title(page)
        return True, f"Switched to tab {page_id}: {page.url} (title: {title})"

    async def _close_page(self, page: Page | str) -> tuple[bool, str]:
        resolved_page: Optional[Page]
        if isinstance(page, str):
            resolved_page = find_page_by_id(self.get_pages(), page)
        else:
            resolved_page = page
        binding = self._embedded_binding()
        if binding is not None:
            if resolved_page is None:
                return False, f"Page with page_id '{page}' not found"
            return await self._close_embedded_page(resolved_page, binding)
        raise RuntimeError("Electron browser tab controller is unavailable")

    async def sync_embedded_tabs(self) -> None:
        """Reconcile this client's exact owned Page set with Electron."""
        binding = self._embedded_binding()
        if binding is None:
            return
        controller, session_id = binding
        tabs = await controller.list_tabs(session_id)
        await self._reconcile_embedded_tabs(tabs)

    async def _close_embedded_page(
        self,
        page: Page,
        binding: tuple[_EmbeddedBrowserController, str],
    ) -> tuple[bool, str]:
        controller, session_id = binding
        page_id = generate_page_id(page)
        target_id = await self._target_id(page)
        was_current = self._page is page
        if was_current:
            await self._deactivate_page_facilities(page)
        try:
            tabs = await controller.close_tab(session_id, target_id)
        except BaseException:
            if was_current and not page.is_closed():
                with suppress(Exception):
                    await self._activate_page_facilities(page)
            raise

        deadline = asyncio.get_running_loop().time() + _EMBEDDED_TAB_CLOSE_TIMEOUT_SECONDS
        while not page.is_closed() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        if not page.is_closed():
            raise TimeoutError("Electron did not close the requested browser tab")

        self._owned_pages.discard(page)
        with suppress(ValueError):
            self._focus_stack.remove(page)
        if was_current:
            self._page = None
            self._invalidate_page_state()
        await self._reconcile_embedded_tabs(tabs)

        if self._page is not None:
            active_id = generate_page_id(self._page)
            title = await self._get_page_title(self._page)
            return (
                True,
                f"Closed tab {page_id}. Now on {active_id}: "
                f"{self._page.url} (title: {title})",
            )
        return True, f"Closed tab {page_id}. No tabs remaining"

    async def _reconcile_embedded_tabs(self, tabs: _EmbeddedSessionTabs) -> None:
        context = self._context
        if context is None:
            return
        pages_by_target: dict[str, Page] = {}
        for page in list(context.pages):
            if page.is_closed():
                continue
            with suppress(Exception):
                pages_by_target[await self._target_id(page)] = page

        active_target_id = tabs.active_target_id
        if active_target_id is not None and active_target_id not in pages_by_target:
            _context, active_page = await self._wait_for_embedded_target_page(active_target_id)
            pages_by_target[active_target_id] = active_page

        for page in list(self._owned_pages):
            target_id: Optional[str] = None
            if not page.is_closed():
                with suppress(Exception):
                    target_id = await self._target_id(page)
            if target_id not in tabs.target_ids:
                self._owned_pages.discard(page)
                with suppress(ValueError):
                    self._focus_stack.remove(page)

        for target_id in tabs.target_ids:
            owned_page = pages_by_target.get(target_id)
            if owned_page is not None:
                self._mark_owned(owned_page)

        if active_target_id is None:
            current = self._page
            if current is not None:
                await self._deactivate_page_facilities(current)
            self._page = None
            self._invalidate_page_state()
            return
        active_page = pages_by_target.get(active_target_id)
        if active_page is None:
            raise RuntimeError("Electron browser active tab is not attached to Playwright")
        if self._page is not active_page:
            await self._switch_local_page_to(active_page)

    def _embedded_binding(self) -> Optional[tuple[_EmbeddedBrowserController, str]]:
        if not self._embedded:
            return None
        controller = self._embedded_controller
        session_id = self._embedded_session_id
        if controller is None or session_id is None:
            return None
        return controller, session_id

    def _require_embedded_binding(self) -> tuple[_EmbeddedBrowserController, str]:
        binding = self._embedded_binding()
        if binding is None:
            raise RuntimeError("Electron browser tab controller is unavailable")
        return binding

    async def _wait_for_embedded_page_owner(
        self,
        controller: _EmbeddedBrowserController,
        session_id: str,
        target_id: str,
    ) -> Optional[_EmbeddedSessionTabs]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _EMBEDDED_POPUP_OWNERSHIP_TIMEOUT_SECONDS
        while not self._closing:
            tabs = await controller.list_tabs(session_id)
            if target_id in tabs.target_ids:
                return tabs
            remaining = deadline - loop.time()
            if remaining <= 0:
                return None
            await asyncio.sleep(min(0.02, remaining))
        return None

    async def get_tabs(self) -> str:
        """List only this Session's tabs without leaking sibling tab counts."""
        result = await super().get_tabs()
        if result.startswith("# Note:"):
            _note, separator, tabs = result.partition("\n\n")
            return tabs if separator else "No open tabs"
        return result

    async def read_state(self) -> Optional[SessionBrowserState]:
        """Describe already-attached pages without creating or adopting a page."""
        pages = [page for page in self.get_pages() if not page.is_closed()]
        if not pages:
            return None
        tabs: list[SessionBrowserTab] = []
        active_index: Optional[int] = None
        for page in pages:
            if page is self._page:
                active_index = len(tabs)
            url = str(page.url or "")
            try:
                title = str(await page.title() or "")
            except Exception:
                title = ""
            tabs.append(SessionBrowserTab(title=title, url=url))
        state_tabs = tuple(tabs)
        return SessionBrowserState(
            tabs=state_tabs,
            active_tab=state_tabs[active_index] if active_index is not None else None,
        )

    async def _wait_for_embedded_target_page(
        self, target_id: str,
    ) -> tuple[BrowserContext, Page]:
        browser = self._browser
        if browser is None:
            raise RuntimeError("The browser connection is not active")
        deadline = time.monotonic() + _TARGET_PAGE_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            for context in browser.contexts:
                self._context = context
                for page in context.pages:
                    if page.is_closed():
                        continue
                    with suppress(Exception):
                        if await self._target_id(page) == target_id:
                            return context, page
            await asyncio.sleep(0.02)
        raise _EmbeddedTargetAttachTimeout(
            f"Electron target {target_id!r} did not attach to the Session client",
        )

    async def _activate_page_facilities(self, page: Page) -> None:
        async with self._facility_lock:
            if self._closing or self._page is not page:
                return
            await self._rebind_page_facilities(page)

    async def _deactivate_page_facilities(self, page: Page) -> None:
        async with self._facility_lock:
            if self._facilities_page is not page:
                return
            await self._detach_page_facilities()

    async def _detach_page_facilities(self) -> None:
        renamer = self._cdp_download_renamer
        self._cdp_download_renamer = None
        if renamer is not None:
            with suppress(Exception):
                await renamer.detach()
        old_session = self._cdp_download_session
        self._cdp_download_session = None
        if old_session is not None:
            with suppress(Exception):
                await old_session.detach()
        self._current_cdp_download_path = None
        self._facilities_page = None

    async def _rebind_page_facilities(self, page: Page) -> None:
        """Move page-scoped downloads and debugger handling to ``page``."""
        context = self._context
        if context is None:
            raise RuntimeError("The bridgic browser client has no context")
        if self._facilities_page is page and self._cdp_download_session is not None:
            return

        await self._detach_page_facilities()

        download_path = self._effective_cdp_downloads_path()
        try:
            session = await context.new_cdp_session(page)
        except Exception:
            logger.warning("Could not attach downloads to the Session page", exc_info=True)
            return
        try:
            await session.send("Debugger.setSkipAllPauses", {"skip": True})
        except Exception:
            logger.debug("Could not set debugger handling on the Session page", exc_info=True)
        ready = await self._set_cdp_download_behavior(
            "allowAndName",
            download_path=download_path,
            reason="session-bind",
            events_enabled=True,
            session=session,
        )
        if not ready:
            with suppress(Exception):
                await session.detach()
            return

        self._cdp_download_session = session
        self._current_cdp_download_path = download_path
        self._facilities_page = page
        try:
            from bridgic.browser.session._cdp_download_renamer import CdpDownloadRenamer

            renamer = CdpDownloadRenamer(default_dir=download_path)
            await renamer.attach(session)
            self._cdp_download_renamer = renamer
        except Exception:
            logger.warning("Could not attach the Session download renamer", exc_info=True)

    async def _target_id(self, page: Page) -> str:
        context = self._context
        if context is None:
            raise RuntimeError("The bridgic browser client has no context")
        session = await context.new_cdp_session(page)
        try:
            result = await session.send("Target.getTargetInfo")
            return str(result["targetInfo"]["targetId"])
        finally:
            with suppress(Exception):
                await session.detach()


class SessionBrowser:
    """The exact-Session browser surface exposed to Agent tools.

    A Session handle is cheap and does not start a browser surface. Its first
    operation asks :class:`BrowserHost` for an Electron-owned embedded page.
    Calls are serialized per Session while other Sessions remain independently
    usable.
    """

    _METHODS = frozenset({
        "navigate_to",
        "get_snapshot_text",
        "click_element_by_ref",
        "input_text_by_ref",
        "go_back",
        "mouse_wheel",
        "press_key",
        "go_forward",
        "reload_page",
        "get_current_page_info",
        "search",
        "get_tabs",
        "new_tab",
        "switch_tab",
        "close_tab",
        "wait_for",
        "wait_for_network_idle",
        "take_screenshot",
        "verify_text_visible",
        "verify_element_state",
        "verify_url",
        "verify_title",
        "scroll_to_text",
        "hover_element_by_ref",
        "focus_element_by_ref",
        "select_dropdown_option_by_ref",
        "check_checkbox_or_radio_by_ref",
        "uncheck_checkbox_by_ref",
        "fill_form",
        "scroll_element_into_view_by_ref",
        "get_dropdown_options_by_ref",
        "double_click_element_by_ref",
        "upload_file_by_ref",
        "drag_element_by_ref",
        "evaluate_javascript",
        "evaluate_javascript_on_ref",
        "type_text",
        "key_down",
        "key_up",
        "mouse_click",
        "mouse_move",
        "mouse_drag",
        "mouse_down",
        "mouse_up",
        "save_pdf",
        "start_network_capture",
        "get_network_requests",
        "stop_network_capture",
        "setup_dialog_handler",
        "handle_dialog",
        "remove_dialog_handler",
        "get_cookies",
        "set_cookie",
        "clear_cookies",
        "save_storage_state",
        "restore_storage_state",
        "verify_element_visible",
        "verify_value",
        "start_console_capture",
        "get_console_messages",
        "stop_console_capture",
        "start_tracing",
        "add_trace_chunk",
        "stop_tracing",
        "start_video",
        "stop_video",
        "browser_resize",
    })

    _STATE_ADVANCING_METHODS = frozenset({
        "navigate_to",
        "click_element_by_ref",
        "input_text_by_ref",
        "go_back",
        "mouse_wheel",
        "press_key",
        "go_forward",
        "reload_page",
        "search",
        "new_tab",
        "switch_tab",
        "close_tab",
        "wait_for",
        "wait_for_network_idle",
        "scroll_to_text",
        "hover_element_by_ref",
        "focus_element_by_ref",
        "select_dropdown_option_by_ref",
        "check_checkbox_or_radio_by_ref",
        "uncheck_checkbox_by_ref",
        "fill_form",
        "scroll_element_into_view_by_ref",
        "double_click_element_by_ref",
        "upload_file_by_ref",
        "drag_element_by_ref",
        "evaluate_javascript",
        "evaluate_javascript_on_ref",
        "type_text",
        "key_down",
        "key_up",
        "mouse_click",
        "mouse_move",
        "mouse_drag",
        "mouse_down",
        "mouse_up",
        "browser_resize",
    })
    _FULL_POST_ACTION_SETTLE_METHODS = frozenset({
        "navigate_to",
        "click_element_by_ref",
        "input_text_by_ref",
        "go_back",
        "press_key",
        "go_forward",
        "reload_page",
        "search",
        "new_tab",
        "scroll_to_text",
        "select_dropdown_option_by_ref",
        "check_checkbox_or_radio_by_ref",
        "uncheck_checkbox_by_ref",
        "fill_form",
        "double_click_element_by_ref",
        "upload_file_by_ref",
        "drag_element_by_ref",
        "evaluate_javascript",
        "evaluate_javascript_on_ref",
        "type_text",
        "mouse_click",
        "mouse_drag",
    })
    _SHORT_POST_ACTION_SETTLE_METHODS = frozenset({
        "mouse_wheel",
        "switch_tab",
        "close_tab",
        "hover_element_by_ref",
        "focus_element_by_ref",
        "scroll_element_into_view_by_ref",
        "key_down",
        "key_up",
        "mouse_move",
        "mouse_down",
        "mouse_up",
    })
    _RENDER_POST_ACTION_SETTLE_METHODS = frozenset({
        "wait_for",
        "wait_for_network_idle",
        "browser_resize",
    })
    _LATEST_SNAPSHOT_LABEL = (
        "[Latest page snapshot bundle after browser action — use the inline refs "
        "before the next action; inspect any reported full-snapshot file before "
        "recapturing this page]"
    )

    def __init__(
        self,
        host: "BrowserHost",
        session_id: str,
        *,
        tool_result_dir: Optional[Path] = None,
    ) -> None:
        self._host = host
        self.session_id = session_id
        self.tool_result_dir = (
            Path(tool_result_dir).expanduser().resolve()
            if tool_result_dir is not None
            else None
        )
        self._operation_lock = asyncio.Lock()
        self._client: Optional[_SessionBrowserClient] = None
        self._owner_generation: Optional[int] = None
        self._embedded_controller: Optional[_EmbeddedBrowserController] = None

    def bind_tool_result_dir(self, tool_result_dir: Path) -> None:
        """Bind an unstarted handle to its owning Workspace's private output root."""
        resolved = Path(tool_result_dir).expanduser().resolve()
        if self.tool_result_dir == resolved:
            return
        if self.tool_result_dir is not None:
            raise ValueError(
                f"Browser {self.session_id!r} is already bound to another output directory"
            )
        if self._client is not None:
            raise RuntimeError("Cannot bind browser snapshot output after the client has started")
        self.tool_result_dir = resolved

    def _client_is_live(self, client: _SessionBrowserClient) -> bool:
        if self._owner_generation != self._host._owner_generation or client._closing:
            return False
        try:
            browser = client._browser
            return (
                browser is not None
                and browser.is_connected()
                and any(not page.is_closed() for page in client.get_pages())
            )
        except Exception:
            return False

    async def invoke(self, method_name: str, *args: Any, **kwargs: Any) -> Any:
        """Invoke one approved bridgic Page operation inside this Session surface."""
        if method_name not in self._METHODS:
            raise AttributeError(f"Unsupported browser operation: {method_name}")
        async with self._operation_lock:
            client = await self._host._client_for(self)
            client = await self._sync_embedded_client(client)
            await client.settle_page_events()
            method = getattr(client, method_name)
            try:
                try:
                    result = await method(*args, **kwargs)
                finally:
                    if method_name not in self._STATE_ADVANCING_METHODS:
                        await client.settle_page_events()
            except asyncio.CancelledError:
                raise
            except EmbeddedBrowserUnavailableError:
                await self._host._invalidate_controller(client._embedded_controller)
                await self._host._discard_stale_client(self, client)
                raise
            except _EmbeddedTargetAttachTimeout:
                await self._host._discard_stale_client(self, client)
                raise
            except Exception as exc:
                if method_name in self._STATE_ADVANCING_METHODS:
                    if await self._settle_after_action(client, method_name):
                        try:
                            snapshot = await self._capture_post_action_snapshot(client)
                        except Exception:
                            logger.debug(
                                "Could not capture browser state after failed %s",
                                method_name,
                                exc_info=True,
                            )
                        else:
                            detail = self._snapshot_detail(snapshot)
                            if not self._append_detail_to_error(exc, detail):
                                raise RuntimeError(f"{exc}\n\n{detail}") from exc
                raise

            if method_name not in self._STATE_ADVANCING_METHODS:
                return result
            if not await self._settle_after_action(client, method_name):
                return self._append_action_detail(
                    result,
                    "[Browser action succeeded, but the latest page snapshot is "
                    "unavailable because browser state did not settle safely "
                    "within the bounded wait.]",
                )
            try:
                snapshot = await self._capture_post_action_snapshot(client)
            except Exception as exc:
                logger.debug(
                    "Browser action %s succeeded but its follow-up snapshot failed",
                    method_name,
                    exc_info=True,
                )
                message = str(exc).strip() or type(exc).__name__
                return self._append_action_detail(
                    result,
                    f"[Browser action succeeded, but the latest page snapshot is "
                    f"unavailable: {message}]",
                )
            return self._append_action_detail(result, self._snapshot_detail(snapshot))

    @classmethod
    async def _settle_after_action(cls, client: _SessionBrowserClient, method_name: str) -> bool:
        """Best-effort page stabilization without imposing a fixed sleep."""
        if method_name in cls._FULL_POST_ACTION_SETTLE_METHODS:
            budget = _POST_ACTION_FULL_SETTLE_SECONDS
        elif method_name in cls._SHORT_POST_ACTION_SETTLE_METHODS:
            budget = _POST_ACTION_SHORT_SETTLE_SECONDS
        else:
            budget = _POST_ACTION_RENDER_SETTLE_SECONDS
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + budget
            async with asyncio.timeout(budget):
                await client.discard_prefetched_snapshot()
                remaining = deadline - loop.time()
                if remaining <= _POST_ACTION_SETTLE_MARGIN_SECONDS:
                    return False
                return await client.settle_page_state(
                    remaining - _POST_ACTION_SETTLE_MARGIN_SECONDS,
                )
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            logger.debug("Browser state did not settle after %s", method_name)
            return False
        except Exception:
            logger.debug(
                "Could not fully settle page state after %s",
                method_name,
                exc_info=True,
            )
            return False

    @staticmethod
    async def _capture_post_action_snapshot(client: _SessionBrowserClient) -> str:
        return await client.get_snapshot_text(
            limit=_POST_ACTION_SNAPSHOT_LIMIT,
            interactive=False,
            full_page=True,
        )

    @classmethod
    def _snapshot_detail(cls, snapshot: Any) -> str:
        return f"{cls._LATEST_SNAPSHOT_LABEL}\n{snapshot}"

    @staticmethod
    def _append_action_detail(result: Any, detail: str) -> str:
        text = "" if result is None else str(result).strip()
        return f"{text}\n\n{detail}" if text else detail

    @staticmethod
    def _append_detail_to_error(exc: Exception, detail: str) -> bool:
        message = str(exc).strip() or type(exc).__name__
        enriched = f"{message}\n\n{detail}"
        try:
            exc.args = (enriched,)
        except Exception:
            return False
        if hasattr(exc, "message"):
            with suppress(Exception):
                exc.message = enriched
        return True

    async def state(self) -> Optional[SessionBrowserState]:
        """Return current tabs without allocating or attaching a browser surface."""
        try:
            async with asyncio.timeout(_SESSION_STATE_TIMEOUT_SECONDS):
                async with self._operation_lock:
                    return await self._host._state_for(self)
        except Exception:
            logger.debug(
                "Could not read browser state for Session %s",
                self.session_id,
                exc_info=True,
            )
            return None

    async def _sync_embedded_client(self, client: _SessionBrowserClient) -> _SessionBrowserClient:
        if not getattr(client, "_embedded", False):
            return client
        try:
            await client.sync_embedded_tabs()
            return client
        except EmbeddedBrowserUnavailableError:
            await self._host._invalidate_controller(client._embedded_controller)
            await self._host._discard_stale_client(self, client)
            raise
        except _EmbeddedTargetAttachTimeout:
            logger.warning(
                "Embedded browser tab sync failed for Session %s; reconnecting local client",
                self.session_id,
                exc_info=True,
            )
            await self._host._discard_stale_client(self, client)

        retry = await self._host._client_for(self)
        if not getattr(retry, "_embedded", False):
            return retry
        try:
            await retry.sync_embedded_tabs()
        except EmbeddedBrowserUnavailableError:
            await self._host._invalidate_controller(retry._embedded_controller)
            await self._host._discard_stale_client(self, retry)
            raise
        except _EmbeddedTargetAttachTimeout:
            await self._host._discard_stale_client(self, retry)
            raise
        return retry

    async def close(self) -> bool:
        """Close only this Session's Electron-owned browser surface."""
        return await self._host._release_handle(self, discard=False)


class BrowserHost:
    """Connect Agent Sessions to the Electron-owned embedded browser.

    Parameters
    ----------
    prepare_playwright : callable, optional
        Inject the bundled Node-backed Playwright environment before CDP attach.
    session_factory : callable, optional
        Injectable client factory used by focused lifecycle tests.
    """

    def __init__(
        self,
        *,
        prepare_playwright: Optional[Callable[[], None]] = None,
        session_factory: Callable[..., _SessionBrowserClient] = _SessionBrowserClient,
    ) -> None:
        self._prepare_playwright = (
            prepare_playwright or bundled_node_runtime.apply_playwright_env
        )
        self._session_factory = session_factory
        self._lock = asyncio.Lock()
        self._connection_lock = asyncio.Lock()
        self._sessions: dict[str, SessionBrowser] = {}
        self._controller: Optional[_EmbeddedBrowserController] = None
        self._connected_controller_generation: Optional[str] = None
        self._owner_generation = 0
        self._shutdown = False

    def for_session(
        self,
        session_id: str,
        *,
        tool_result_dir: Optional[Path] = None,
    ) -> SessionBrowser:
        """Return the stable lazy browser handle for one exact Session."""
        key = str(session_id or "").strip()
        if not key:
            raise ValueError("session_id is required to open a browser")
        if self._shutdown:
            raise RuntimeError("The browser service has shut down")
        handle = self._sessions.get(key)
        if handle is None:
            handle = SessionBrowser(self, key, tool_result_dir=tool_result_dir)
            self._sessions[key] = handle
        elif tool_result_dir is not None:
            handle.bind_tool_result_dir(tool_result_dir)
        return handle

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
        """Publish the Electron browser controller preferred by future sessions."""
        controller = _EmbeddedBrowserController(
            controller_id=controller_id,
            generation=generation,
            control_url=control_url,
            control_token=control_token,
            cdp_endpoint=cdp_endpoint,
            owner_pid=owner_pid,
        )
        async with self._lock:
            previous = self._controller
            if previous == controller:
                return
            self._controller = controller
            self._connected_controller_generation = None
            self._owner_generation += 1

    async def unregister_controller(self, controller_id: str) -> bool:
        """Remove one matching Electron controller without touching a replacement."""
        async with self._lock:
            controller = self._controller
            if controller is None or controller.controller_id != controller_id:
                return False
            self._controller = None
            self._connected_controller_generation = None
            self._owner_generation += 1
            return True

    def controller_status(self) -> dict[str, Any]:
        """Return the non-secret controller projection for service diagnostics."""
        controller = self._controller
        return controller.public_status() if controller is not None else {"available": False}

    async def release_sessions(self, session_ids: Iterable[str]) -> None:
        """Release selected Session surfaces without affecting siblings or login state."""
        released: set[str] = set()
        for session_id in session_ids:
            key = str(session_id)
            if key in released:
                continue
            released.add(key)
            handle = self._sessions.get(key)
            if handle is not None:
                await self._release_handle(handle, discard=True)
            else:
                await self._release_controller_surface(
                    key,
                    known_controller=None,
                    best_effort=True,
                )

    async def shutdown(self) -> None:
        """Drain Session surfaces without owning or closing Electron Chromium."""
        async with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            handles = tuple(self._sessions.values())
            self._sessions.clear()
        for handle in handles:
            await self._release_handle(handle, discard=True)

    async def _client_for(self, handle: SessionBrowser) -> _SessionBrowserClient:
        while True:
            async with self._lock:
                if self._shutdown:
                    raise RuntimeError("The browser service has shut down")
                if self._sessions.get(handle.session_id) is not handle:
                    raise RuntimeError("The browser connection has been released")
                current = handle._client
                if current is not None and handle._client_is_live(current):
                    return current
                if current is not None:
                    handle._client = None
                    handle._owner_generation = None
                    handle._embedded_controller = None

            if current is not None:
                await self._disconnect_stale_client(current, handle.session_id)

            controller = await self._ensure_controller()
            async with self._lock:
                if self._controller is not controller:
                    continue
                generation = self._owner_generation
            client: Optional[_SessionBrowserClient] = None
            committed = False
            try:
                try:
                    client = await self._create_client(handle, controller)
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    raise

                async with self._lock:
                    if (
                        not self._shutdown
                        and self._sessions.get(handle.session_id) is handle
                        and self._controller is controller
                        and self._owner_generation == generation
                    ):
                        handle._client = client
                        handle._owner_generation = generation
                        handle._embedded_controller = controller
                        committed = True
                        return client
            finally:
                if client is not None and not committed:
                    await self._disconnect_stale_client(client, handle.session_id)

            async with self._lock:
                if self._shutdown:
                    raise RuntimeError("The browser service has shut down")
                if self._sessions.get(handle.session_id) is not handle:
                    raise RuntimeError("The browser connection has been released")

    async def _state_for(self, handle: SessionBrowser) -> Optional[SessionBrowserState]:
        """Read one Session surface without entering the browser owner lifecycle."""
        async with self._lock:
            if self._shutdown or self._sessions.get(handle.session_id) is not handle:
                return None
            controller = self._controller
        if controller is None:
            return None
        try:
            inventory = await controller.list_tabs(handle.session_id)
        except EmbeddedBrowserUnavailableError:
            await self._invalidate_controller(controller)
            return None
        except Exception:
            logger.debug(
                "Could not read embedded browser state for Session %s",
                handle.session_id,
                exc_info=True,
            )
            return None
        async with self._lock:
            if (
                self._shutdown
                or self._sessions.get(handle.session_id) is not handle
                or self._controller is not controller
            ):
                return None
        return inventory.state

    async def _discard_stale_client(
        self,
        handle: SessionBrowser,
        client: _SessionBrowserClient,
    ) -> None:
        """Forget one local client while preserving its Electron Session surface."""
        async with self._lock:
            if handle._client is client:
                handle._client = None
                handle._owner_generation = None
        await self._disconnect_stale_client(client, handle.session_id)

    @staticmethod
    async def _disconnect_stale_client(client: _SessionBrowserClient, session_id: str) -> None:
        try:
            await client.disconnect_embedded()
        except Exception:
            logger.warning(
                "Failed to disconnect stale browser client for Session %s",
                session_id,
                exc_info=True,
            )

    async def _release_handle(self, handle: SessionBrowser, *, discard: bool) -> bool:
        async with handle._operation_lock:
            async with self._lock:
                client = handle._client
                known_controller = handle._embedded_controller
                handle._client = None
                handle._owner_generation = None
                handle._embedded_controller = None
                if discard and self._sessions.get(handle.session_id) is handle:
                    self._sessions.pop(handle.session_id, None)
            client_closed = False
            if client is not None:
                try:
                    await client.close()
                    client_closed = True
                except Exception:
                    if not discard:
                        raise
                    logger.warning(
                        "Failed to close browser surface for Session %s",
                        handle.session_id,
                        exc_info=True,
                    )
            controller_released = await self._release_controller_surface(
                handle.session_id,
                known_controller=known_controller,
                best_effort=discard,
            )
        return client_closed or controller_released

    async def _release_controller_surface(
        self,
        session_id: str,
        *,
        known_controller: Optional[_EmbeddedBrowserController],
        best_effort: bool,
    ) -> bool:
        """Release an existing Electron surface without ensuring one exists."""
        released = False
        for _attempt in range(2):
            async with self._lock:
                current = self._controller
            controller = current or known_controller
            if controller is None:
                return released

            known_surface = self._same_controller_surface(controller, known_controller)
            if not known_surface:
                try:
                    inventory = await controller.list_tabs(session_id)
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    if not best_effort:
                        raise
                    return released
                except Exception:
                    async with self._lock:
                        if current is not self._controller:
                            continue
                    if not best_effort:
                        raise
                    logger.warning(
                        "Could not inspect browser surface before closing Session %s",
                        session_id,
                        exc_info=True,
                    )
                    return released
                if inventory.state is None and not inventory.target_ids:
                    async with self._lock:
                        if current is not self._controller:
                            continue
                    return released
                async with self._lock:
                    if current is not self._controller:
                        continue

            try:
                await controller.release_session(session_id)
            except EmbeddedBrowserUnavailableError:
                await self._invalidate_controller(controller)
                if not best_effort:
                    raise
                return released
            except Exception:
                async with self._lock:
                    if current is not self._controller:
                        known_controller = None
                        continue
                if not best_effort:
                    raise
                logger.warning(
                    "Could not release browser surface for Session %s",
                    session_id,
                    exc_info=True,
                )
                return released
            released = True
            async with self._lock:
                if current is self._controller:
                    return True
                known_controller = None
        return released

    @staticmethod
    def _same_controller_surface(
        left: _EmbeddedBrowserController,
        right: Optional[_EmbeddedBrowserController],
    ) -> bool:
        if right is None:
            return False
        if left is right:
            return True
        return (
            left.controller_id == right.controller_id
            and left.generation == right.generation
        )

    async def _create_client(
        self,
        handle: SessionBrowser,
        controller: _EmbeddedBrowserController,
    ) -> _SessionBrowserClient:
        session_id = handle.session_id
        client: Optional[_SessionBrowserClient] = None
        try:
            tabs = await controller.ensure_session(session_id)
            handle._embedded_controller = controller
            target_id = tabs.active_target_id
            if target_id is None:
                raise RuntimeError("Electron browser Session has no active tab")
            client = self._session_factory(
                cdp=controller.cdp_endpoint,
                headless=False,
                auto_follow_popups=True,
                stealth=False,
                snapshot_output_dir=handle.tool_result_dir,
                embedded_controller=controller,
                embedded_session_id=session_id,
            )
            await client.start_and_bind_embedded(target_id)
            return client
        except BaseException:
            if client is not None:
                with suppress(Exception):
                    await client.disconnect_embedded()
            logger.warning(
                "Embedded browser attach failed; the Session may retry",
                exc_info=True,
            )
            raise

    async def _ensure_controller(self) -> _EmbeddedBrowserController:
        """Health-check and prepare one registered Electron controller generation."""
        async with self._connection_lock:
            while True:
                async with self._lock:
                    if self._shutdown:
                        raise RuntimeError("The browser service has shut down")
                    controller = self._controller
                    if controller is None:
                        raise _embedded_browser_unavailable()
                    if self._connected_controller_generation == controller.generation:
                        return controller

                try:
                    await controller.health()
                except EmbeddedBrowserUnavailableError:
                    await self._invalidate_controller(controller)
                    raise
                except Exception as exc:
                    await self._invalidate_controller(controller)
                    raise _embedded_browser_unavailable(exc) from exc

                await asyncio.to_thread(self._prepare_playwright)
                async with self._lock:
                    if self._shutdown:
                        raise RuntimeError("The browser service has shut down")
                    if self._controller is not controller:
                        continue
                    self._connected_controller_generation = controller.generation
                    return controller

    async def _invalidate_controller(
        self,
        controller: Optional[_EmbeddedBrowserController],
    ) -> None:
        if controller is None:
            return
        async with self._lock:
            if self._controller is controller:
                self._connected_controller_generation = None
                self._owner_generation += 1


__all__ = [
    "BrowserHost",
    "EmbeddedBrowserUnavailableError",
    "SessionBrowser",
    "SessionBrowserState",
    "SessionBrowserTab",
]
