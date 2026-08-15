from __future__ import annotations

import base64
import re
import time
import uuid
from dataclasses import dataclass
from typing import Annotated, Optional
from urllib.parse import parse_qs, urlsplit

import httpx
from bs4 import BeautifulSoup, Tag
from bridgic.core.agentic.tool_specs import FunctionToolSpec
from pydantic import WithJsonSchema

from ...amphi_service.i18n import CJK_CHAR_RE

FETCH_TIMEOUT_SECONDS = 30.0
DEFAULT_NUM_RESULTS = 8
MAX_NUM_RESULTS = 20
DEFAULT_SEARCH_ENGINE = "duckduckgo"
SUPPORTED_SEARCH_ENGINES = frozenset({"duckduckgo", "bing", "baidu"})

_CHROME_MAJOR_VERSION = "150"
# Single shared "is this text Chinese" predicate \u2014 a drifting local copy here
# once meant web search and display-locale detection could disagree on the
# same message.
_CHINESE_QUERY_RE = CJK_CHAR_RE

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        f"Chrome/{_CHROME_MAJOR_VERSION}.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8,"
        "application/signed-exchange;v=b3;q=0.7"
    ),
    # httpx automatically decodes gzip, deflate, and br when Brotli support is
    # installed in the runtime.
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": (
        f'"Not;A=Brand";v="8", "Chromium";v="{_CHROME_MAJOR_VERSION}", '
        f'"Google Chrome";v="{_CHROME_MAJOR_VERSION}"'
    ),
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Priority": "u=0, i",
}


@dataclass(frozen=True)
class _SearchResult:
    title: str
    url: str
    snippet: Optional[str] = None


async def web_search(
    query: str,
    search_engine: Annotated[
        str,
        WithJsonSchema(
            {"type": "string", "enum": ["duckduckgo", "bing", "baidu"]}
        ),
    ] = DEFAULT_SEARCH_ENGINE,
    num_results: int = DEFAULT_NUM_RESULTS,
) -> str:
    """Search the public web and return relevant links with snippets.

    Use this read-only tool when current, recent, niche, or externally hosted
    information is needed before answering. Prefer DuckDuckGo for most
    searches; switch to Bing or Baidu if it fails or returns irrelevant
    results. Results include titles, URLs, and short snippets when available.
    This tool does not fetch full page content and cannot access authenticated
    or private pages; use web_fetch with a returned URL when a result needs
    deeper page-level analysis.

    Args:
        query: The web search query to execute. Use a focused natural-language
            query or a keyword query, including names, dates, or domains when
            they help narrow the search.
        search_engine: Search engine to use. Supported values are
            ``duckduckgo``, ``bing``, and ``baidu``. Defaults to
            ``duckduckgo``.
        num_results: Number of links to return. Defaults to 8 and is capped at
            20 to keep tool output concise.

    Returns:
        A formatted list of search results. Use the returned URLs as markdown
        hyperlinks in the final response whenever relying on those sources.
    """
    cleaned_query = query.strip()
    if not cleaned_query:
        raise ValueError("query is required")
    if len(cleaned_query) < 2:
        raise ValueError("query must be at least 2 characters")
    if search_engine not in SUPPORTED_SEARCH_ENGINES:
        raise ValueError(
            "search_engine must be one of: duckduckgo, bing, baidu"
        )

    limit = max(1, min(int(num_results or DEFAULT_NUM_RESULTS), MAX_NUM_RESULTS))

    start = time.perf_counter()
    if search_engine == "duckduckgo":
        html_text = await _fetch_duckduckgo_html(cleaned_query)
        raw_results = _extract_duckduckgo_results(html_text)
    elif search_engine == "bing":
        html_text = await _fetch_bing_html(cleaned_query)
        raw_results = _extract_bing_results(html_text)
    else:
        html_text = await _fetch_baidu_html(cleaned_query)
        raw_results = _extract_baidu_results(html_text)
    results = raw_results[:limit]
    duration = time.perf_counter() - start

    return _format_results(cleaned_query, results, duration)


