from __future__ import annotations

import html
import json
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from typing import Annotated, Any, Optional
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec
from bridgic.core.model.types import Message, Role
from pydantic import WithJsonSchema

from .._prompt import AGENT_NAME

MAX_URL_LENGTH = 2_000
MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024
MAX_MARKDOWN_LENGTH = 100_000
FETCH_TIMEOUT_SECONDS = 60.0
MAX_REDIRECTS = 10
CACHE_TTL_SECONDS = 15 * 60
MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024
DEBUG_OUTPUT_DIR = "amphi_web_fetch_debug"
DEBUG_OUTPUT_ENV = "AMPHI_WEB_FETCH_DEBUG"

_REDIRECT_CODES = frozenset({301, 302, 307, 308})
_BLOCK_TAGS = frozenset(
    {
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "div",
        "dl",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tr",
        "ul",
    }
)


@dataclass(frozen=True)
class _FetchedContent:
    content: str
    bytes: int
    code: int
    code_text: str
    content_type: str


@dataclass(frozen=True)
class _Redirect:
    original_url: str
    redirect_url: str
    status_code: int


class _SizedTTLCache:
    def __init__(self, max_size: int, ttl: float) -> None:
        self._max_size = max_size
        self._ttl = ttl
        self._size = 0
        self._entries: OrderedDict[str, tuple[float, int, _FetchedContent]] = (
            OrderedDict()
        )

    def get(self, key: str) -> Optional[_FetchedContent]:
        entry = self._entries.get(key)
        if entry is None:
            return None
        created_at, size, value = entry
        if time.monotonic() - created_at >= self._ttl:
            self._entries.pop(key)
            self._size -= size
            return None
        self._entries.move_to_end(key)
        return value

    def set(self, key: str, value: _FetchedContent) -> None:
        size = max(1, len(value.content.encode("utf-8")))
        previous = self._entries.pop(key, None)
        if previous is not None:
            self._size -= previous[1]
        if size > self._max_size:
            return
        self._entries[key] = (time.monotonic(), size, value)
        self._size += size
        while self._size > self._max_size:
            _, (_, removed_size, _) = self._entries.popitem(last=False)
            self._size -= removed_size

    def clear(self) -> None:
        self._entries.clear()
        self._size = 0


_URL_CACHE = _SizedTTLCache(MAX_CACHE_SIZE_BYTES, CACHE_TTL_SECONDS)


