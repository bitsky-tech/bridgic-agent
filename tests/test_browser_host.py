from __future__ import annotations

import asyncio
import inspect
import urllib.error
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, call

import pytest
from bridgic.browser.errors import OperationError
from bridgic.browser._cli_catalog import CLI_COMMAND_TO_TOOL_METHOD
from bridgic.browser.session import Browser
from bridgic.browser.utils import generate_page_id

from src.amphi_agent._browser import (
    BrowserHost,
    EmbeddedBrowserUnavailableError,
    SessionBrowser,
    SessionBrowserState,
    SessionBrowserTab,
    _EmbeddedBrowserController,
    _EmbeddedSessionTabs,
    _EmbeddedTargetAttachTimeout,
    _SessionBrowserClient,
)


def test_bridgic_private_browser_contract_is_exactly_pinned() -> None:
    assert version("bridgic-browser") == "0.0.5"
    expected_parameters = {
        "_mark_owned": ("self", "page"),
        "_maybe_adopt_page": ("self", "page"),
        "_new_page": ("self", "url", "wait_until", "timeout"),
        "_switch_self_page_to": ("self", "new_page"),
        "_close_page": ("self", "page"),
        "_cancel_prefetch": ("self",),
        "_write_snapshot_file": ("self", "content", "file"),
        "_effective_cdp_downloads_path": ("self", "client_cwd"),
        "_set_cdp_download_behavior": (
            "self",
            "behavior",
            "download_path",
            "reason",
            "events_enabled",
            "session",
        ),
    }

    for method_name, parameters in expected_parameters.items():
        method = getattr(Browser, method_name)
        assert tuple(inspect.signature(method).parameters) == parameters


def test_snapshot_overflow_uses_session_tool_result_directory(tmp_path) -> None:
    tool_result_dir = tmp_path / "session" / ".internal" / "tool_results"
    browser = object.__new__(_SessionBrowserClient)
    browser._snapshot_output_dir = tool_result_dir

    saved = Path(browser._write_snapshot_file("complete browser snapshot"))

    assert saved.is_absolute()
    assert saved.parent.parent == tool_result_dir
    assert saved.parent.name.count("-") == 2
    assert saved.name.startswith("browser_snapshot_")
    assert saved.read_text(encoding="utf-8") == "complete browser snapshot"


def test_explicit_snapshot_file_still_uses_requested_path(tmp_path) -> None:
    browser = object.__new__(_SessionBrowserClient)
    browser._snapshot_output_dir = tmp_path / "session" / ".internal" / "tool_results"
    requested = tmp_path / "requested" / "snapshot.txt"

    saved = Path(browser._write_snapshot_file("explicit snapshot", str(requested)))

    assert saved == requested.resolve()
    assert saved.read_text(encoding="utf-8") == "explicit snapshot"


