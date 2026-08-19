import base64
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from bridgic.core.model.types import Message, Response, Role

from src.amphi_agent.tools import _web_fetch as web_fetch_module
from src.amphi_agent.tools import _web_search as web_search_module
from src.amphi_agent.tools._web_fetch import web_fetch
from src.amphi_agent.tools._web_search import web_search
from tests.agent.tools._harness import ToolHarness


async def test_web_search(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final web search output:

    {
      "query": "agent testing",
      "links": [{"title": "Testing Guide", "url": "https://docs.example.test/testing"}],
      "omitted_by_limit": "Second Guide"
    }

    Checks:
    1. The selected engine receives the trimmed query through its fetch boundary.
    2. Search markup becomes a concise Markdown link with its snippet.
    3. The requested result limit is enforced before the response is returned.
    4. Empty queries and unsupported engines are rejected before any fetch.
    """
    queries: list[str] = []

    async def fetch_html(query: str) -> str:
        queries.append(query)
        return """
        <div class="result">
          <a class="result__a"
             href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.test%2Ftesting">
            Testing Guide
          </a>
          <div class="result__snippet">A focused testing reference.</div>
        </div>
        <div class="result">
          <a class="result__a" href="https://docs.example.test/second">Second Guide</a>
        </div>
        """

    monkeypatch.setattr(web_search_module, "_fetch_duckduckgo_html", fetch_html)

    # Check 1: The selected engine receives the trimmed query through its fetch boundary.
    result = await web_search("  agent testing  ", num_results=1)
    assert queries == ["agent testing"]

    # Check 2: Search markup becomes a concise Markdown link with its snippet.
    assert "[Testing Guide](https://docs.example.test/testing): A focused testing reference." in result

    # Check 3: The requested result limit is enforced before the response is returned.
    assert "Second Guide" not in result
    assert "MUST include the sources above" in result

    # Check 4: Empty queries and unsupported engines are rejected before any fetch.
    with pytest.raises(ValueError, match="query is required"):
        await web_search(" ")
    with pytest.raises(ValueError, match="must be one of"):
        await web_search("valid query", search_engine="other")
    assert queries == ["agent testing"]


async def test_search_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    """Final engine-specific results:

    {
      "bing": {"title": "Bing Guide", "url": "https://bing-result.example.test"},
      "baidu": {"title": "Baidu Guide", "url": "https://baidu-result.example.test"}
    }

    Checks:
    1. Selecting Bing uses its fetch path and extracts its result-card structure.
    2. Selecting Baidu uses its fetch path and prefers the card's direct destination URL.
    3. Each provider preserves its own title, URL, and snippet without leaking the other result.
    """
    fetched: list[tuple[str, str]] = []

    async def fetch_bing(query: str) -> str:
        fetched.append(("bing", query))
        target = "https://bing-result.example.test"
        encoded = base64.urlsafe_b64encode(target.encode()).decode().rstrip("=")
        return f"""
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?u=a1{encoded}">Bing Guide</a></h2>
          <div class="b_caption"><p>Bing summary.</p></div>
        </li>
        """

    async def fetch_baidu(query: str) -> str:
        fetched.append(("baidu", query))
        return """
        <div id="content_left">
          <div class="c-container" mu="https://baidu-result.example.test">
            <h3><a href="https://www.baidu.com/link?url=opaque">Baidu Guide</a></h3>
            <div class="c-abstract">Baidu summary.</div>
          </div>
        </div>
        """

    monkeypatch.setattr(web_search_module, "_fetch_bing_html", fetch_bing)
    monkeypatch.setattr(web_search_module, "_fetch_baidu_html", fetch_baidu)

    # Check 1: Selecting Bing uses its fetch path and extracts its result-card structure.
    bing = await web_search("engine contract", search_engine="bing")
    assert "[Bing Guide](https://bing-result.example.test): Bing summary." in bing

    # Check 2: Selecting Baidu uses its fetch path and prefers the card's direct destination URL.
    baidu = await web_search("engine contract", search_engine="baidu")
    assert "[Baidu Guide](https://baidu-result.example.test): Baidu summary." in baidu

    # Check 3: Each provider preserves its own title, URL, and snippet without leaking the other result.
    assert fetched == [("bing", "engine contract"), ("baidu", "engine contract")]
    assert "Baidu Guide" not in bing
    assert "Bing Guide" not in baidu


async def test_web_fetch(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final fetched-page analysis:

    {
      "page": "# Release notes",
      "request": "Extract the version",
      "model_result": "Version 2.0",
      "roles": ["system", "user"]
    }

    Checks:
    1. Fetched Markdown and the extraction request are isolated in the secondary model prompt.
    2. The analysis call uses one policy System message followed by one page User message.
    3. The secondary model's text is returned as the public tool result.
    4. A missing Turn LLM fails explicitly instead of returning unanalyzed page content.
    """
    calls: list[list[Message]] = []

    class RecordingLlm:
        async def achat(self, messages: list[Message], **_: Any) -> Response:
            calls.append(messages)
            return Response(message=Message.from_text("Version 2.0", role=Role.AI))

    async def fetch_page(url: str) -> Any:
        assert url == "https://docs.example.test/releases"
        return SimpleNamespace(content="# Release notes\n\nVersion 2.0 is current.")

    monkeypatch.setattr(web_fetch_module, "_get_url_markdown_content", fetch_page)
    tool_harness.agent._llm = RecordingLlm()

    # Check 1: Fetched Markdown and the extraction request are isolated in the secondary model prompt.
    result = await web_fetch("https://docs.example.test/releases", "Extract the version")
    assert len(calls) == 1
    assert "Extraction request:\nExtract the version" in calls[0][1].content
    assert "# Release notes\n\nVersion 2.0 is current." in calls[0][1].content

    # Check 2: The analysis call uses one policy System message followed by one page User message.
    assert [message.role for message in calls[0]] == [Role.SYSTEM, Role.USER]
    assert "125-character maximum" in calls[0][0].content

    # Check 3: The secondary model's text is returned as the public tool result.
    assert result == "Version 2.0"

    # Check 4: A missing Turn LLM fails explicitly instead of returning unanalyzed page content.
    tool_harness.agent._llm = None
    with pytest.raises(RuntimeError, match="inside an agent turn with an LLM"):
        await web_fetch("https://docs.example.test/releases", "Extract the version")


async def test_web_transport(tool_harness: ToolHarness, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final fetched-page transport:

    {
      "cross_origin_redirect": "returned without following",
      "http_input": "upgraded to HTTPS",
      "same_origin_redirect": "followed",
      "html": "converted to Markdown before analysis",
      "non_http_scheme": "rejected"
    }

    Checks:
    1. A real cross-origin redirect response becomes a follow-up instruction without an LLM call.
    2. An HTTP input upgrades to HTTPS and follows a relative same-origin redirect.
    3. Real HTML response content becomes Markdown before reaching the Turn LLM.
    4. Non-HTTP schemes are rejected before opening a network request.
    """
    real_client = httpx.AsyncClient
    requests: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.host == "source.example.test":
            return httpx.Response(302, headers={"location": "https://target.example.test/page"})
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/final"})
        return httpx.Response(
            200,
            text="<h1>Release notes</h1><p>Version 2.0 is current.</p>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    def client_factory(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handle), **kwargs)

    class RecordingLlm:
        def __init__(self) -> None:
            self.calls: list[list[Message]] = []

        async def achat(self, messages: list[Message]) -> Response:
            self.calls.append(messages)
            return Response(message=Message.from_text("Version 2.0", role=Role.AI))

    monkeypatch.setattr(web_fetch_module.httpx, "AsyncClient", client_factory)
    llm = RecordingLlm()
    tool_harness.agent._llm = llm

    # Check 1: A cross-origin redirect becomes a follow-up instruction without an LLM call.
    result = await web_fetch("https://source.example.test/page", "Summarize the page")
    assert "REDIRECT DETECTED" in result
    assert 'url: "https://target.example.test/page"' in result
    assert 'prompt: "Summarize the page"' in result
    assert llm.calls == []

    # Check 2: An HTTP input upgrades to HTTPS and follows a relative same-origin redirect.
    analyzed = await web_fetch("http://content.example.test/start", "Extract the version")
    assert requests[-2:] == [
        "https://content.example.test/start",
        "https://content.example.test/final",
    ]

    # Check 3: Real HTML content becomes Markdown before reaching the Turn LLM.
    assert analyzed == "Version 2.0"
    assert "# Release notes" in llm.calls[0][1].content
    assert "Version 2.0 is current." in llm.calls[0][1].content

    # Check 4: Non-HTTP schemes are rejected before opening a network request.
    with pytest.raises(ValueError, match="http or https"):
        await web_fetch("file:///tmp/secret", "Read it")