class _MarkdownParser(HTMLParser):
    """Small dependency-free HTML-to-Markdown converter for fetched pages."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0
        self._hrefs: list[Optional[str]] = []
        self._pre_depth = 0

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, Optional[str]]]
    ) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        if tag == "a":
            self._hrefs.append(dict(attrs).get("href"))
            self.parts.append("[")
        elif tag == "img":
            attributes = dict(attrs)
            alt = attributes.get("alt") or ""
            src = attributes.get("src") or ""
            if alt or src:
                self.parts.append(f"![{alt}]({src})")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code" and not self._pre_depth:
            self.parts.append("`")
        elif tag == "pre":
            self._newline(2)
            self.parts.append("```\n")
            self._pre_depth += 1
        elif tag in {"ul", "ol"}:
            self._newline(1)
        elif tag == "li":
            self._newline(1)
            self.parts.append("- ")
        elif tag in _BLOCK_TAGS:
            self._newline(2 if tag.startswith("h") or tag == "p" else 1)
            if tag.startswith("h") and len(tag) == 2 and tag[1].isdigit():
                self.parts.append("#" * int(tag[1]) + " ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            if self._ignored_depth:
                self._ignored_depth -= 1
            return
        if self._ignored_depth:
            return
        if tag == "a":
            href = self._hrefs.pop() if self._hrefs else None
            self.parts.append(f"]({href})" if href else "]")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "code" and not self._pre_depth:
            self.parts.append("`")
        elif tag == "pre":
            self._pre_depth = max(0, self._pre_depth - 1)
            self.parts.append("\n```")
            self._newline(2)
        elif tag in _BLOCK_TAGS:
            self._newline(2 if tag.startswith("h") or tag == "p" else 1)

    def handle_data(self, data: str) -> None:
        if self._ignored_depth or not data:
            return
        if self._pre_depth:
            self.parts.append(data)
            return
        collapsed = re.sub(r"\s+", " ", data)
        if collapsed.strip():
            if (
                self.parts
                and not self.parts[-1].endswith((" ", "\n", "[", "*", "`"))
                and not collapsed.startswith(" ")
            ):
                self.parts.append(" ")
            self.parts.append(collapsed)

    def markdown(self) -> str:
        text = html.unescape("".join(self.parts))
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def _newline(self, count: int) -> None:
        if not self.parts:
            return
        current = "".join(self.parts[-2:])
        missing = count - len(current) + len(current.rstrip("\n"))
        if missing > 0:
            self.parts.append("\n" * missing)


def _html_to_markdown(content: str) -> str:
    parser = _MarkdownParser()
    parser.feed(content)
    parser.close()
    return parser.markdown()


def _persist_debug_content(
    *,
    url: str,
    current_url: str,
    text: str,
    content: str,
    content_type: str,
    status_code: int,
    status_text: str,
    bytes_count: int,
) -> None:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    debug_dir = os.path.join(os.getcwd(), DEBUG_OUTPUT_DIR, timestamp)
    os.makedirs(debug_dir, exist_ok=True)

    text_path = os.path.abspath(os.path.join(debug_dir, "raw.html"))
    content_path = os.path.abspath(os.path.join(debug_dir, "content.md"))
    meta_path = os.path.abspath(os.path.join(debug_dir, "meta.json"))

    with open(text_path, "w", encoding="utf-8") as f:
        f.write(text)
    with open(content_path, "w", encoding="utf-8") as f:
        f.write(content)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "url": url,
                "current_url": current_url,
                "status_code": status_code,
                "status_text": status_text,
                "content_type": content_type,
                "bytes": bytes_count,
                "raw_html_path": text_path,
                "markdown_path": content_path,
                "meta_path": meta_path,
                "debug_dir": os.path.abspath(debug_dir),
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
        f.write("\n")

    print(f"[web_fetch] url={url} debug_meta={meta_path}")


def _debug_enabled() -> bool:
    return os.environ.get(DEBUG_OUTPUT_ENV, "").lower() in {"1", "true", "yes", "on"}


def _validate_url(url: str) -> str:
    if not url:
        raise ValueError("URL is required.")
    if len(url) > MAX_URL_LENGTH:
        raise ValueError(
            f"URL exceeds the maximum length of {MAX_URL_LENGTH} characters."
        )
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("URL must use the http or https scheme.")
    if not parsed.hostname:
        raise ValueError("URL must include a hostname.")
    if parsed.username or parsed.password:
        raise ValueError("URL must not include a username or password.")
    if "." not in parsed.hostname:
        raise ValueError(
            "URL hostname must be fully qualified (for example, example.com)."
        )
    if parsed.scheme == "http":
        parsed = parsed._replace(scheme="https")
    return urlunsplit(parsed)


def _is_permitted_redirect(original_url: str, redirect_url: str) -> bool:
    original = urlsplit(original_url)
    redirect = urlsplit(redirect_url)
    if (
        redirect.scheme != original.scheme
        or redirect.port != original.port
        or redirect.username
        or redirect.password
    ):
        return False

    def strip_www(hostname: Optional[str]) -> str:
        return (hostname or "").removeprefix("www.")

    return strip_www(original.hostname) == strip_www(redirect.hostname)


async def _get_url_markdown_content(url: str) -> _FetchedContent | _Redirect:
    cached = _URL_CACHE.get(url)
    if cached is not None:
        return cached

    current_url = _validate_url(url)
    timeout = httpx.Timeout(FETCH_TIMEOUT_SECONDS)
    headers = {
        "Accept": "text/markdown, text/html, */*",
        "User-Agent": f"{AGENT_NAME.replace(' ', '-')}-WebFetch/1.0",
    }
    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=False, headers=headers
    ) as client:
        for depth in range(MAX_REDIRECTS + 1):
            async with client.stream("GET", current_url) as response:
                if response.status_code in _REDIRECT_CODES:
                    location = response.headers.get("location")
                    if not location:
                        raise RuntimeError("Redirect missing Location header")
                    redirect_url = urljoin(current_url, location)
                    if not _is_permitted_redirect(current_url, redirect_url):
                        return _Redirect(current_url, redirect_url, response.status_code)
                    current_url = redirect_url
                    continue

                response.raise_for_status()
                content_length = response.headers.get("content-length")
                if (
                    content_length
                    and content_length.isdigit()
                    and int(content_length) > MAX_HTTP_CONTENT_LENGTH
                ):
                    raise ValueError(
                        f"Fetched content exceeds {MAX_HTTP_CONTENT_LENGTH} bytes."
                    )

                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_HTTP_CONTENT_LENGTH:
                        raise ValueError(
                            f"Fetched content exceeds {MAX_HTTP_CONTENT_LENGTH} bytes."
                        )
                    chunks.append(chunk)

                raw = b"".join(chunks)
                content_type = response.headers.get("content-type", "")
                text = raw.decode(response.encoding or "utf-8", errors="replace")
                content = (
                    _html_to_markdown(text)
                    if "text/html" in content_type.lower()
                    else text
                )
                if _debug_enabled():
                    _persist_debug_content(
                        url=url,
                        current_url=current_url,
                        text=text,
                        content=content,
                        content_type=content_type,
                        status_code=response.status_code,
                        status_text=response.reason_phrase,
                        bytes_count=len(raw),
                    )
                fetched = _FetchedContent(
                    content=content,
                    bytes=len(raw),
                    code=response.status_code,
                    code_text=response.reason_phrase,
                    content_type=content_type,
                )
                _URL_CACHE.set(url, fetched)
                return fetched

            if depth == MAX_REDIRECTS:
                break
    raise RuntimeError(f"Too many redirects (exceeded {MAX_REDIRECTS})")


_SECONDARY_MODEL_SYSTEM_PROMPT = """\
Analyze the supplied web page using only its content and provide a concise response.
Enforce a strict 125-character maximum for quotes from any source document.
Use quotation marks for exact language, paraphrase everything else, and never reproduce song lyrics.
"""


def _secondary_model_prompt(markdown_content: str, prompt: str) -> str:
    if len(markdown_content) > MAX_MARKDOWN_LENGTH:
        markdown_content = (
            markdown_content[:MAX_MARKDOWN_LENGTH]
            + "\n\n[Content truncated due to length...]"
        )
    return f"""Extraction request:
{prompt}