async def test_spilled_snapshot_retains_actionable_preview_from_same_capture(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    browser = object.__new__(_SessionBrowserClient)

    async def get_snapshot_text(
        client,
        limit=10_000,
        interactive=False,
        full_page=True,
        file=None,
    ) -> str:
        client._snapshot_generator = SimpleNamespace(
            INTERACTIVE_ROLES={"button", "link", "textbox"},
        )
        client._last_snapshot = SimpleNamespace(
            tree=(
                '- generic "Static copy" [ref=static-ref]\n'
                '- textbox "Search" [ref=search-ref]\n'
                '- button "Submit" [ref=submit-ref] [cursor=pointer]\n'
            ),
            refs={
                "static-ref": SimpleNamespace(role="generic"),
                "search-ref": SimpleNamespace(role="textbox"),
                "submit-ref": SimpleNamespace(role="button"),
            },
        )
        return (
            "[Page: https://example.com | Example]\n"
            "[notice] Snapshot file (20000 characters, 300 lines) saved to: "
            "/tmp/browser_snapshot.txt\n"
        )

    monkeypatch.setattr(Browser, "get_snapshot_text", get_snapshot_text)

    result = await browser.get_snapshot_text(limit=200)

    assert "saved to: /tmp/browser_snapshot.txt" in result
    assert '- textbox "Search" [ref=search-ref]' in result
    assert '- button "Submit" [ref=submit-ref]' in result
    assert "Static copy" not in result
    assert "showing 2 of 2 ref lines" in result

    high_limit_result = await browser.get_snapshot_text(limit=50_000)
    assert "within the 10000-character inline budget" in high_limit_result


async def test_discard_prefetched_snapshot_joins_cancelled_task() -> None:
    browser = object.__new__(_SessionBrowserClient)
    started = asyncio.Event()

    async def prefetch() -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(prefetch())
    await started.wait()
    browser._prefetch_task = task

    await browser.discard_prefetched_snapshot()

    assert task.done()
    assert task.cancelled()
    assert browser._prefetch_task is None


async def test_settle_page_events_waits_for_pending_adoption() -> None:
    browser = object.__new__(_SessionBrowserClient)
    browser._page_event_revision = 1
    browser._adoption_tasks = set()

    async def adopt() -> None:
        await asyncio.sleep(0.12)

    task = asyncio.create_task(adopt())
    browser._adoption_tasks.add(task)
    task.add_done_callback(browser._adoption_tasks.discard)

    deadline = asyncio.get_running_loop().time() + 0.3
    assert await browser.settle_page_events(deadline)
    assert task.done()
    assert not browser._adoption_tasks


class _FakeClient:
    def __init__(self, *, window_id: int = 1, events: list[str] | None = None, **_kwargs) -> None:
        self.window_id = window_id
        self._closing = False
        self._browser = SimpleNamespace(is_connected=lambda: True)
        self._pages = [SimpleNamespace(is_closed=lambda: False)]
        self.close_calls = 0
        self.events = events if events is not None else []
        self.action_error: Exception | None = None
        self.snapshot_error: Exception | None = None
        self.settle_result = True
        self.settle_budgets: list[float] = []
        self.snapshot_text = "[Page: https://example.com | Example]\n- button Submit [ref=new-ref]"
        self.embedded_bind_calls: list[str] = []

    def get_pages(self) -> list[object]:
        return list(self._pages)

    async def start_and_bind_embedded(self, target_id: str) -> None:
        self.embedded_bind_calls.append(target_id)

    async def navigate_to(self, url: str) -> str:
        self.events.append(f"navigate:{url}")
        return f"opened {url}"

    async def click_element_by_ref(self, ref: str) -> str:
        self.events.append(f"click:{ref}")
        if self.action_error is not None:
            raise self.action_error
        return f"clicked {ref}"

    async def input_text_by_ref(self, *_args, **_kwargs) -> str:
        self.events.append("input")
        return "input complete"

    async def get_snapshot_text(self, **kwargs) -> str:
        self.events.append(f"snapshot:{kwargs}")
        if self.snapshot_error is not None:
            raise self.snapshot_error
        return self.snapshot_text

    async def get_tabs(self) -> str:
        return "tabs"

    async def settle_page_events(self) -> None:
        self.events.append("settle")

    async def settle_page_state(self, max_wait_seconds: float) -> bool:
        self.events.append("settle_state")
        self.settle_budgets.append(max_wait_seconds)
        return self.settle_result

    async def discard_prefetched_snapshot(self) -> None:
        self.events.append("discard_prefetch")

    async def close(self) -> str:
        self.close_calls += 1
        self.events.append("client.close")
        self._closing = True
        self._pages.clear()
        return "Browser closed."


class _LifecycleHost(BrowserHost):
    def __init__(self) -> None:
        super().__init__()
        self.starts = 0
        self.stops = 0
        self.created: list[_FakeClient] = []
        self.events: list[str] = []
        self._lifecycle_lock = asyncio.Lock()

    async def _client_for(self, handle: SessionBrowser) -> _FakeClient:
        async with self._lifecycle_lock:
            if self._shutdown:
                raise RuntimeError("The App browser host has shut down")
            if self._sessions.get(handle.session_id) is not handle:
                raise RuntimeError("The Session browser handle has been released")
            current = handle._client
            if current is not None and handle._client_is_live(current):
                return current
            if self.starts == 0:
                self.starts = 1
                self.events.append("owner.start")
            client = _FakeClient(window_id=len(self.created) + 1, events=self.events)
            self.created.append(client)
            handle._client = client
            handle._owner_generation = self._owner_generation
            handle._embedded_controller = None
            return client

    async def shutdown(self) -> None:
        already_stopped = self._shutdown
        await super().shutdown()
        if not already_stopped:
            self.stops += 1
            self.events.append("owner.stop")


class _FakePageCdpSession:
    def __init__(self, page: "_FakeAdapterPage", events: list[str]) -> None:
        self.page = page
        self.send = AsyncMock(
            side_effect=lambda method, _params=None: events.append(
                f"debugger:{page.name}:{method}",
            ) or {},
        )
        self.detach = AsyncMock(side_effect=lambda: events.append(f"session.detach:{page.name}"))


class _FakeAdapterContext:
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.pages: list[_FakeAdapterPage] = []
        self.sessions: list[_FakePageCdpSession] = []
        self.on = MagicMock()

    async def new_cdp_session(self, page: "_FakeAdapterPage") -> _FakePageCdpSession:
        session = _FakePageCdpSession(page, self.events)
        self.sessions.append(session)
        return session


class _FakePopupExpectation:
    def __init__(self, page: "_FakeAdapterPage") -> None:
        self.page = page

    async def __aenter__(self) -> "_FakePopupExpectation":
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    @property
    def value(self):
        async def resolve() -> _FakeAdapterPage:
            return self.page

        return resolve()


class _FakeAdapterPage:
    def __init__(
        self,
        name: str,
        context: _FakeAdapterContext,
        *,
        opener: "_FakeAdapterPage | None" = None,
    ) -> None:
        self.name = name
        self.url = f"https://{name.lower()}.example"
        self.context = context
        self._opener = opener
        self._closed = False
        self._popup: _FakeAdapterPage | None = None
        self.bring_to_front = AsyncMock()
        self.evaluate = AsyncMock()
        self.close = AsyncMock(side_effect=self._close)
        self.on = MagicMock()
        context.pages.append(self)

    def expect_popup(self) -> _FakePopupExpectation:
        assert self._popup is not None
        return _FakePopupExpectation(self._popup)

    def queue_popup(self, page: "_FakeAdapterPage") -> None:
        self._popup = page

    async def opener(self) -> "_FakeAdapterPage | None":
        return self._opener

    def is_closed(self) -> bool:
        return self._closed

    async def _close(self) -> None:
        self._closed = True
        if self in self.context.pages:
            self.context.pages.remove(self)


async def test_embedded_controller_uses_exact_tab_rest_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, dict | None]] = []
    response = {
        "session_id": "A",
        "active_tab_id": "tab-2",
        "active_target_id": "target-2",
        "tabs": [
            {
                "tab_id": "tab-1",
                "target_id": "target-1",
                "title": "First",
                "url": "https://first.example",
            },
            {
                "tab_id": "tab-pending",
                "target_id": None,
                "title": "Loading",
                "url": "https://loading.example",
            },
            {
                "tab_id": "tab-2",
                "target_id": "target-2",
                "title": "Second",
                "url": "https://second.example",
            },
        ],
    }

    def request(
        _controller: _EmbeddedBrowserController,
        method: str,
        path: str,
        body: dict | None,
    ) -> dict:
        calls.append((method, path, body))
        return response

    monkeypatch.setattr(_EmbeddedBrowserController, "_request", request)
    controller = _EmbeddedBrowserController(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=123,
    )

    tab_states = (
        SessionBrowserTab(title="First", url="https://first.example"),
        SessionBrowserTab(title="Loading", url="https://loading.example"),
        SessionBrowserTab(title="Second", url="https://second.example"),
    )
    expected = _EmbeddedSessionTabs(
        active_target_id="target-2",
        target_ids=frozenset({"target-1", "target-2"}),
        state=SessionBrowserState(tabs=tab_states, active_tab=tab_states[2]),
    )
    assert await controller.ensure_session("A") == expected
    assert await controller.list_tabs("A") == expected
    assert await controller.create_tab("A") == expected
    assert await controller.activate_tab("A", "target-2") == expected
    assert await controller.close_tab("A", "target-1") == expected
    assert expected.state is not None
    assert expected.state.active_tab is expected.state.tabs[2]
    assert calls == [
        ("POST", "/v1/sessions/ensure", {"session_id": "A"}),
        ("POST", "/v1/sessions/tabs/list", {"session_id": "A"}),
        ("POST", "/v1/sessions/tabs/create", {"session_id": "A"}),
        (
            "POST",
            "/v1/sessions/tabs/activate",
            {"session_id": "A", "target_id": "target-2"},
        ),
        (
            "POST",
            "/v1/sessions/tabs/close",
            {"session_id": "A", "target_id": "target-1"},
        ),
    ]


def test_embedded_controller_keeps_domain_http_400_as_an_operation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject(*_args, **_kwargs):
        raise urllib.error.HTTPError(
            "http://127.0.0.1:43111/v1/sessions/ensure",
            400,
            "Bad Request",
            None,
            None,
        )

    monkeypatch.setattr("src.amphi_agent._browser.urllib.request.urlopen", reject)
    controller = _EmbeddedBrowserController(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=123,
    )

    with pytest.raises(RuntimeError, match=r"rejected the request \(HTTP 400\)") as raised:
        controller._request("POST", "/v1/sessions/ensure", {"session_id": "A"})

    assert not isinstance(raised.value, EmbeddedBrowserUnavailableError)


@pytest.mark.parametrize("status", [401, 500])
def test_embedded_controller_maps_unavailable_http_statuses(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
) -> None:
    def reject(*_args, **_kwargs):
        raise urllib.error.HTTPError(
            "http://127.0.0.1:43111/v1/health",
            status,
            "Unavailable",
            None,
            None,
        )

    monkeypatch.setattr("src.amphi_agent._browser.urllib.request.urlopen", reject)
    controller = _EmbeddedBrowserController(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=123,
    )

    with pytest.raises(
        EmbeddedBrowserUnavailableError,
        match="desktop app is not running",
    ):
        controller._request("GET", "/v1/health", None)


