from dataclasses import dataclass, field
from typing import Any

import pytest

from src.amphi_agent import _browser as browser_module
from src.amphi_agent._browser import (
    BrowserHost,
    SessionBrowserState,
    SessionBrowserTab,
    _EmbeddedBrowserController,
    _EmbeddedSessionTabs,
)


class FakeConnection:
    def __init__(self) -> None:
        self.connected = True

    def is_connected(self) -> bool:
        return self.connected


class FakePage:
    def __init__(self) -> None:
        self.closed = False

    def is_closed(self) -> bool:
        return self.closed


class FakeClient:
    """A local browser-client boundary with no Playwright or Electron process."""

    def __init__(self, **kwargs: Any) -> None:
        self.snapshot_output_dir = kwargs.get("snapshot_output_dir")
        self._embedded_controller = kwargs.get("embedded_controller")
        self._embedded_session_id = kwargs.get("embedded_session_id")
        self._browser = FakeConnection()
        self._page = FakePage()
        self._closing = False
        self._embedded = False
        self.sync_calls = 0
        self.sync_errors: list[BaseException] = []
        self.synced_tabs: list[_EmbeddedSessionTabs] = []
        self.events: list[tuple[str, Any]] = []
        self.settle_result = True
        self.snapshot = "page snapshot [ref=button-1]"
        self.snapshot_error: Exception | None = None
        self.action_error: BaseException | None = None
        self.evaluated: list[str] = []
        self.evaluated_targets: list[str] = []
        self.evaluate_reply = '{"ok": true, "value": null}'
        self.evaluate_error: BaseException | None = None

    async def start_and_bind_embedded(self, target_id: str) -> None:
        self.events.append(("bind", target_id))
        self._closing = False
        self._embedded = True

    async def sync_embedded_tabs(self) -> None:
        self.sync_calls += 1
        if self.sync_errors:
            raise self.sync_errors.pop(0)
        if self._embedded_controller is None or self._embedded_session_id is None:
            raise RuntimeError("Embedded browser binding is unavailable")
        tabs = await self._embedded_controller.list_tabs(self._embedded_session_id)
        self.synced_tabs.append(tabs)

    def get_pages(self) -> list[FakePage]:
        return [self._page]

    async def disconnect_embedded(self) -> str:
        self.events.append(("disconnect", self._embedded_session_id))
        self._closing = True
        self._embedded = False
        self._browser.connected = False
        return "disconnected"

    async def close(self) -> str:
        self.events.append(("close", self._embedded_session_id))
        self._closing = True
        self._embedded = False
        self._browser.connected = False
        self._page.closed = True
        return "closed"

    async def settle_page_events(self) -> bool:
        self.events.append(("settle_events", None))
        return True

    async def discard_prefetched_snapshot(self) -> None:
        self.events.append(("discard_prefetch", None))

    async def settle_page_state(self, max_wait_seconds: float) -> bool:
        self.events.append(("settle_state", max_wait_seconds))
        return self.settle_result

    async def get_snapshot_text(self, **kwargs: Any) -> str:
        self.events.append(("snapshot", kwargs))
        if self.snapshot_error is not None:
            raise self.snapshot_error
        return self.snapshot

    async def evaluate_javascript(self, code: str) -> str:
        self.evaluated.append(code)
        if self.evaluate_error is not None:
            raise self.evaluate_error
        return self.evaluate_reply

    async def evaluate_on_target(self, target_id: str, code: str) -> str:
        self.evaluated_targets.append(target_id)
        return await self.evaluate_javascript(code)

    async def get_current_page_info(self) -> str:
        self.events.append(("page_info", self._embedded_session_id))
        return f"page:{self._embedded_session_id}"

    async def click_element_by_ref(self, ref: str) -> str:
        self.events.append(("click", ref))
        if self.action_error is not None:
            raise self.action_error
        return f"clicked:{ref}"


