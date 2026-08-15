"""Unit coverage for the public-web fetch and model-processing tool."""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.tools import _web_fetch
from src.amphi_agent.tools._web_fetch import (
    MAX_URL_LENGTH,
    _validate_url,
    web_fetch,
    web_fetch_tool,
)


class _Llm:
    def __init__(self) -> None:
        self.messages: list[list[Message]] = []

    async def achat(self, messages: list[Message]) -> Response:
        self.messages.append(messages)
        return Response(message=Message.from_text("model result", role=Role.AI))


@contextmanager
def _running_agent(llm: _Llm):
    token = current_agent.set(SimpleNamespace(_llm=llm))
    try:
        yield
    finally:
        current_agent.reset(token)


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    _web_fetch._URL_CACHE.clear()


def _mock_http(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    original = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def client(**kwargs):
        return original(transport=transport, **kwargs)

    monkeypatch.setattr(_web_fetch.httpx, "AsyncClient", client)


async def test_schema_registration_and_html_to_markdown(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The tool advertises its schema + registers on the OTA context, and the
    happy path fetches HTML, scrubs scripts, renders it to markdown, and feeds
    that (with the user prompt) to the current agent's LLM. Debug output is off
    by default and, once AMPHI_WEB_FETCH_DEBUG is set, persists raw.html /
    content.md / meta.json for the same fetch."""
    # Schema / registration.
    assert web_fetch_tool.tool_name == "web_fetch"
    assert "Fetch a URL" in web_fetch_tool.tool_description
    schema = web_fetch_tool.tool_parameters
    assert schema["required"] == ["url", "prompt"]
    assert schema["properties"]["url"]["format"] == "uri"
    assert "URL to fetch" in schema["properties"]["url"]["description"]
    assert "prompt" in schema["properties"]["prompt"]["description"]
    assert "web_fetch" in {s.tool_name for s in TOOL_LIBRARY.all()}

    # Happy path: html → markdown → LLM. Shared fetch setup for both the
    # default (no debug) and debug-enabled assertions below.
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            text="<h1>Docs</h1><p>Use <strong>widgets</strong>.</p>"
            "<script>ignore me</script>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    _mock_http(monkeypatch, handler)
    monkeypatch.chdir(tmp_path)
    llm = _Llm()
    with _running_agent(llm):
        result = await web_fetch("http://example.com/docs", "Summarize the page")

    assert result == "model result"
    assert requests[0].url == httpx.URL("https://example.com/docs")
    assert [message.role for message in llm.messages[0]] == [Role.SYSTEM, Role.USER]
    system_prompt = llm.messages[0][0].blocks[0].text
    model_prompt = llm.messages[0][1].blocks[0].text
    assert "125-character maximum" in system_prompt
    assert "# Docs" in model_prompt
    assert "**widgets**" in model_prompt
    assert "ignore me" not in model_prompt
    assert "Summarize the page" in model_prompt

    # Default: nothing is written to disk.
    assert not (tmp_path / "amphi_web_fetch_debug").exists()

    # Debug enabled: the same fetch persists raw.html / content.md / meta.json.
    _web_fetch._URL_CACHE.clear()
    monkeypatch.setenv("AMPHI_WEB_FETCH_DEBUG", "1")
    with _running_agent(llm):
        assert await web_fetch("http://example.com/docs", "Summarize") == "model result"

    debug_roots = list((tmp_path / "amphi_web_fetch_debug").iterdir())
    assert len(debug_roots) == 1
    raw_path = debug_roots[0] / "raw.html"
    markdown_path = debug_roots[0] / "content.md"
    meta_path = debug_roots[0] / "meta.json"
    assert "<h1>Docs</h1>" in raw_path.read_text()
    assert "# Docs" in markdown_path.read_text()
    meta = json.loads(meta_path.read_text())
    assert meta["url"] == "http://example.com/docs"
    assert meta["current_url"] == "https://example.com/docs"
    assert meta["raw_html_path"] == str(raw_path)
    assert meta["markdown_path"] == str(markdown_path)
    assert meta["meta_path"] == str(meta_path)


@pytest.mark.parametrize(
    ("location", "marker"),
    [
        # Cross-host redirect: returned to the model as guidance, not followed.
        ("https://other.example/path", "REDIRECT DETECTED"),
        # Same-host scheme downgrade: also surfaced, never auto-followed.
        ("http://example.com/insecure", "was not followed automatically"),
    ],
)
async def test_redirect_surfaced_as_guidance_without_model_call(
    monkeypatch: pytest.MonkeyPatch, location: str, marker: str,
) -> None:
    """A redirect that must not be auto-followed comes back as a textual
    guidance string carrying the target url + the original prompt, and the
    LLM is never invoked (no agent context needed)."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": location})

    _mock_http(monkeypatch, handler)
    result = await web_fetch("https://example.com/start", "Find the title")

    assert marker in result
    assert f'url: "{location}"' in result
    assert 'prompt: "Find the title"' in result