async def test_session_handles_are_stable_and_browser_start_is_lazy() -> None:
    host = _LifecycleHost()

    first = host.for_session("A")
    assert host.for_session("A") is first
    assert host.for_session("B") is not first
    assert host.starts == 0

    result = await first.invoke("navigate_to", "https://example.com")
    assert result.startswith("opened https://example.com\n\n[Latest page snapshot")
    assert "[ref=new-ref]" in result
    assert host.starts == 1
    assert len(host.created) == 1


def test_state_advancing_method_boundary_is_explicit() -> None:
    assert SessionBrowser._STATE_ADVANCING_METHODS == {
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
    }
    settle_groups = (
        SessionBrowser._FULL_POST_ACTION_SETTLE_METHODS,
        SessionBrowser._SHORT_POST_ACTION_SETTLE_METHODS,
        SessionBrowser._RENDER_POST_ACTION_SETTLE_METHODS,
    )
    assert set().union(*settle_groups) == SessionBrowser._STATE_ADVANCING_METHODS
    assert all(
        first.isdisjoint(second)
        for index, first in enumerate(settle_groups)
        for second in settle_groups[index + 1:]
    )


def test_session_browser_approves_every_bridgic_catalog_method_except_close() -> None:
    catalog_methods = set(CLI_COMMAND_TO_TOOL_METHOD.values())

    assert SessionBrowser._METHODS == (catalog_methods - {"close"}) | {"scroll_to_text"}
    assert "close" not in SessionBrowser._METHODS
    assert all(callable(getattr(_SessionBrowserClient, name, None)) for name in catalog_methods)


async def test_state_advancing_action_appends_latest_snapshot() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    host.events.clear()

    result = await session.invoke("click_element_by_ref", "old-ref")

    assert result == (
        "clicked old-ref\n\n"
        "[Latest page snapshot bundle after browser action — use the inline refs "
        "before the next action; inspect any reported full-snapshot file before "
        "recapturing this page]\n"
        "[Page: https://example.com | Example]\n- button Submit [ref=new-ref]"
    )
    assert host.events == [
        "settle",
        "click:old-ref",
        "discard_prefetch",
        "settle_state",
        "snapshot:{'limit': 10000, 'interactive': False, 'full_page': True}",
    ]
    assert 0 < host.created[0].settle_budgets[-1] < 3.0


async def test_failed_state_advancing_action_includes_latest_snapshot() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    client = host.created[0]
    action_error = OperationError(
        "click failed",
        code="CLICK_FAILED",
        details={"ref": "stale-ref"},
        retryable=True,
    )
    client.action_error = action_error
    host.events.clear()

    with pytest.raises(OperationError) as raised:
        await session.invoke("click_element_by_ref", "stale-ref")

    assert raised.value is action_error
    assert raised.value.code == "CLICK_FAILED"
    assert raised.value.details == {"ref": "stale-ref"}
    assert raised.value.retryable is True
    assert "click failed" in str(raised.value)
    assert "Latest page snapshot bundle after browser action" in str(raised.value)
    assert "[ref=new-ref]" in str(raised.value)
    assert host.events == [
        "settle",
        "click:stale-ref",
        "discard_prefetch",
        "settle_state",
        "snapshot:{'limit': 10000, 'interactive': False, 'full_page': True}",
    ]


async def test_observation_does_not_append_snapshot() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")

    assert await session.invoke("get_tabs") == "tabs"
    assert not any(event.startswith("snapshot:") for event in host.events)


async def test_unsettled_action_does_not_publish_possibly_stale_snapshot() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    client = host.created[0]
    client.settle_result = False
    host.events.clear()

    result = await session.invoke("click_element_by_ref", "current-ref")

    assert result.startswith("clicked current-ref")
    assert "snapshot is unavailable" in result
    assert "did not settle safely" in result
    assert not any(event.startswith("snapshot:") for event in host.events)


async def test_successful_action_survives_follow_up_snapshot_failure() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    client = host.created[0]
    client.snapshot_error = RuntimeError("snapshot failed")

    result = await session.invoke("click_element_by_ref", "current-ref")

    assert result.startswith("clicked current-ref")
    assert "action succeeded" in result.lower()
    assert "snapshot failed" in result


async def test_failed_action_survives_follow_up_snapshot_failure() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    client = host.created[0]
    action_error = OperationError("click failed", code="CLICK_FAILED")
    client.action_error = action_error
    client.snapshot_error = RuntimeError("snapshot failed")

    with pytest.raises(OperationError) as raised:
        await session.invoke("click_element_by_ref", "stale-ref")

    assert raised.value is action_error
    assert raised.value.code == "CLICK_FAILED"
    assert str(raised.value) == "click failed"


async def test_input_action_appends_automatic_snapshot() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")
    host.events.clear()

    result = await session.invoke(
        "input_text_by_ref",
        ref="text-ref",
        text="new value",
    )

    assert result.startswith("input complete\n\n[Latest page snapshot")
    assert any(event.startswith("snapshot:") for event in host.events)


