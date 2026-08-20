import io
import json
import urllib.error
import urllib.request
from typing import Any

import pytest
from bridgic.browser.utils import generate_page_id

from src.amphi_agent._browser import (
    EmbeddedBrowserUnavailableError,
    _EmbeddedBrowserController,
    _EmbeddedSessionTabs,
    _SessionBrowserClient,
)


async def test_tab_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Electron tab commands:

    {
      "session": "session-a",
      "commands": ["ensure", "list", "create", "activate", "close", "release"],
      "active_tab": {"title": "Report", "url": "https://example.test/report"},
      "wrong_session_response": "rejected"
    }

    Checks:
    1. Every tab operation sends the expected Session-scoped controller command.
    2. Controller inventory becomes one active target and public tab projection.
    3. A response for another Session cannot be accepted into the caller's browser state.
    """
    requests: list[tuple[str, str, dict[str, Any] | None]] = []
    response_session = "session-a"

    def request(_controller: Any, method: str, path: str, body: dict[str, Any] | None) -> dict[str, Any]:
        requests.append((method, path, body))
        if path == "/v1/health":
            return {"status": "ok"}
        return {
            "session_id": response_session,
            "tabs": [{
                "tab_id": "tab-report",
                "target_id": "target-report",
                "title": "Report",
                "url": "https://example.test/report",
            }],
            "active_tab_id": "tab-report",
            "active_target_id": "target-report",
        }

    monkeypatch.setattr(_EmbeddedBrowserController, "_request", request)
    controller = _EmbeddedBrowserController(
        controller_id="desktop",
        generation="generation-1",
        control_url="http://127.0.0.1:3210",
        control_token="test-token",
        cdp_endpoint="http://127.0.0.1:9222",
        owner_pid=1234,
    )

    await controller.health()
    ensured = await controller.ensure_session("session-a")
    listed = await controller.list_tabs("session-a")
    created = await controller.create_tab("session-a")
    activated = await controller.activate_tab("session-a", "target-report")
    closed = await controller.close_tab("session-a", "target-report")
    await controller.release_session("session-a")

    # Check 1: The adapter preserves the Electron controller's exact command surface.
    assert requests == [
        ("GET", "/v1/health", None),
        ("POST", "/v1/sessions/ensure", {"session_id": "session-a"}),
        ("POST", "/v1/sessions/tabs/list", {"session_id": "session-a"}),
        ("POST", "/v1/sessions/tabs/create", {"session_id": "session-a"}),
        (
            "POST",
            "/v1/sessions/tabs/activate",
            {"session_id": "session-a", "target_id": "target-report"},
        ),
        (
            "POST",
            "/v1/sessions/tabs/close",
            {"session_id": "session-a", "target_id": "target-report"},
        ),
        ("POST", "/v1/sessions/release", {"session_id": "session-a"}),
    ]

    # Check 2: Every inventory response retains one active Electron target and tab.
    for inventory in (ensured, listed, created, activated, closed):
        assert inventory.active_target_id == "target-report"
        assert inventory.target_ids == frozenset({"target-report"})
        assert inventory.state is not None
        assert inventory.state.active_tab is not None
        assert inventory.state.active_tab.title == "Report"
        assert inventory.state.active_tab.url == "https://example.test/report"

    # Check 3: Session ownership is validated before inventory reaches BrowserHost.
    response_session = "session-b"
    with pytest.raises(RuntimeError, match="wrong session"):
        await controller.list_tabs("session-a")


async def test_embedded_client_lifecycle(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final embedded Playwright lifecycle:

    {
      "target": "target-report",
      "context": "borrowed from Electron",
      "disconnect": "Electron pages remain open"
    }

    Checks:
    1. The real attach path connects to the configured CDP endpoint and selects the exact target.
    2. The selected page becomes active, owned, focused, and covered by page event listeners.
    3. The real disconnect path clears local ownership before base cleanup and preserves borrowed pages.
    """
    class Page:
        def __init__(self, target_id: str) -> None:
            self.target_id = target_id
            self.closed = False
            self.close_calls = 0
            self.listeners: dict[str, list[Any]] = {}

        def is_closed(self) -> bool:
            return self.closed

        def on(self, event: str, callback: Any) -> None:
            self.listeners.setdefault(event, []).append(callback)

        def remove_listener(self, event: str, callback: Any) -> None:
            self.listeners[event].remove(callback)

        async def close(self, *, run_before_unload: bool = False) -> None:
            del run_before_unload
            self.close_calls += 1
            self.closed = True

    class CdpSession:
        def __init__(self, page: Page) -> None:
            self.page = page
            self.detached = False
            self.listeners: dict[str, list[Any]] = {}

        async def send(self, method: str, params: Any = None) -> dict[str, Any]:
            del params
            if method == "Target.getTargetInfo":
                return {"targetInfo": {"targetId": self.page.target_id}}
            return {}

        def on(self, event: str, callback: Any) -> None:
            self.listeners.setdefault(event, []).append(callback)

        async def detach(self) -> None:
            self.detached = True

    class Context:
        def __init__(self, pages: list[Page]) -> None:
            self.pages = pages
            self.close_calls = 0
            self.listeners: dict[str, list[Any]] = {}
            self.sessions: list[CdpSession] = []

        def on(self, event: str, callback: Any) -> None:
            self.listeners.setdefault(event, []).append(callback)

        def remove_listener(self, event: str, callback: Any) -> None:
            self.listeners[event].remove(callback)

        async def new_cdp_session(self, page: Page) -> CdpSession:
            session = CdpSession(page)
            self.sessions.append(session)
            return session

        async def close(self) -> None:
            self.close_calls += 1

    class Browser:
        def __init__(self, context: Context) -> None:
            self.contexts = [context]
            self.close_calls = 0

        async def close(self) -> None:
            self.close_calls += 1

    class Chromium:
        def __init__(self, browser: Browser) -> None:
            self.browser = browser
            self.endpoints: list[str] = []

        async def connect_over_cdp(self, endpoint: str) -> Browser:
            self.endpoints.append(endpoint)
            return self.browser

    class Playwright:
        def __init__(self, chromium: Chromium) -> None:
            self.chromium = chromium
            self.stop_calls = 0

        async def stop(self) -> None:
            self.stop_calls += 1

    class Starter:
        def __init__(self, playwright: Playwright) -> None:
            self.playwright = playwright
            self.start_calls = 0

        async def start(self) -> Playwright:
            self.start_calls += 1
            return self.playwright

    home = Page("target-home")
    report = Page("target-report")
    context = Context([home, report])
    connected_browser = Browser(context)
    chromium = Chromium(connected_browser)
    playwright = Playwright(chromium)
    starter = Starter(playwright)
    monkeypatch.setattr("src.amphi_agent._browser.async_playwright", lambda: starter)
    client = _SessionBrowserClient(cdp="http://127.0.0.1:9222", headless=False)

    await client.start_and_bind_embedded("target-report")

    # Check 1: The real attach path uses the configured endpoint and exact Electron target.
    assert starter.start_calls == 1
    assert chromium.endpoints == ["http://127.0.0.1:9222"]
    assert client._context is context
    assert client._page is report
    assert home not in client._owned_pages

    # Check 2: The context stays borrowed while the target gains all local ownership state.
    assert client._cdp_context_owned is False
    assert client._embedded is True
    assert client._owned_pages == {report}
    assert client._focus_stack == [report]
    assert "close" in report.listeners
    assert "page" in context.listeners
    page_listener = context.listeners["page"][0]
    assert page_listener.__self__ is client
    assert page_listener.__func__ is _SessionBrowserClient._on_new_page

    await client.disconnect_embedded()

    # Check 3: Base cleanup sees no owned pages and does not close Electron's context or pages.
    assert client._embedded is False
    assert client._owned_pages == set()
    assert client._focus_stack == []
    assert context.listeners["page"] == []
    assert home.close_calls == 0
    assert report.close_calls == 0
    assert context.close_calls == 0
    assert connected_browser.close_calls == 1
    assert playwright.stop_calls == 1
    assert client._page is None
    assert client._context is None
    assert client._browser is None
    assert client._playwright is None