async def _fetch_duckduckgo_html(query: str) -> str:
    locale = _query_locale(query)
    async with httpx.AsyncClient(
        timeout=FETCH_TIMEOUT_SECONDS,
        follow_redirects=True,
        headers=_navigation_headers(locale),
        http2=True,
    ) as client:
        response = await client.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
        )
        response.raise_for_status()
        return response.text


async def _fetch_bing_html(query: str) -> str:
    locale = _query_locale(query)
    async with httpx.AsyncClient(
        timeout=FETCH_TIMEOUT_SECONDS,
        follow_redirects=True,
        headers=_navigation_headers(locale),
        http2=True,
    ) as client:
        response = await client.get(
            "https://www.bing.com/search",
            params=_search_params(query, locale),
        )
        response.raise_for_status()
        return response.text


async def _fetch_baidu_html(query: str) -> str:
    locale = _query_locale(query)
    async with httpx.AsyncClient(
        timeout=FETCH_TIMEOUT_SECONDS,
        follow_redirects=True,
        headers=_baidu_navigation_headers(locale),
        http2=True,
    ) as client:
        response = await client.get(
            "https://www.baidu.com/s",
            params=_baidu_search_params(query, locale),
        )
        response.raise_for_status()
        return response.text


def _query_locale(query: str) -> str:
    return "zh-CN" if _CHINESE_QUERY_RE.search(query) else "en-US"


def _navigation_headers(locale: str) -> dict[str, str]:
    headers = dict(BROWSER_HEADERS)
    headers["Accept-Language"] = (
        "zh-CN,zh;q=0.9" if locale == "zh-CN" else "en-US,en;q=0.9"
    )
    return headers


def _baidu_navigation_headers(locale: str) -> dict[str, str]:
    headers = _navigation_headers(locale)
    headers.update(
        {
            "Cache-Control": "max-age=0",
            "Referer": "https://www.baidu.com/",
            "Sec-Fetch-Site": "same-origin",
        }
    )
    return headers


def _search_params(query: str, locale: str) -> dict[str, str]:
    params = {
        "q": query,
        "form": "QBLH",
        "sp": "-1",
        "lq": "0",
        "pq": "",
        "sc": "0-0",
        "qs": "n",
        "sk": "",
        "cvid": uuid.uuid4().hex.upper(),
    }
    if locale == "en-US":
        params["setmkt"] = locale
    return params


def _baidu_search_params(query: str, locale: str) -> dict[str, str]:
    return {
        "ie": "utf-8",
        "f": "8",
        "rsv_bp": "1",
        "rsv_idx": "1",
        "ch": "",
        "tn": "baidu",
        "bar": "",
        "wd": query,
        "rn": "",
        "fenlei": "256",
        "oq": "",
        "rqlang": "cn" if locale == "zh-CN" else "en",
        "rsv_enter": "1",
        "rsv_dl": "ib",
    }


def _extract_bing_results(html_text: str) -> list[_SearchResult]:
    soup = BeautifulSoup(html_text, "html.parser")
    results: list[_SearchResult] = []
    for block in soup.select("li.b_algo"):
        link = block.select_one("h2 a[href]")
        if not isinstance(link, Tag):
            continue

        raw_url = str(link.get("href", ""))
        url = _resolve_bing_url(raw_url)
        if not url:
            continue

        title = _node_text(link)
        if not title:
            continue

        results.append(
            _SearchResult(title=title, url=url, snippet=_extract_snippet(block))
        )
    return results


def _extract_duckduckgo_results(html_text: str) -> list[_SearchResult]:
    soup = BeautifulSoup(html_text, "html.parser")
    results: list[_SearchResult] = []
    for block in soup.select(".result"):
        link = block.select_one("a.result__a[href]")
        if not isinstance(link, Tag):
            continue

        raw_url = str(link.get("href", ""))
        url = _resolve_duckduckgo_url(raw_url)
        if not url:
            continue

        title = _node_text(link)
        if not title:
            continue

        snippet_node = block.select_one(".result__snippet")
        snippet = (
            _node_text(snippet_node)
            if isinstance(snippet_node, Tag)
            else None
        )
        results.append(_SearchResult(title=title, url=url, snippet=snippet))
    return results