async def test_session_state_reads_ui_first_surface_without_starting_browser(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    tabs = (
        SessionBrowserTab(title="First", url="https://first.example"),
        SessionBrowserTab(title="Second", url="https://second.example"),
    )
    expected = SessionBrowserState(tabs=tabs, active_tab=tabs[1])
    list_tabs = AsyncMock(
        return_value=_EmbeddedSessionTabs(
            active_target_id="target-2",
            target_ids=frozenset({"target-1", "target-2"}),
            state=expected,
        ),
    )
    ensure_session = AsyncMock(
        side_effect=AssertionError("state must not ensure a browser surface"),
    )
    health = AsyncMock(side_effect=AssertionError("state must not enter owner startup"))
    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    session_factory = MagicMock(side_effect=AssertionError("state must not attach Playwright"))
    host = BrowserHost(
        session_factory=session_factory,
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    session = host.for_session("A")
    state = await session.state()

    assert state == expected
    assert state is not None
    assert state.active_tab is state.tabs[1]
    assert session._client is None
    assert session._embedded_controller is None
    list_tabs.assert_awaited_once_with("A")
    ensure_session.assert_not_awaited()
    health.assert_not_awaited()
    session_factory.assert_not_called()


async def test_session_state_returns_none_for_absent_surface_and_controller_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inventories = iter(
        (
            _EmbeddedSessionTabs(None, frozenset()),
            ConnectionError("controller unavailable"),
        ),
    )

    async def list_tabs(
        _controller: _EmbeddedBrowserController,
        _session_id: str,
    ) -> _EmbeddedSessionTabs:
        result = next(inventories)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    assert await session.state() is None
    assert await session.state() is None


async def test_session_state_timeout_is_fail_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.amphi_agent._browser as browser_module

    cancelled = asyncio.Event()

    async def list_tabs(
        _controller: _EmbeddedBrowserController,
        _session_id: str,
    ) -> _EmbeddedSessionTabs:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    monkeypatch.setattr(browser_module, "_SESSION_STATE_TIMEOUT_SECONDS", 0.01)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    assert await host.for_session("A").state() is None
    assert cancelled.is_set()


async def test_session_state_does_not_swallow_task_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    listed = asyncio.Event()

    async def list_tabs(
        _controller: _EmbeddedBrowserController,
        _session_id: str,
    ) -> _EmbeddedSessionTabs:
        listed.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    state_task = asyncio.create_task(host.for_session("A").state())
    await listed.wait()

    state_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await state_task


async def test_session_states_are_isolated_by_exact_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tabs = {
        session_id: SessionBrowserTab(
            title=f"Session {session_id}",
            url=f"https://{session_id.lower()}.example",
        )
        for session_id in ("A", "B")
    }

    async def list_tabs(
        _controller: _EmbeddedBrowserController,
        session_id: str,
    ) -> _EmbeddedSessionTabs:
        tab = tabs[session_id]
        return _EmbeddedSessionTabs(
            f"target-{session_id}",
            frozenset({f"target-{session_id}"}),
            SessionBrowserState(tabs=(tab,), active_tab=tab),
        )

    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    state_a, state_b = await asyncio.gather(
        host.for_session("A").state(),
        host.for_session("B").state(),
    )

    assert state_a == SessionBrowserState(tabs=(tabs["A"],), active_tab=tabs["A"])
    assert state_b == SessionBrowserState(tabs=(tabs["B"],), active_tab=tabs["B"])


async def test_session_state_discards_a_replaced_controller_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    listed = asyncio.Event()
    resume = asyncio.Event()
    tab = SessionBrowserTab(title="Stale", url="https://stale.example")

    async def list_tabs(
        controller: _EmbeddedBrowserController,
        _session_id: str,
    ) -> _EmbeddedSessionTabs:
        assert controller.generation == "generation-1"
        listed.set()
        await resume.wait()
        return _EmbeddedSessionTabs(
            "target-stale",
            frozenset({"target-stale"}),
            SessionBrowserState(tabs=(tab,), active_tab=tab),
        )

    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    state_task = asyncio.create_task(session.state())
    await listed.wait()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-2",
        control_url="http://127.0.0.1:44111",
        control_token="new-controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:44112",
        owner_pid=9999,
    )
    resume.set()

    assert await state_task is None


async def test_ui_first_session_close_releases_without_attaching(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tab = SessionBrowserTab(title="User page", url="https://user.example")
    list_tabs = AsyncMock(
        return_value=_EmbeddedSessionTabs(
            "target-user",
            frozenset({"target-user"}),
            SessionBrowserState(tabs=(tab,), active_tab=tab),
        ),
    )
    release_session = AsyncMock()
    ensure_session = AsyncMock(
        side_effect=AssertionError("close must not ensure a browser surface"),
    )
    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    host = BrowserHost(
        session_factory=MagicMock(side_effect=AssertionError("close must not attach Playwright")),
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    assert await session.close() is True

    list_tabs.assert_awaited_once_with("A")
    release_session.assert_awaited_once_with("A")
    ensure_session.assert_not_awaited()
    assert session._client is None


async def test_ui_first_session_close_does_not_release_an_absent_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    list_tabs = AsyncMock(return_value=_EmbeddedSessionTabs(None, frozenset()))
    release_session = AsyncMock()
    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    assert await host.for_session("A").close() is False

    list_tabs.assert_awaited_once_with("A")
    release_session.assert_not_awaited()


async def test_ui_first_session_close_propagates_controller_release_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tab = SessionBrowserTab(title="User page", url="https://user.example")
    list_tabs = AsyncMock(
        return_value=_EmbeddedSessionTabs(
            "target-user",
            frozenset({"target-user"}),
            SessionBrowserState(tabs=(tab,), active_tab=tab),
        ),
    )
    release_session = AsyncMock(side_effect=ConnectionError("controller disconnected"))
    monkeypatch.setattr(_EmbeddedBrowserController, "list_tabs", list_tabs)
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    with pytest.raises(ConnectionError, match="controller disconnected"):
        await session.close()

    list_tabs.assert_awaited_once_with("A")
    release_session.assert_awaited_once_with("A")


async def test_discarded_session_release_is_best_effort_on_controller_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tab = SessionBrowserTab(title="User page", url="https://user.example")
    monkeypatch.setattr(
        _EmbeddedBrowserController,
        "list_tabs",
        AsyncMock(
            return_value=_EmbeddedSessionTabs(
                "target-user",
                frozenset({"target-user"}),
                SessionBrowserState(tabs=(tab,), active_tab=tab),
            ),
        ),
    )
    release_session = AsyncMock(side_effect=ConnectionError("controller disconnected"))
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    host.for_session("A")

    await host.release_sessions(["A"])

    release_session.assert_awaited_once_with("A")
    assert "A" not in host._sessions


async def test_embedded_handle_reconciles_ui_active_tab_before_every_operation() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    events: list[str] = []
    client = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(side_effect=lambda: events.append("sync")),
        settle_page_events=AsyncMock(side_effect=lambda: events.append("settle")),
        get_tabs=AsyncMock(side_effect=lambda: events.append("invoke") or "tabs"),
    )
    host._client_for = AsyncMock(return_value=client)

    assert await session.invoke("get_tabs") == "tabs"
    assert events == ["sync", "settle", "invoke", "settle"]


async def test_embedded_sync_failure_reconnects_before_invoking_tool_once() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    events: list[str] = []

    async def fail_first_sync() -> None:
        events.append("sync:first")
        raise _EmbeddedTargetAttachTimeout("target did not attach")

    first = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(side_effect=fail_first_sync),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(side_effect=lambda: events.append("invoke:first") or "first"),
    )
    retry = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(side_effect=lambda: events.append("sync:retry")),
        settle_page_events=AsyncMock(side_effect=lambda: events.append("settle:retry")),
        get_tabs=AsyncMock(side_effect=lambda: events.append("invoke:retry") or "tabs"),
    )
    host._client_for = AsyncMock(side_effect=(first, retry))
    host._discard_stale_client = AsyncMock(
        side_effect=lambda _handle, _client: events.append("discard:first"),
    )

    assert await session.invoke("get_tabs") == "tabs"

    assert events == [
        "sync:first",
        "discard:first",
        "sync:retry",
        "settle:retry",
        "invoke:retry",
        "settle:retry",
    ]
    first.get_tabs.assert_not_awaited()
    retry.get_tabs.assert_awaited_once_with()
    assert host._client_for.await_count == 2


async def test_embedded_sync_retry_failure_never_replays_tool_method() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    first = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(
            side_effect=_EmbeddedTargetAttachTimeout("first attach failed"),
        ),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(),
    )
    retry = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(
            side_effect=_EmbeddedTargetAttachTimeout("retry attach failed"),
        ),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(),
    )
    host._client_for = AsyncMock(side_effect=(first, retry))
    host._discard_stale_client = AsyncMock()

    with pytest.raises(_EmbeddedTargetAttachTimeout, match="retry attach failed"):
        await session.invoke("get_tabs")

    first.get_tabs.assert_not_awaited()
    retry.get_tabs.assert_not_awaited()
    assert host._discard_stale_client.await_args_list == [
        call(session, first),
        call(session, retry),
    ]
    assert host._client_for.await_count == 2


async def test_embedded_controller_sync_failure_does_not_reconnect() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    client = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(side_effect=ConnectionError("controller unavailable")),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(),
    )
    host._client_for = AsyncMock(return_value=client)
    host._discard_stale_client = AsyncMock()

    with pytest.raises(ConnectionError, match="controller unavailable"):
        await session.invoke("get_tabs")

    host._client_for.assert_awaited_once_with(session)
    host._discard_stale_client.assert_not_awaited()
    client.get_tabs.assert_not_awaited()