async def test_same_host_redirect_is_followed_and_fetch_is_cached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A same-host, same-scheme redirect IS followed; the resolved fetch is
    cached, so a second call for the same url hits no network but still
    re-runs the model with the cached body."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        return httpx.Response(
            200, text="cached body", headers={"content-type": "text/plain"}
        )

    _mock_http(monkeypatch, handler)
    llm = _Llm()
    with _running_agent(llm):
        assert await web_fetch("https://example.com/old", "first") == "model result"
        assert await web_fetch("https://example.com/old", "second") == "model result"

    assert [request.url.path for request in requests] == ["/old", "/new"]
    assert len(llm.messages) == 2
    assert llm.messages[0][0].content == llm.messages[1][0].content
    assert "cached body" in llm.messages[1][1].blocks[0].text


async def test_failure_modes_never_reach_the_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The tool fails closed and never burns a model call: URL validation
    rejects bad inputs with specific messages (sync), and transport-layer
    failures — an HTTP error status and a read timeout — propagate from the
    fetch without ever invoking the LLM."""
    # URL validation — specific, actionable messages, before any I/O.
    cases = [
        ("", "URL is required."),
        (
            "https://example.com/" + "x" * MAX_URL_LENGTH,
            f"URL exceeds the maximum length of {MAX_URL_LENGTH} characters.",
        ),
        ("ftp://example.com/file", "URL must use the http or https scheme."),
        ("https:///path", "URL must include a hostname."),
        (
            "https://user:pass@example.com/private",
            "URL must not include a username or password.",
        ),
        (
            "https://localhost/private",
            "URL hostname must be fully qualified (for example, example.com).",
        ),
    ]
    for url, message in cases:
        with pytest.raises(ValueError) as exc_info:
            _validate_url(url)
        assert str(exc_info.value) == message

    # Transport failures propagate from the fetch; the model is never called.
    # Each handler is installed fresh via the function-scoped ``monkeypatch``
    # (a new context per parametrized case) so the second mock wraps the real
    # ``httpx.AsyncClient``, not the first mock's wrapper.
    def error_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out while reading response", request=request)

    # HTTP error status → HTTPStatusError, no model call.
    with monkeypatch.context() as mp:
        _mock_http(mp, error_handler)
        llm = _Llm()
        with _running_agent(llm):
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                await web_fetch("https://example.com/missing", "Summarize the page")
        assert exc_info.value.response.status_code == 404
        assert llm.messages == []

    # Read timeout → ReadTimeout, no model call.
    with monkeypatch.context() as mp:
        _mock_http(mp, timeout_handler)
        llm = _Llm()
        with _running_agent(llm):
            with pytest.raises(httpx.ReadTimeout, match="timed out"):
                await web_fetch("https://example.com/slow", "Summarize the page")
        assert llm.messages == []