@dataclass
class ControllerProbe:
    controller_id: str
    generation: str
    health_calls: int = 0
    ensured: list[str] = field(default_factory=list)
    listed: list[str] = field(default_factory=list)
    released: list[str] = field(default_factory=list)
    surfaces: dict[str, _EmbeddedSessionTabs] = field(default_factory=dict)
    workbenches: list[tuple[str, str, bool, str, str]] = field(default_factory=list)


class BrowserHarness:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.controllers: dict[tuple[str, str], ControllerProbe] = {}
        self.clients: list[FakeClient] = []
        self.prepare_calls = 0

        def prepare_playwright() -> None:
            self.prepare_calls += 1

        def session_factory(**kwargs: Any) -> FakeClient:
            client = FakeClient(**kwargs)
            self.clients.append(client)
            return client

        self.host = BrowserHost(
            prepare_playwright=prepare_playwright,
            session_factory=session_factory,
        )

        async def health(controller: _EmbeddedBrowserController) -> None:
            self.probe(controller).health_calls += 1

        async def ensure_session(controller: _EmbeddedBrowserController, session_id: str) -> _EmbeddedSessionTabs:
            probe = self.probe(controller)
            probe.ensured.append(session_id)
            target_id = (
                f"target-{controller.controller_id}-{controller.generation}-{session_id}"
            )
            tabs = _EmbeddedSessionTabs(
                active_target_id=target_id,
                target_ids=frozenset({target_id}),
                state=SessionBrowserState(
                    tabs=(SessionBrowserTab(title=session_id, url="about:blank"),),
                    active_tab=SessionBrowserTab(title=session_id, url="about:blank"),
                ),
            )
            probe.surfaces[session_id] = tabs
            return tabs

        async def list_tabs(controller: _EmbeddedBrowserController, session_id: str) -> _EmbeddedSessionTabs:
            probe = self.probe(controller)
            probe.listed.append(session_id)
            return probe.surfaces.get(
                session_id,
                _EmbeddedSessionTabs(
                    active_target_id=None,
                    target_ids=frozenset(),
                    state=None,
                ),
            )

        async def workbench_target(
            controller: _EmbeddedBrowserController,
            session_id: str,
            kind: str,
            *,
            create: bool = False,
            language: str = "en",
            name: str = "Untitled",
        ) -> str:
            probe = self.probe(controller)
            probe.workbenches.append((session_id, kind, create, language, name))
            return f"workbench-{session_id}-{kind}"

        async def release_session(controller: _EmbeddedBrowserController, session_id: str) -> None:
            probe = self.probe(controller)
            probe.released.append(session_id)
            probe.surfaces.pop(session_id, None)

        monkeypatch.setattr(browser_module._EmbeddedBrowserController, "health", health)
        monkeypatch.setattr(
            browser_module._EmbeddedBrowserController,
            "ensure_session",
            ensure_session,
        )
        monkeypatch.setattr(browser_module._EmbeddedBrowserController, "list_tabs", list_tabs)
        monkeypatch.setattr(
            browser_module._EmbeddedBrowserController,
            "workbench_target",
            workbench_target,
        )
        monkeypatch.setattr(
            browser_module._EmbeddedBrowserController,
            "release_session",
            release_session,
        )

    async def register(
        self,
        controller_id: str,
        generation: str,
        *,
        workbench_url: str | None = None,
    ) -> ControllerProbe:
        probe = ControllerProbe(controller_id=controller_id, generation=generation)
        self.controllers[(controller_id, generation)] = probe
        await self.host.register_controller(
            controller_id=controller_id,
            generation=generation,
            control_url="http://127.0.0.1:12345",
            control_token="test-token",
            cdp_endpoint="http://127.0.0.1:9222",
            owner_pid=12345,
            workbench_url=workbench_url,
        )
        return probe

    def probe(self, controller: _EmbeddedBrowserController) -> ControllerProbe:
        return self.controllers[(controller.controller_id, controller.generation)]

    def client(self, session_id: str, index: int = -1) -> FakeClient:
        matches = [
            client
            for client in self.clients
            if client._embedded_session_id == session_id
        ]
        return matches[index]


__all__ = ["BrowserHarness", "FakeClient"]