async def test_embedded_tool_timeout_is_not_replayed_or_reconnected() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    client = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(side_effect=TimeoutError("tool timed out")),
    )
    host._client_for = AsyncMock(return_value=client)
    host._discard_stale_client = AsyncMock()

    with pytest.raises(TimeoutError, match="tool timed out"):
        await session.invoke("get_tabs")

    host._client_for.assert_awaited_once_with(session)
    host._discard_stale_client.assert_not_awaited()
    client.get_tabs.assert_awaited_once_with()
    assert client.settle_page_events.await_count == 2


async def test_embedded_target_timeout_during_tool_discards_without_replay() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    client = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(),
        settle_page_events=AsyncMock(),
        get_tabs=AsyncMock(
            side_effect=_EmbeddedTargetAttachTimeout("new target did not attach"),
        ),
    )
    host._client_for = AsyncMock(return_value=client)
    host._discard_stale_client = AsyncMock()

    with pytest.raises(_EmbeddedTargetAttachTimeout, match="new target did not attach"):
        await session.invoke("get_tabs")

    host._client_for.assert_awaited_once_with(session)
    host._discard_stale_client.assert_awaited_once_with(session, client)
    client.get_tabs.assert_awaited_once_with()
    assert client.settle_page_events.await_count == 2


async def test_embedded_action_target_timeout_discards_without_snapshot_or_replay() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    client = SimpleNamespace(
        _embedded=True,
        sync_embedded_tabs=AsyncMock(),
        settle_page_events=AsyncMock(),
        click_element_by_ref=AsyncMock(
            side_effect=_EmbeddedTargetAttachTimeout("new target did not attach"),
        ),
        get_snapshot_text=AsyncMock(),
    )
    host._client_for = AsyncMock(return_value=client)
    host._discard_stale_client = AsyncMock()

    with pytest.raises(_EmbeddedTargetAttachTimeout, match="new target did not attach"):
        await session.invoke("click_element_by_ref", "old-ref")

    host._client_for.assert_awaited_once_with(session)
    host._discard_stale_client.assert_awaited_once_with(session, client)
    client.click_element_by_ref.assert_awaited_once_with("old-ref")
    client.get_snapshot_text.assert_not_awaited()
    assert client.settle_page_events.await_count == 1