Web page content:
---
{markdown_content}
---
"""


def _response_text(response: Any) -> str:
    if isinstance(response, str):
        return response
    message = getattr(response, "message", None)
    blocks = getattr(message, "blocks", None) or []
    text = "".join(
        str(block.text)
        for block in blocks
        if getattr(block, "block_type", None) == "text"
        and getattr(block, "text", None)
    )
    return text or "No response from model"


async def web_fetch(
    url: Annotated[str, WithJsonSchema({"type": "string", "format": "uri"})],
    prompt: str,
) -> str:
    """Fetch a URL, convert its content to markdown, and analyze it with the model.

    IMPORTANT: This tool cannot access authenticated or private URLs. When
    authenticated access is required, use a specialized tool that supports it.

    Use this read-only tool to retrieve and analyze public web content. HTTP
    URLs are upgraded to HTTPS. Redirects are followed automatically only when
    the scheme and port stay unchanged and the hostname stays the same except
    for adding or removing ``www.``. Other redirects are not followed; the
    target URL is returned so you can call web_fetch again with that URL.
    Responses are limited to 10 MB and cached for 15 minutes.

    Args:
        url: The fully-formed public URL to fetch content from.
        prompt: The prompt describing what information to extract or analyze
            from the fetched content.

    Returns:
        The model's response after applying ``prompt`` to the fetched content,
        or instructions for following a redirect that was not followed
        automatically.
    """
    fetched = await _get_url_markdown_content(url)
    if isinstance(fetched, _Redirect):
        status_text = httpx.codes.get_reason_phrase(fetched.status_code)
        return f"""REDIRECT DETECTED: The redirect was not followed automatically.

Original URL: {fetched.original_url}
Redirect URL: {fetched.redirect_url}
Status: {fetched.status_code} {status_text}

To complete your request, use web_fetch again with these parameters:
- url: "{fetched.redirect_url}"
- prompt: "{prompt}" """

    agent = current_agent.get(None)
    if agent is None or getattr(agent, "_llm", None) is None:
        raise RuntimeError("web_fetch can only run inside an agent turn with an LLM.")

    model_prompt = _secondary_model_prompt(fetched.content, prompt)
    response = await agent._llm.achat(
        [
            Message.from_text(_SECONDARY_MODEL_SYSTEM_PROMPT, role=Role.SYSTEM),
            Message.from_text(model_prompt, role=Role.USER),
        ]
    )
    return _response_text(response)


web_fetch_tool: FunctionToolSpec = FunctionToolSpec.from_raw(web_fetch)

__all__ = ["web_fetch", "web_fetch_tool"]
