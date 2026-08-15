"""Unit coverage for the public-web search tool."""

from __future__ import annotations

import base64
import re

import brotli
import httpx
import pytest

from src.amphi_agent.tools import _web_search
from src.amphi_agent.tools._web_search import web_search, web_search_tool


def _mock_http(
    monkeypatch: pytest.MonkeyPatch,
    handler,
    client_kwargs: list[dict] | None = None,
) -> None:
    original = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def client(**kwargs):
        if client_kwargs is not None:
            client_kwargs.append(kwargs)
        return original(transport=transport, **kwargs)

    monkeypatch.setattr(_web_search.httpx, "AsyncClient", client)


def _bing_redirect_url(target: str) -> str:
    encoded = base64.urlsafe_b64encode(target.encode("utf-8")).decode("ascii")
    return f"https://www.bing.com/ck/a?u=a1{encoded.rstrip('=')}&ntb=1"


def test_web_search_tool_schema_includes_baidu() -> None:
    tool = web_search_tool.to_tool()

    assert tool.parameters["properties"]["search_engine"]["enum"] == [
        "duckduckgo",
        "bing",
        "baidu",
    ]


async def test_web_search_extracts_results_and_resolves_bing_redirect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One round trip covers header negotiation (Accept-Encoding: br), brotli
    decoding of the Bing HTML, result extraction, and Bing-redirect decoding."""
    target = "https://example.com/path?q=1"
    html = f"""
            <ol id="b_results">
              <li class="b_algo">
                <h2><a href="{_bing_redirect_url(target)}">
                  <strong>Example</strong> Domain
                </a></h2>
                <div class="b_caption"><p>A &amp; B snippet.</p></div>
              </li>
            </ol>
            """

    client_kwargs: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "www.bing.com"
        assert request.url.path == "/search"
        assert request.url.params["q"] == "OpenAI"
        assert request.url.params["setmkt"] == "en-US"
        assert request.url.params["form"] == "QBLH"
        assert re.fullmatch(r"[0-9A-F]{32}", request.url.params["cvid"])
        assert "br" in request.headers["accept-encoding"]
        assert request.headers["accept-language"] == "en-US,en;q=0.9"
        assert "referer" not in request.headers
        assert request.headers["sec-fetch-site"] == "none"
        assert "cookie" not in request.headers
        return httpx.Response(
            200,
            content=brotli.compress(html.encode("utf-8")),
            headers={
                "content-encoding": "br",
                "content-type": "text/html; charset=utf-8",
            },
        )

    _mock_http(monkeypatch, handler, client_kwargs)

    output = await web_search("OpenAI", search_engine="bing", num_results=3)

    assert 'Web search results for query: "OpenAI"' in output
    assert "[Example Domain](https://example.com/path?q=1)" in output
    assert "A & B snippet." in output
    assert client_kwargs[0]["http2"] is True


async def test_web_search_defaults_to_duckduckgo_and_resolves_redirect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = "https://example.com/path?q=1"
    html = """
            <div class="result results_links">
              <div class="result__body">
                <h2 class="result__title">
                  <a class="result__a"
                     href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1&amp;rut=abc">
                    <strong>Example</strong> Domain
                  </a>
                </h2>
                <a class="result__snippet">A &amp; B snippet.</a>
              </div>
            </div>
            """

    client_kwargs: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "html.duckduckgo.com"
        assert request.url.path == "/html/"
        assert dict(request.url.params) == {"q": "OpenAI"}
        assert "br" in request.headers["accept-encoding"]
        assert request.headers["accept-language"] == "en-US,en;q=0.9"
        assert "referer" not in request.headers
        assert request.headers["sec-fetch-site"] == "none"
        assert "cookie" not in request.headers
        return httpx.Response(
            200,
            content=brotli.compress(html.encode("utf-8")),
            headers={
                "content-encoding": "br",
                "content-type": "text/html; charset=utf-8",
            },
        )

    _mock_http(monkeypatch, handler, client_kwargs)

    output = await web_search("OpenAI", num_results=3)

    assert f"[Example Domain]({target})" in output
    assert "A & B snippet." in output
    assert client_kwargs[0]["http2"] is True


async def test_web_search_extracts_baidu_results_and_uses_original_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = "https://example.com/market?q=1"
    html = f"""
            <div id="content_left">
              <div class="result c-container" mu="{target}">
                <h3><a href="http://www.baidu.com/link?url=opaque">
                  <em>Example</em> Market
                </a></h3>
                <div class="cos-line-clamp-3">
                  Today&apos;s <em>market</em> snippet.
                </div>
              </div>
              <div class="result-op c-container" mu="http://nourl.baidu.com/1">
                <div>Related searches are not organic results.</div>
              </div>
            </div>
            """

    client_kwargs: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "www.baidu.com"
        assert request.url.path == "/s"
        assert request.url.params["wd"] == "A股 今日 收盘"
        assert request.url.params["ie"] == "utf-8"
        assert request.url.params["f"] == "8"
        assert request.url.params["rsv_bp"] == "1"
        assert request.url.params["rsv_idx"] == "1"
        assert request.url.params["tn"] == "baidu"
        assert request.url.params["fenlei"] == "256"
        assert request.url.params["rqlang"] == "cn"
        assert request.url.params["rsv_enter"] == "1"
        assert request.url.params["rsv_dl"] == "ib"
        assert request.headers["accept-language"] == "zh-CN,zh;q=0.9"
        assert request.headers["referer"] == "https://www.baidu.com/"
        assert request.headers["sec-fetch-site"] == "same-origin"
        assert request.headers["cache-control"] == "max-age=0"
        assert "cookie" not in request.headers
        return httpx.Response(200, text=html)

    _mock_http(monkeypatch, handler, client_kwargs)

    output = await web_search(
        "A股 今日 收盘", search_engine="baidu", num_results=3
    )

    assert f"[Example Market]({target})" in output
    assert "Today's market snippet." in output
    assert "opaque" not in output
    assert client_kwargs[0]["http2"] is True


async def test_web_search_rejects_unsupported_search_engine() -> None:
    with pytest.raises(
        ValueError,
        match="search_engine must be one of: duckduckgo, bing, baidu",
    ):
        await web_search("docs", search_engine="google")


async def test_chinese_query_uses_localized_duckduckgo_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text='<div id="links"></div>')

    _mock_http(monkeypatch, handler)

    await web_search("A股 今日 收盘")

    assert len(requests) == 1
    search = requests[0]
    assert search.url.host == "html.duckduckgo.com"
    assert search.url.path == "/html/"
    assert search.headers["accept-language"] == "zh-CN,zh;q=0.9"
    assert "referer" not in search.headers
    assert search.headers["sec-fetch-site"] == "none"
    assert "cookie" not in search.headers
    assert search.url.params["q"] == "A股 今日 收盘"
    assert len(search.url.params) == 1


async def test_chinese_query_uses_localized_bing_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text='<ol id="b_results"></ol>')

    _mock_http(monkeypatch, handler)

    await web_search("A股 今日 收盘", search_engine="bing")

    assert len(requests) == 1
    search = requests[0]
    assert search.url.host == "www.bing.com"
    assert search.url.path == "/search"
    assert search.headers["accept-language"] == "zh-CN,zh;q=0.9"
    assert "referer" not in search.headers
    assert search.headers["sec-fetch-site"] == "none"
    assert "cookie" not in search.headers
    assert search.url.params["q"] == "A股 今日 收盘"
    assert "setmkt" not in search.url.params
    assert dict(search.url.params).items() >= {
        "form": "QBLH",
        "sp": "-1",
        "lq": "0",
        "sc": "0-0",
        "qs": "n",
    }.items()


async def test_english_query_uses_localized_baidu_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text='<div id="content_left"></div>')

    _mock_http(monkeypatch, handler)

    await web_search("OpenAI docs", search_engine="baidu")

    assert len(requests) == 1
    search = requests[0]
    assert search.headers["accept-language"] == "en-US,en;q=0.9"
    assert search.headers["referer"] == "https://www.baidu.com/"
    assert search.headers["sec-fetch-site"] == "same-origin"
    assert search.url.params["wd"] == "OpenAI docs"
    assert search.url.params["rqlang"] == "en"