async def test_registered_controller_is_preferred_and_binds_exact_session_targets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    health_calls: list[str] = []
    ensured_sessions: list[str] = []
    clients: list[_FakeClient] = []
    client_kwargs: list[dict] = []

    async def health(controller: _EmbeddedBrowserController) -> None:
        health_calls.append(controller.controller_id)

    async def ensure_session(
        controller: _EmbeddedBrowserController,
        session_id: str,
    ) -> _EmbeddedSessionTabs:
        ensured_sessions.append(session_id)
        target_id = f"target-{session_id}"
        return _EmbeddedSessionTabs(target_id, frozenset({target_id}))

    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)

    prepare_playwright = MagicMock()

    def session_factory(**kwargs):
        client_kwargs.append(kwargs)
        client = _FakeClient()
        clients.append(client)
        return client

    host = BrowserHost(
        prepare_playwright=prepare_playwright,
        session_factory=session_factory,
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    tool_result_dir_a = tmp_path / "A" / ".internal" / "tool_results"
    tool_result_dir_b = tmp_path / "B" / ".internal" / "tool_results"
    session_a = host.for_session("A", tool_result_dir=tool_result_dir_a)
    session_b = host.for_session("B", tool_result_dir=tool_result_dir_b)
    assert await session_a.invoke("get_tabs") == "tabs"
    assert await session_b.invoke("get_tabs") == "tabs"
    assert await session_a.invoke("get_tabs") == "tabs"

    assert health_calls == ["electron-main"]
    assert ensured_sessions == ["A", "B"]
    prepare_playwright.assert_called_once_with()
    assert [client.embedded_bind_calls for client in clients] == [
        ["target-A"],
        ["target-B"],
    ]
    assert [kwargs["cdp"] for kwargs in client_kwargs] == [
        "http://127.0.0.1:43112",
        "http://127.0.0.1:43112",
    ]
    assert all(kwargs["headless"] is False for kwargs in client_kwargs)
    assert [kwargs["snapshot_output_dir"] for kwargs in client_kwargs] == [
        tool_result_dir_a.resolve(),
        tool_result_dir_b.resolve(),
    ]


async def test_missing_controller_fails_without_side_effects_and_registration_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepare_playwright = MagicMock()
    session_factory = MagicMock(return_value=_FakeClient())
    host = BrowserHost(
        prepare_playwright=prepare_playwright,
        session_factory=session_factory,
    )
    session = host.for_session("A")

    with pytest.raises(
        EmbeddedBrowserUnavailableError,
        match="desktop app is not running",
    ) as raised:
        await session.invoke("get_tabs")
    assert str(raised.value).startswith("The browser is unavailable")
    assert "embedded browser" not in str(raised.value).lower()

    prepare_playwright.assert_not_called()
    session_factory.assert_not_called()

    monkeypatch.setattr(_EmbeddedBrowserController, "health", AsyncMock())
    monkeypatch.setattr(
        _EmbeddedBrowserController,
        "ensure_session",
        AsyncMock(return_value=_EmbeddedSessionTabs("target-A", frozenset({"target-A"}))),
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    assert await session.invoke("get_tabs") == "tabs"
    prepare_playwright.assert_called_once_with()
    session_factory.assert_called_once_with(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
        snapshot_output_dir=None,
        embedded_controller=host._controller,
        embedded_session_id="A",
    )


async def test_unhealthy_controller_fails_without_fallback_and_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    health = AsyncMock(side_effect=[ConnectionError("controller offline"), None])
    ensure_session = AsyncMock(
        return_value=_EmbeddedSessionTabs("target-A", frozenset({"target-A"})),
    )
    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    prepare_playwright = MagicMock()
    host = BrowserHost(
        prepare_playwright=prepare_playwright,
        session_factory=lambda **_kwargs: _FakeClient(),
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    with pytest.raises(EmbeddedBrowserUnavailableError, match="desktop app is not running"):
        await session.invoke("get_tabs")

    assert host.controller_status()["controller_id"] == "electron-main"
    assert host._connected_controller_generation is None
    prepare_playwright.assert_not_called()
    ensure_session.assert_not_awaited()

    assert await session.invoke("get_tabs") == "tabs"
    assert health.await_count == 2
    prepare_playwright.assert_called_once_with()
    ensure_session.assert_awaited_once_with("A")


async def test_controller_registration_status_and_matching_unregister() -> None:
    host = BrowserHost()
    assert host.controller_status() == {"available": False}

    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    assert host.controller_status() == {
        "available": True,
        "controller_id": "electron-main",
        "generation": "generation-1",
        "owner_pid": 9876,
    }
    assert "control_token" not in host.controller_status()
    assert await host.unregister_controller("stale-controller") is False
    assert host.controller_status()["available"] is True
    assert await host.unregister_controller("electron-main") is True
    assert host.controller_status() == {"available": False}


async def test_controller_re_registration_replaces_embedded_owner_only_for_a_new_generation() -> None:
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    original_generation = host._owner_generation

    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )

    assert host._owner_generation == original_generation

    await host.register_controller(
        controller_id="electron-main",
        generation="generation-2",
        control_url="http://127.0.0.1:44111",
        control_token="new-generation-token-long-enough",
        cdp_endpoint="http://127.0.0.1:44112",
        owner_pid=9999,
    )

    assert host._owner_generation == original_generation + 1
    assert host._connected_controller_generation is None
    assert host.controller_status()["generation"] == "generation-2"


async def test_transient_embedded_attach_failure_keeps_controller_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    health = AsyncMock()
    ensure_session = AsyncMock(
        return_value=_EmbeddedSessionTabs("target-A", frozenset({"target-A"})),
    )
    release_session = AsyncMock()
    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)

    failed_client = _FakeClient()
    failed_client.start_and_bind_embedded = AsyncMock(
        side_effect=ConnectionError("transient CDP attach failure"),
    )
    retry_client = _FakeClient()
    clients = iter((failed_client, retry_client))
    host = BrowserHost(
        prepare_playwright=lambda: None,
        session_factory=lambda **_kwargs: next(clients),
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    with pytest.raises(ConnectionError, match="transient CDP attach failure"):
        await session.invoke("get_tabs")

    assert host.controller_status()["controller_id"] == "electron-main"
    assert await session.invoke("get_tabs") == "tabs"
    assert health.await_count == 1
    assert ensure_session.await_args_list == [call("A"), call("A")]
    release_session.assert_not_awaited()
    assert retry_client.embedded_bind_calls == ["target-A"]


async def test_close_after_embedded_attach_failure_releases_preserved_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_EmbeddedBrowserController, "health", AsyncMock())
    monkeypatch.setattr(
        _EmbeddedBrowserController,
        "ensure_session",
        AsyncMock(return_value=_EmbeddedSessionTabs("target-A", frozenset({"target-A"}))),
    )
    release_session = AsyncMock()
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)
    failed_client = _FakeClient()
    failed_client.start_and_bind_embedded = AsyncMock(
        side_effect=ConnectionError("transient CDP attach failure"),
    )
    host = BrowserHost(
        prepare_playwright=lambda: None,
        session_factory=lambda **_kwargs: failed_client,
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    with pytest.raises(ConnectionError, match="transient CDP attach failure"):
        await session.invoke("get_tabs")

    assert session._client is None
    assert session._embedded_controller is host._controller
    release_session.assert_not_awaited()
    assert await session.close() is True
    release_session.assert_awaited_once_with("A")


async def test_stale_embedded_client_rebuild_preserves_electron_surface() -> None:
    host = BrowserHost()
    session = host.for_session("A")
    controller = SimpleNamespace(release_session=AsyncMock())
    stale = SimpleNamespace(
        _closing=True,
        _embedded=True,
        _browser=SimpleNamespace(is_connected=lambda: True),
        get_pages=lambda: [SimpleNamespace(is_closed=lambda: False)],
        disconnect_embedded=AsyncMock(),
    )
    replacement = _FakeClient()
    host._controller = controller
    host._owner_generation = 4
    host._ensure_controller = AsyncMock(return_value=controller)
    host._create_client = AsyncMock(return_value=replacement)
    session._client = stale
    session._owner_generation = 4
    session._embedded_controller = controller

    assert await host._client_for(session) is replacement

    stale.disconnect_embedded.assert_awaited_once_with()
    controller.release_session.assert_not_awaited()
    host._create_client.assert_awaited_once_with(session, controller)
    assert session._client is replacement
    assert session._embedded_controller is controller


async def test_slow_attach_does_not_block_a_live_sibling_or_controller_replacement() -> None:
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    controller = host._controller
    assert controller is not None
    session_a = host.for_session("A")
    session_b = host.for_session("B")
    sibling_client = _FakeClient()
    session_b._client = sibling_client
    session_b._owner_generation = host._owner_generation
    session_b._embedded_controller = controller

    attach_started = asyncio.Event()

    async def slow_create(*_args) -> _FakeClient:
        attach_started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    host._ensure_controller = AsyncMock(return_value=controller)
    host._create_client = AsyncMock(side_effect=slow_create)
    pending = asyncio.create_task(session_a.invoke("get_tabs"))
    await attach_started.wait()

    assert await asyncio.wait_for(session_b.invoke("get_tabs"), timeout=0.2) == "tabs"
    await asyncio.wait_for(
        host.register_controller(
            controller_id="electron-main",
            generation="generation-2",
            control_url="http://127.0.0.1:44111",
            control_token="new-controller-token-long-enough",
            cdp_endpoint="http://127.0.0.1:44112",
            owner_pid=9999,
        ),
        timeout=0.2,
    )
    assert host.controller_status()["generation"] == "generation-2"

    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending


async def test_cancel_while_waiting_to_commit_disconnects_uncommitted_client() -> None:
    host = BrowserHost()
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    controller = host._controller
    assert controller is not None
    session = host.for_session("A")
    client = SimpleNamespace(disconnect_embedded=AsyncMock())
    created = asyncio.Event()
    may_return = asyncio.Event()

    async def create_client(*_args):
        created.set()
        await may_return.wait()
        return client

    host._ensure_controller = AsyncMock(return_value=controller)
    host._create_client = AsyncMock(side_effect=create_client)
    pending = asyncio.create_task(host._client_for(session))
    await created.wait()

    await host._lock.acquire()
    try:
        may_return.set()
        await asyncio.sleep(0)
        pending.cancel()
    finally:
        host._lock.release()

    with pytest.raises(asyncio.CancelledError):
        await pending
    client.disconnect_embedded.assert_awaited_once_with()
    assert session._client is None


async def test_connected_controller_transport_failure_rechecks_and_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    health = AsyncMock()
    ensure_session = AsyncMock(
        return_value=_EmbeddedSessionTabs("target-A", frozenset({"target-A"})),
    )
    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    failed = _FakeClient()
    failed.get_tabs = AsyncMock(
        side_effect=EmbeddedBrowserUnavailableError("controller disconnected"),
    )
    failed.disconnect_embedded = AsyncMock()
    recovered = _FakeClient()
    clients = iter((failed, recovered))

    def session_factory(**kwargs):
        client = next(clients)
        client._embedded_controller = kwargs["embedded_controller"]
        return client

    host = BrowserHost(
        prepare_playwright=lambda: None,
        session_factory=session_factory,
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")

    with pytest.raises(EmbeddedBrowserUnavailableError, match="controller disconnected"):
        await session.invoke("get_tabs")

    assert host._connected_controller_generation is None
    failed.disconnect_embedded.assert_awaited_once_with()
    assert await session.invoke("get_tabs") == "tabs"
    assert health.await_count == 2


async def test_embedded_local_disconnect_clears_ownership_before_browser_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _FakeAdapterContext([])
    page = _FakeAdapterPage("A1", context)
    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
    )
    client._embedded = True
    client._context = context
    client._page = page
    client._mark_owned(page)
    ownership_seen_by_close: list[list[object]] = []

    async def close_without_touching_pages(browser: Browser) -> str:
        ownership_seen_by_close.append(list(browser._owned_pages))
        return "Browser closed."

    monkeypatch.setattr(Browser, "close", close_without_touching_pages)

    assert await client.disconnect_embedded() == "Browser closed."

    assert ownership_seen_by_close == [[]]
    assert client._focus_stack == []
    assert client._embedded is False
    page.close.assert_not_awaited()


async def test_embedded_session_close_releases_the_matching_controller_view(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    released_sessions: list[tuple[str, str]] = []

    async def health(_controller: _EmbeddedBrowserController) -> None:
        return None

    async def ensure_session(
        _controller: _EmbeddedBrowserController,
        session_id: str,
    ) -> _EmbeddedSessionTabs:
        target_id = f"target-{session_id}"
        return _EmbeddedSessionTabs(target_id, frozenset({target_id}))

    async def release_session(
        controller: _EmbeddedBrowserController,
        session_id: str,
    ) -> None:
        released_sessions.append((controller.generation, session_id))

    monkeypatch.setattr(_EmbeddedBrowserController, "health", health)
    monkeypatch.setattr(_EmbeddedBrowserController, "ensure_session", ensure_session)
    monkeypatch.setattr(_EmbeddedBrowserController, "release_session", release_session)

    host = BrowserHost(
        prepare_playwright=lambda: None,
        session_factory=_FakeClient,
    )
    await host.register_controller(
        controller_id="electron-main",
        generation="generation-1",
        control_url="http://127.0.0.1:43111",
        control_token="controller-token-long-enough",
        cdp_endpoint="http://127.0.0.1:43112",
        owner_pid=9876,
    )
    session = host.for_session("A")
    await session.invoke("get_tabs")

    assert await session.close() is True
    assert released_sessions == [("generation-1", "A")]


async def test_embedded_binding_selects_target_across_all_cdp_contexts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.amphi_agent._browser as browser_module

    app_context = _FakeAdapterContext([])
    browser_context = _FakeAdapterContext([])
    app_page = _FakeAdapterPage("app", app_context)
    target_page = _FakeAdapterPage("target", browser_context)
    target_ids = {app_page: "app-target", target_page: "session-target"}

    connected_endpoints: list[str] = []
    connected_browser = SimpleNamespace(contexts=[app_context, browser_context])

    class Chromium:
        async def connect_over_cdp(self, endpoint: str):
            connected_endpoints.append(endpoint)
            return connected_browser

    playwright = SimpleNamespace(chromium=Chromium())

    class PlaywrightStarter:
        async def start(self):
            return playwright

    monkeypatch.setattr(browser_module, "async_playwright", lambda: PlaywrightStarter())

    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
    )
    client._start = AsyncMock(side_effect=AssertionError("embedded binding must bypass Browser._start"))
    client._target_id = AsyncMock(side_effect=lambda page: target_ids[page])
    client._activate_page_facilities = AsyncMock()

    await client.start_and_bind_embedded("session-target")

    assert connected_endpoints == ["http://127.0.0.1:43112"]
    assert client._context is browser_context
    assert client._page is target_page
    assert client.get_pages() == [target_page]
    assert app_page not in client._owned_pages
    browser_context.on.assert_called_once_with("page", client._on_new_page)
    client._activate_page_facilities.assert_awaited_once_with(target_page)


async def test_embedded_binding_has_a_bounded_startup_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.amphi_agent._browser as browser_module

    class PlaywrightStarter:
        async def start(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(browser_module, "async_playwright", lambda: PlaywrightStarter())
    monkeypatch.setattr(browser_module, "_EMBEDDED_ATTACH_TIMEOUT_SECONDS", 0.01)

    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
    )

    with pytest.raises(TimeoutError, match="Timed out while starting Playwright"):
        await client.start_and_bind_embedded("session-target")


async def test_embedded_new_tab_is_created_by_electron_and_bound_by_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = _FakeAdapterContext([])
    first = _FakeAdapterPage("A1", context)
    created = _FakeAdapterPage("A2", context)
    sibling = _FakeAdapterPage("B1", context)
    target_ids = {
        first: "target-a1",
        created: "target-a2",
        sibling: "target-b1",
    }
    controller = SimpleNamespace(
        create_tab=AsyncMock(
            return_value=_EmbeddedSessionTabs(
                "target-a2",
                frozenset({"target-a1", "target-a2"}),
            ),
        ),
        activate_tab=AsyncMock(),
    )
    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
        embedded_controller=controller,
        embedded_session_id="A",
    )
    client._embedded = True
    client._context = context
    client._playwright = object()
    client._page = first
    client._mark_owned(first)
    client._target_id = AsyncMock(side_effect=lambda page: target_ids[page])
    client._wait_for_embedded_target_page = AsyncMock(return_value=(context, created))
    client._activate_page_facilities = AsyncMock()
    navigate = AsyncMock()
    monkeypatch.setattr(client, "navigate_to", navigate)

    page = await client._new_page("https://example.com")

    assert page is created
    assert client._page is created
    assert client.get_pages() == [first, created]
    assert sibling not in client._owned_pages
    controller.create_tab.assert_awaited_once_with("A")
    controller.activate_tab.assert_not_awaited()
    client._wait_for_embedded_target_page.assert_awaited_once_with("target-a2")
    navigate.assert_awaited_once_with(
        "https://example.com",
        wait_until="domcontentloaded",
        timeout=None,
    )
    first.evaluate.assert_not_awaited()