def _extract_baidu_results(html_text: str) -> list[_SearchResult]:
    soup = BeautifulSoup(html_text, "html.parser")
    results: list[_SearchResult] = []
    for block in soup.select("#content_left > .c-container"):
        link = block.select_one("h3 a[href]")
        if not isinstance(link, Tag):
            continue

        direct_url = str(block.get("mu", ""))
        raw_url = str(link.get("href", ""))
        url = _resolve_baidu_url(direct_url) or _resolve_baidu_url(raw_url)
        if not url:
            continue

        title = _node_text(link)
        if not title:
            continue

        snippet = None
        for selector in (
            ".c-abstract",
            ".cos-line-clamp-3",
            '[class*="summary-text"]',
        ):
            snippet_node = block.select_one(selector)
            if isinstance(snippet_node, Tag):
                snippet = _node_text(snippet_node) or None
                if snippet:
                    break

        results.append(_SearchResult(title=title, url=url, snippet=snippet))
    return results


def _extract_snippet(block: Tag) -> Optional[str]:
    for selector in ("p.b_lineclamp", ".b_caption p", ".b_caption"):
        node = block.select_one(selector)
        if not isinstance(node, Tag):
            continue
        snippet = _node_text(node)
        if snippet:
            return snippet
    return None


def _node_text(node: Tag) -> str:
    return re.sub(r"\s+", " ", node.get_text("", strip=False)).strip()


def _resolve_bing_url(raw_url: str) -> Optional[str]:
    if raw_url.startswith("/") or raw_url.startswith("#"):
        return None

    parsed = urlsplit(raw_url)
    query_values = parse_qs(parsed.query)
    encoded_values = query_values.get("u")
    if encoded_values:
        decoded = _decode_bing_redirect(encoded_values[0])
        if decoded:
            return decoded

    if parsed.scheme in {"http", "https"} and not _is_bing_hostname(parsed.hostname):
        return raw_url
    return None


def _resolve_duckduckgo_url(raw_url: str) -> Optional[str]:
    parsed = urlsplit(raw_url)
    encoded_values = parse_qs(parsed.query).get("uddg")
    if encoded_values:
        target = encoded_values[0]
        if target.startswith(("http://", "https://")):
            return target

    if parsed.scheme in {"http", "https"} and not _is_duckduckgo_hostname(
        parsed.hostname
    ):
        return raw_url
    if (
        raw_url.startswith("//")
        and parsed.hostname
        and not _is_duckduckgo_hostname(parsed.hostname)
    ):
        return "https:" + raw_url
    return None


def _resolve_baidu_url(raw_url: str) -> Optional[str]:
    parsed = urlsplit(raw_url)
    if parsed.scheme in {"http", "https"} and not _is_baidu_hostname(
        parsed.hostname
    ):
        return raw_url
    if (
        raw_url.startswith("//")
        and parsed.hostname
        and not _is_baidu_hostname(parsed.hostname)
    ):
        return "https:" + raw_url
    return None


def _decode_bing_redirect(encoded: str) -> Optional[str]:
    if len(encoded) < 3:
        return None
    payload = encoded[2:] if encoded[:2] in {"a0", "a1"} else encoded
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    if decoded.startswith(("http://", "https://")):
        return decoded
    return None


def _is_bing_hostname(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    clean = hostname.lower().rstrip(".")
    return clean == "bing.com" or clean.endswith(".bing.com")


def _is_duckduckgo_hostname(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    clean = hostname.lower().rstrip(".")
    return clean == "duckduckgo.com" or clean.endswith(".duckduckgo.com")


def _is_baidu_hostname(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    clean = hostname.lower().rstrip(".")
    return clean == "baidu.com" or clean.endswith(".baidu.com")


def _format_results(query: str, results: list[_SearchResult], duration: float) -> str:
    lines = [
        f'Web search results for query: "{query}"',
        f"Duration: {duration:.2f}s",
        "",
    ]
    if results:
        lines.append("Links:")
        for result in results:
            line = f"  - [{result.title}]({result.url})"
            if result.snippet:
                line += f": {result.snippet}"
            lines.append(line)
    else:
        lines.append("No search results found.")
    lines.extend(
        [
            "",
            "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
        ]
    )
    return "\n".join(lines).strip()


web_search_tool: FunctionToolSpec = FunctionToolSpec.from_raw(web_search)

__all__ = ["web_search", "web_search_tool"]