async def test_tab_reconcile(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final local tab ownership:

    {
      "electron": {"active": "target-report", "removed": "target-home"},
      "agent": {"active": "target-report", "owned": ["target-report"]}
    }

    Checks:
    1. Electron's active-target change switches the Agent's local active page.
    2. A target removed by Electron leaves the Agent's owned pages and focus history.
    """
    class Page:
        def __init__(self, target_id: str) -> None:
            self.target_id = target_id

        def is_closed(self) -> bool:
            return False

    class Context:
        def __init__(self, pages: list[Page]) -> None:
            self.pages = pages

    class Controller:
        def __init__(self) -> None:
            self.listed: list[str] = []

        async def list_tabs(self, session_id: str) -> _EmbeddedSessionTabs:
            self.listed.append(session_id)
            return _EmbeddedSessionTabs(
                active_target_id="target-report",
                target_ids=frozenset({"target-report"}),
            )

    home = Page("target-home")
    report = Page("target-report")
    controller = Controller()
    client = _SessionBrowserClient(
        embedded_controller=controller,
        embedded_session_id="session-a",
    )
    client._embedded = True
    client._context = Context([home, report])
    client._page = home
    client._owned_pages = {home}
    client._focus_stack = [home]
    switched: list[Page] = []

    async def target_id(page: Page) -> str:
        return page.target_id

    async def switch(page: Page) -> None:
        switched.append(page)
        client._page = page

    monkeypatch.setattr(client, "_target_id", target_id)
    monkeypatch.setattr(client, "_switch_local_page_to", switch)
    await client.sync_embedded_tabs()

    # Check 1: The real reconciliation path follows Electron's selected target.
    assert controller.listed == ["session-a"]
    assert switched == [report]
    assert client._page is report

    # Check 2: Electron's removed target cannot remain visible through Agent ownership.
    assert client._owned_pages == {report}
    assert client._focus_stack == [report]


async def test_tab_actions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Electron-compatible tab actions:

    {
      "create": "target-report is allocated, owned, and selected",
      "switch": "target-home is activated before local selection",
      "close": "target-home is removed and target-report becomes active"
    }

    Checks:
    1. Public tab creation attaches the exact target allocated by Electron.
    2. Public tab switching activates Electron's target before selecting its local Page.
    3. Public tab closing removes Electron's target, local ownership, and stale focus state.
    """
    class Page:
        def __init__(self, target_id: str, title: str) -> None:
            self.target_id = target_id
            self.url = f"https://example.test/{title.lower()}"
            self.title_text = title
            self.closed = False

        def is_closed(self) -> bool:
            return self.closed

        def on(self, event: str, callback: Any) -> None:
            del event, callback

        async def title(self) -> str:
            return self.title_text

    class Context:
        def __init__(self, pages: list[Page]) -> None:
            self.pages = pages

    class Browser:
        def __init__(self, context: Context) -> None:
            self.contexts = [context]

    home = Page("target-home", "Home")
    report = Page("target-report", "Report")
    context = Context([home])

    class Controller:
        def __init__(self) -> None:
            self.calls: list[tuple[str, ...]] = []

        async def create_tab(self, session_id: str) -> _EmbeddedSessionTabs:
            assert client._page is home
            self.calls.append(("create", session_id))
            context.pages.append(report)
            return self.tabs("target-report")

        async def activate_tab(self, session_id: str, target_id: str) -> _EmbeddedSessionTabs:
            assert client._page is report
            self.calls.append(("activate", session_id, target_id))
            return self.tabs(target_id)

        async def close_tab(self, session_id: str, target_id: str) -> _EmbeddedSessionTabs:
            assert client._page is home
            self.calls.append(("close", session_id, target_id))
            page = next(page for page in context.pages if page.target_id == target_id)
            page.closed = True
            return self.tabs("target-report")

        def tabs(self, active_target_id: str) -> _EmbeddedSessionTabs:
            return _EmbeddedSessionTabs(
                active_target_id=active_target_id,
                target_ids=frozenset(
                    page.target_id for page in context.pages if not page.closed
                ),
            )

    controller = Controller()
    client = _SessionBrowserClient(
        embedded_controller=controller,  # type: ignore[arg-type]
        embedded_session_id="session-a",
    )
    client._playwright = object()
    client._browser = Browser(context)
    client._context = context
    client._embedded = True
    client._page = home
    client._mark_owned(home)

    async def target_id(page: Page) -> str:
        return page.target_id

    async def page_facility(page: Page) -> None:
        del page

    monkeypatch.setattr(client, "_target_id", target_id)
    monkeypatch.setattr(client, "_activate_page_facilities", page_facility)
    monkeypatch.setattr(client, "_deactivate_page_facilities", page_facility)

    created = await client.new_tab()

    # Check 1: Creation follows the target allocated by Electron and owns that Page only after attach.
    assert controller.calls == [("create", "session-a")]
    assert generate_page_id(report) in created
    assert client._page is report
    assert client._owned_pages == {home, report}

    switched = await client.switch_tab(generate_page_id(home))

    # Check 2: Switching resolves the public page id to Electron's exact target.
    assert controller.calls[-1] == ("activate", "session-a", "target-home")
    assert switched.startswith(f"Switched to tab {generate_page_id(home)}")
    assert client._page is home

    closed = await client.close_tab(generate_page_id(home))

    # Check 3: Closing reconciles both Electron inventory and Agent-local ownership.
    assert controller.calls[-1] == ("close", "session-a", "target-home")
    assert closed.startswith(f"Closed tab {generate_page_id(home)}")
    assert client._page is report
    assert client._owned_pages == {report}
    assert client._focus_stack == [report]


def test_request_wire(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final controller request:

    {
      "method": "POST",
      "authorization": "Bearer test-token",
      "body": {"session_id": "session-a"},
      "response": {"status": "ok"}
    }

    Checks:
    1. The loopback request carries the exact method, URL, bearer token and JSON body.
    2. A JSON object response is returned to the Electron command adapter.
    """
    captured: dict[str, Any] = {}

    def urlopen(request: urllib.request.Request, timeout: float) -> io.BytesIO:
        captured.update({"request": request, "timeout": timeout})
        return io.BytesIO(b'{"status":"ok"}')

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    controller = _EmbeddedBrowserController(
        controller_id="desktop",
        generation="generation-1",
        control_url="http://127.0.0.1:3210/",
        control_token="test-token",
        cdp_endpoint="http://127.0.0.1:9222",
        owner_pid=1234,
    )
    result = controller._request("POST", "/v1/sessions/ensure", {"session_id": "session-a"})
    request = captured["request"]

    # Check 1: The controller sends the authenticated JSON request over loopback.
    assert request.get_method() == "POST"
    assert request.full_url == "http://127.0.0.1:3210/v1/sessions/ensure"
    assert request.get_header("Authorization") == "Bearer test-token"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data.decode("utf-8")) == {"session_id": "session-a"}
    assert captured["timeout"] > 0

    # Check 2: A successful JSON object is returned unchanged.
    assert result == {"status": "ok"}


def test_request_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final controller failures:

    {
      "409": "operation RuntimeError with Electron detail",
      "401_or_5xx": "EmbeddedBrowserUnavailableError",
      "invalid_json": "controlled RuntimeError"
    }

    Checks:
    1. An ordinary domain 4xx remains a local operation error.
    2. Authentication and server failures mark the embedded controller unavailable.
    3. A malformed success payload is rejected before it reaches browser state.
    """
    controller = _EmbeddedBrowserController(
        controller_id="desktop",
        generation="generation-1",
        control_url="http://127.0.0.1:3210",
        control_token="test-token",
        cdp_endpoint="http://127.0.0.1:9222",
        owner_pid=1234,
    )

    def reject(request: urllib.request.Request, timeout: float) -> io.BytesIO:
        del timeout
        code = int(request.full_url.rsplit("/", 1)[-1])
        payload = io.BytesIO(b'{"error":"tab does not belong to this session"}')
        raise urllib.error.HTTPError(request.full_url, code, "rejected", {}, payload)

    monkeypatch.setattr(urllib.request, "urlopen", reject)

    # Check 1: A domain conflict stays distinct from controller unavailability.
    with pytest.raises(RuntimeError, match="HTTP 409.*tab does not belong") as conflict:
        controller._request("POST", "/409", {})
    assert not isinstance(conflict.value, EmbeddedBrowserUnavailableError)

    # Check 2: Authentication and server failures invalidate controller availability.
    for code in (401, 503):
        with pytest.raises(EmbeddedBrowserUnavailableError):
            controller._request("GET", f"/{code}", None)

    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda request, timeout: io.BytesIO(b"not-json"),
    )

    # Check 3: Invalid JSON cannot enter the browser controller state model.
    with pytest.raises(RuntimeError, match="invalid JSON"):
        controller._request("GET", "/v1/health", None)