async def test_embedded_switch_and_electron_authoritative_close_stay_in_sync() -> None:
    context = _FakeAdapterContext([])
    first = _FakeAdapterPage("A1", context)
    second = _FakeAdapterPage("A2", context)
    target_ids = {first: "target-a1", second: "target-a2"}

    async def close_tab(_session_id: str, _target_id: str) -> _EmbeddedSessionTabs:
        await second._close()
        return _EmbeddedSessionTabs("target-a1", frozenset({"target-a1"}))

    controller = SimpleNamespace(
        activate_tab=AsyncMock(
            return_value=_EmbeddedSessionTabs(
                "target-a2",
                frozenset({"target-a1", "target-a2"}),
            ),
        ),
        close_tab=AsyncMock(side_effect=close_tab),
    )
    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
        embedded_controller=controller,
        embedded_session_id="A",
    )
    client._embedded = True
    client._context = context
    client._playwright = object()
    client._mark_owned(first)
    client._mark_owned(second)
    client._target_id = AsyncMock(side_effect=lambda page: target_ids[page])
    client._activate_page_facilities = AsyncMock()
    client._deactivate_page_facilities = AsyncMock()
    client._get_page_title = AsyncMock(side_effect=lambda page: page.name)

    await client._switch_local_page_to(first)
    success, _message = await client.switch_to_page(generate_page_id(second))
    assert success is True
    assert client._page is second
    controller.activate_tab.assert_awaited_once_with("A", "target-a2")

    success, message = await client._close_page(second)
    assert success is True
    assert "Now on" in message
    assert client._page is first
    assert client.get_pages() == [first]
    controller.close_tab.assert_awaited_once_with("A", "target-a2")
    second.close.assert_not_awaited()


async def test_embedded_inventory_reconcile_follows_ui_tab_and_rejects_sibling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import src.amphi_agent._browser as browser_module

    monkeypatch.setattr(browser_module, "_EMBEDDED_POPUP_OWNERSHIP_TIMEOUT_SECONDS", 0.01)
    context = _FakeAdapterContext([])
    a1 = _FakeAdapterPage("A1", context)
    a2 = _FakeAdapterPage("A2", context)
    b1 = _FakeAdapterPage("B1", context)
    popup = _FakeAdapterPage("popup", context)
    target_ids = {
        a1: "target-a1",
        a2: "target-a2",
        b1: "target-b1",
        popup: "target-popup",
    }
    inventories = {
        "A": _EmbeddedSessionTabs(
            "target-popup",
            frozenset({"target-a1", "target-a2", "target-popup"}),
        ),
        "B": _EmbeddedSessionTabs("target-b1", frozenset({"target-b1"})),
    }

    async def list_tabs(session_id: str) -> _EmbeddedSessionTabs:
        return inventories[session_id]

    controller = SimpleNamespace(list_tabs=AsyncMock(side_effect=list_tabs))

    def make_client(session_id: str, first: _FakeAdapterPage) -> _SessionBrowserClient:
        client = _SessionBrowserClient(
            cdp="http://127.0.0.1:43112",
            headless=False,
            auto_follow_popups=True,
            stealth=False,
            embedded_controller=controller,
            embedded_session_id=session_id,
        )
        client._embedded = True
        client._context = context
        client._playwright = object()
        client._page = first
        client._mark_owned(first)
        client._target_id = AsyncMock(side_effect=lambda page: target_ids[page])
        client._activate_page_facilities = AsyncMock()
        client._deactivate_page_facilities = AsyncMock()
        return client

    client_a = make_client("A", a1)
    client_b = make_client("B", b1)

    await client_a._maybe_adopt_page(popup)
    assert client_a._page is popup
    assert popup in client_a._owned_pages
    assert b1 not in client_a._owned_pages

    await client_b._maybe_adopt_page(popup)
    assert popup not in client_b._owned_pages
    assert client_b.get_pages() == [b1]

    inventories["A"] = _EmbeddedSessionTabs(
        "target-a2",
        frozenset({"target-a1", "target-a2", "target-popup"}),
    )
    await client_a.sync_embedded_tabs()
    assert client_a._page is a2
    assert client_a.get_pages() == [a1, a2, popup]


async def test_embedded_popup_waits_for_electron_target_registration() -> None:
    context = _FakeAdapterContext([])
    first = _FakeAdapterPage("A1", context)
    popup = _FakeAdapterPage("popup", context)
    target_ids = {first: "target-a1", popup: "target-popup"}
    inventories = iter((
        _EmbeddedSessionTabs("target-a1", frozenset({"target-a1"})),
        _EmbeddedSessionTabs(
            "target-popup",
            frozenset({"target-a1", "target-popup"}),
        ),
    ))
    controller = SimpleNamespace(list_tabs=AsyncMock(side_effect=lambda _session_id: next(inventories)))
    client = _SessionBrowserClient(
        cdp="http://127.0.0.1:43112",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
        embedded_controller=controller,
        embedded_session_id="A",
    )
    client._embedded = True
    client._context = context
    client._playwright = object()
    client._page = first
    client._mark_owned(first)
    client._target_id = AsyncMock(side_effect=lambda page: target_ids[page])
    client._activate_page_facilities = AsyncMock()

    await client._maybe_adopt_page(popup)

    assert popup in client._owned_pages
    assert client._page is popup
    assert controller.list_tabs.await_count == 2


async def test_concurrent_sessions_share_one_owner_but_not_clients() -> None:
    host = _LifecycleHost()
    session_a = host.for_session("A")
    session_b = host.for_session("B")

    await asyncio.gather(
        session_a.invoke("get_tabs"),
        session_a.invoke("get_tabs"),
        session_b.invoke("get_tabs"),
    )

    assert host.starts == 1
    assert len(host.created) == 2
    assert session_a._client is not session_b._client
    assert session_a._client is not None and session_b._client is not None
    assert session_a._client.window_id != session_b._client.window_id


async def test_session_close_is_scoped_and_reopen_gets_a_fresh_window() -> None:
    host = _LifecycleHost()
    session_a = host.for_session("A")
    session_b = host.for_session("B")
    await session_a.invoke("get_tabs")
    await session_b.invoke("get_tabs")
    first_a = session_a._client
    first_b = session_b._client

    assert await session_a.close() is True
    assert first_a is not None and first_a.close_calls == 1
    assert first_b is session_b._client and first_b.close_calls == 0
    assert host.stops == 0

    await session_a.invoke("get_tabs")
    assert session_a._client is not first_a
    assert host.starts == 1


async def test_session_close_does_not_wait_for_sibling_operation() -> None:
    host = _LifecycleHost()
    session_a = host.for_session("A")
    session_b = host.for_session("B")
    await session_a.invoke("get_tabs")
    await session_b.invoke("get_tabs")
    client_a = session_a._client
    client_b = session_b._client
    assert client_a is not None and client_b is not None
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_get_tabs() -> str:
        started.set()
        await release.wait()
        return "tabs"

    client_b.get_tabs = slow_get_tabs
    sibling_operation = asyncio.create_task(session_b.invoke("get_tabs"))
    await started.wait()

    assert await asyncio.wait_for(session_a.close(), timeout=0.2) is True
    assert client_a.close_calls == 1
    assert client_b.close_calls == 0

    release.set()
    assert await sibling_operation == "tabs"


async def test_closing_last_session_keeps_app_owner_alive_until_shutdown() -> None:
    host = _LifecycleHost()
    session = host.for_session("A")
    await session.invoke("get_tabs")

    assert await session.close() is True
    assert host.stops == 0
    assert await session.close() is False

    await session.invoke("get_tabs")
    assert host.starts == 1

    await host.shutdown()
    assert host.stops == 1


async def test_release_sessions_discards_handles_and_keeps_siblings() -> None:
    host = _LifecycleHost()
    old_a = host.for_session("A")
    session_b = host.for_session("B")
    await old_a.invoke("get_tabs")
    await session_b.invoke("get_tabs")

    await host.release_sessions(["A", "A", "missing"])

    assert old_a._client is None
    assert session_b._client is not None
    assert host.for_session("A") is not old_a
    with pytest.raises(RuntimeError, match="handle has been released"):
        await old_a.invoke("get_tabs")


async def test_shutdown_closes_sessions_before_owner_and_rejects_new_work() -> None:
    host = _LifecycleHost()
    await host.for_session("A").invoke("get_tabs")
    await host.for_session("B").invoke("get_tabs")

    await host.shutdown()
    await host.shutdown()

    assert host.events[-3:] == ["client.close", "client.close", "owner.stop"]
    assert host.stops == 1
    with pytest.raises(RuntimeError, match="shut down"):
        host.for_session("C")


async def test_get_tabs_hides_bridgic_sibling_count(monkeypatch) -> None:
    parent_get_tabs = AsyncMock(return_value=(
        "# Note: 3 other tab(s) in the connected browser are hidden.\n\n"
        "page_1234: https://session.example (active)"
    ))
    monkeypatch.setattr(Browser, "get_tabs", parent_get_tabs)
    client = _SessionBrowserClient(
        cdp="ws://127.0.0.1:9222/devtools/browser/test",
        headless=False,
        auto_follow_popups=True,
        stealth=False,
    )

    assert await client.get_tabs() == "page_1234: https://session.example (active)"
    parent_get_tabs.assert_awaited_once_with()
