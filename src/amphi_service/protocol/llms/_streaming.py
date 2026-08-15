"""Shared streaming contract — StreamResult plus pure helper functions.

Module-level streaming helpers shared by every LLM adapter (accumulating and parsing
tool-call fragments, merging reasoning_details, converting tool shapes, open-stream
retries and error classification), with no dependency on the class hierarchy in
``_cognitive.py``. These functions once duplicated static methods on ``MainThink``;
they have since been consolidated here as the single implementation.
"""

import asyncio
import errno
import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional

import httpx

from ...i18n import backend_i18n

__all__ = [
    "RATE_LIMIT_MAX_RETRIES",
    "ModelNotFoundError",
    "StreamResult",
    "accumulate_reasoning_details",
    "accumulate_tool_deltas",
    "convert_tools",
    "is_daily_quota_error",
    "is_incomplete_stream_error",
    "is_retryable_transport_error",
    "is_model_not_found_error",
    "is_rate_limit_error",
    "is_retryable_stream_error",
    "is_transient_server_error",
    "model_not_found_message",
    "open_stream_with_retry",
    "parse_tool_calls",
    "rate_limit_delay",
    "stream_with_transport_retry",
]

TRANSPORT_MAX_RETRIES = 2

_RETRYABLE_HTTPX_TRANSPORT_ERRORS = (
    httpx.CloseError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
    httpx.ProxyError,
    httpx.ReadError,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
    httpx.WriteError,
    httpx.WriteTimeout,
)

_RETRYABLE_OS_ERRNOS = {
    errno.ECONNABORTED,
    errno.ECONNREFUSED,
    errno.ECONNRESET,
    errno.EHOSTUNREACH,
    errno.ENETDOWN,
    errno.ENETRESET,
    errno.ENETUNREACH,
    errno.EPIPE,
    errno.ETIMEDOUT,
}

_RETRYABLE_TRANSPORT_TYPE_NAMES = {
    "APIConnectionError",
    "APITimeoutError",
    "BrokenResourceError",
    "ClientConnectionError",
    "ClientConnectorError",
    "ClientOSError",
    "ClosedResourceError",
    "ConnectionClosed",
    "ConnectionClosedError",
    "ConnectError",
    "ConnectTimeout",
    "EndOfStream",
    "ReadError",
    "ReadTimeout",
    "RemoteProtocolError",
    "ServerConnectionError",
    "ServerDisconnectedError",
    "ServerTimeoutError",
    "WriteError",
    "WriteTimeout",
}

_RETRYABLE_TRANSPORT_MARKERS = (
    "broken pipe",
    "connection aborted",
    "connection closed",
    "connection refused",
    "connection reset",
    "connection timed out",
    "incomplete chunked read",
    "network is down",
    "network is unreachable",
    "peer closed connection",
    "server disconnected",
    "temporary failure in name resolution",
)


@dataclass(frozen=True)
class StreamResult:
    """The final result of one streaming LLM call."""

    tool_calls: List[Dict[str, Any]]
    content: str
    usage: Any = None
    capture: Dict[str, Any] = field(default_factory=dict)


def accumulate_tool_deltas(buffers: Dict[int, Dict[str, str]], tool_call_deltas: Any) -> None:
    """Merge an OpenAI chunk's tool-call deltas into per-index buffers.

    A streamed tool call arrives in fragments across many chunks; each
    fragment carries an ``index`` so the name and argument fragments
    accumulate onto the right call.
    """
    for delta in tool_call_deltas:
        buffer = buffers.setdefault(delta.index, {"name": "", "arguments": ""})
        for attr in ("call_id", "id", "tool_call_id"):
            value = getattr(delta, attr, None)
            if value:
                buffer["call_id"] = str(value)
                break
        function = getattr(delta, "function", None)
        if function is None:
            continue
        if function.name:
            buffer["name"] = function.name
        if function.arguments:
            buffer["arguments"] += function.arguments


def accumulate_reasoning_details(buffers: Dict[int, Dict[str, Any]], fragments: Any) -> None:
    """Merge OpenRouter ``delta.reasoning_details`` fragments into per-index buffers.

    OpenRouter's unified reasoning API streams structured reasoning as an array of
    fragments; each carries an ``index`` grouping it to one reasoning block. The
    incremental string fields (``text`` / ``data`` / ``summary``) accumulate across
    chunks, while the stable / last-wins fields (``type`` / ``format`` /
    ``signature`` / ``id``) are kept as they arrive. Preserving the block verbatim —
    the ``signature`` included — is what lets a signature-class routed model
    (Claude / Gemini) continue its reasoning across a tool-call turn without a 400
    (gpt-oss and other unsigned models stream no signature and are unaffected).
    """
    for fragment in fragments or []:
        if not isinstance(fragment, dict):
            continue
        block = buffers.setdefault(fragment.get("index", 0), {})
        for key, value in fragment.items():
            if key in ("text", "data", "summary") and isinstance(value, str):
                block[key] = block.get(key, "") + value
            elif value is not None:
                block[key] = value


def parse_tool_calls(buffers: Iterable[Dict[str, str]]) -> List[Dict[str, Any]]:
    """Ordered ``{"name", "arguments"}`` buffers → ``{"name", "arguments"}``
    wire dicts: skip a no-name buffer, JSON-parse the arguments string
    (malformed / non-dict → ``{}``). Shared by the OpenAI (index-sorted) and
    Codex (emission-ordered) paths — the caller supplies the order.
    """
    calls: List[Dict[str, Any]] = []
    for buffer in buffers:
        if not buffer.get("name"):
            continue
        try:
            arguments = json.loads(buffer.get("arguments") or "{}")
        except (json.JSONDecodeError, TypeError):
            arguments = {}
        if not isinstance(arguments, dict):
            arguments = {}
        call = {"name": buffer["name"], "arguments": arguments}
        if buffer.get("call_id"):
            call["call_id"] = buffer["call_id"]
        calls.append(call)
    return calls


def convert_tools(tools: List[Any], target: str) -> List[Dict[str, Any]]:
    """Tool defs → the active provider's tool shape — ``target`` is
    ``"anthropic"`` (``{name, description, input_schema}``) or ``"responses"``
    (Codex's flat ``{type, name, description, parameters, strict}``).

    Reads (name, description, params) from a bridgic ``Tool`` (flat
    ``.name`` / ``.parameters``) or an OpenAI ``{"function": {...}}`` envelope;
    a dict already in the target shape passes through; anything else is
    skipped (never raises). Missing the flat-``Tool`` branch would send ZERO
    tools and the model would hallucinate ``<tool_call>`` text instead.
    """
    out: List[Dict[str, Any]] = []
    for tool in tools or []:
        name = getattr(tool, "name", None)
        params = getattr(tool, "parameters", None)
        if isinstance(name, str) and name and isinstance(params, dict):
            desc = getattr(tool, "description", "") or ""
        elif isinstance(tool, dict) and isinstance(tool.get("function"), dict):
            fn = tool["function"]
            name, desc = fn.get("name", ""), fn.get("description", "")
            params = fn.get("parameters", {"type": "object", "properties": {}})
        elif isinstance(tool, dict) and (
            "input_schema" in tool if target == "anthropic"
            else tool.get("type") == "function" and "name" in tool
        ):
            out.append(tool)            # already in the target shape
            continue
        else:
            continue                    # unrecognised → skip, never raise
        if target == "anthropic":
            out.append({"name": name, "description": desc, "input_schema": params})
        elif target == "google":
            # Gemini function declaration: flat {name, description, parameters}
            # wrapped in {"function_declarations": [...]} by GoogleLlm.
            out.append({"name": name, "description": desc, "parameters": params})
        else:
            out.append({
                "type": "function", "name": name, "description": desc,
                "parameters": params, "strict": False,
            })
    return out


# ── 429 rate-limit backoff retry — shared by every adapter when opening a stream ─────
#
# Free / restricted channels (Google's free tier at 5 RPM, upstream throttling on
# OpenRouter's free models) will almost certainly hit a 429 somewhere in a multi-round
# agent turn; one failure aborts the whole turn with a RuntimeError and wastes the tool
# results of every earlier round. This gives all adapters one shared primitive for
# "hit a 429 while opening the stream → back off and retry": it respects the retryDelay
# the provider suggests (e.g. Gemini's "retryDelay: 2s") and otherwise backs off
# exponentially up to a cap. Retrying is confined to the opening phase (before the
# first chunk), where no stream state has been consumed yet.

RATE_LIMIT_MAX_RETRIES = 3
_RATE_LIMIT_BASE_DELAY = 1.0
_RATE_LIMIT_MAX_DELAY = 10.0
_RETRY_HINT_RE = re.compile(
    r"retry(?:_?delay|\s+in)?[\"']?\s*[:=]?\s*[\"']?(\d+(?:\.\d+)?)\s*s", re.I
)


def _status_of(exc: Exception) -> Optional[int]:
    """Best-effort HTTP status from an exception across SDK shapes.

    OpenAI/Anthropic SDK errors carry ``.status_code``; some carry ``.code``;
    httpx's ``HTTPStatusError`` (Codex's raw client) carries it on
    ``.response.status_code``. Returns the first ``int`` found, else ``None``.
    """
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    return value if isinstance(value, int) else None


def is_rate_limit_error(exc: Exception) -> bool:
    """True when the exception is provider throttling (HTTP 429 / Gemini
    RESOURCE_EXHAUSTED).

    Handles both SDK exceptions carrying ``status_code`` / ``code`` /
    ``response.status_code`` and the cases only distinguishable from text (OpenRouter
    wraps an upstream 429 into the message); matching is conservative so ordinary errors
    are not mistaken for throttling.
    """
    if _status_of(exc) == 429:
        return True
    text = str(exc)
    if "429" in text or "RESOURCE_EXHAUSTED" in text:
        return True
    low = text.lower()
    return "rate" in low and "limit" in low


# Transient server-side errors (capacity / overload / gateway): different from a 429,
# but the same "retrying shortly will very likely work" jitter — OpenRouter's free-tier
# 503 "No backends available", upstream 502/504 and Anthropic's 529 overloaded all fall
# here. Retrying during the opening phase (with no consumed stream state) is clean.
_TRANSIENT_STATUS = frozenset({500, 502, 503, 504, 529})
_TRANSIENT_MARKERS = (
    "no backends available",
    "capacity",
    "overloaded",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "temporarily unavailable",
)


def is_transient_server_error(exc: Exception) -> bool:
    """True when the exception is a transient server / capacity error (5xx / overload),
    which a backoff retry will very likely recover from."""
    if _status_of(exc) in _TRANSIENT_STATUS:
        return True
    low = str(exc).lower()
    return any(marker in low for marker in _TRANSIENT_MARKERS)


def is_retryable_stream_error(exc: Exception) -> bool:
    """Errors that are worth a backoff retry during the opening phase: throttling (other
    than a daily quota) or a transient server error.

    Daily quota exhaustion is failed fast by the caller instead (backoff is pointless),
    so it is excluded here.
    """
    if is_daily_quota_error(exc):
        return False
    return is_rate_limit_error(exc) or is_transient_server_error(exc)


def _exception_chain(exc: BaseException) -> Iterable[BaseException]:
    """Yield wrapped and grouped exceptions once, outermost first."""
    pending = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        yield current
        nested = getattr(current, "exceptions", ())
        if isinstance(nested, tuple):
            pending.extend(reversed([item for item in nested if isinstance(item, BaseException)]))
        if current.__context__ is not None:
            pending.append(current.__context__)
        if current.__cause__ is not None:
            pending.append(current.__cause__)


def is_incomplete_stream_error(exc: BaseException) -> bool:
    """Return whether a response body ended before its chunked stream completed."""
    for current in _exception_chain(exc):
        message = str(current).lower()
        if isinstance(current, httpx.RemoteProtocolError) and (
            "incomplete chunked read" in message
            or "without sending complete message body" in message
        ):
            return True
        if "incomplete chunked read" in message:
            return True
    return False


def is_retryable_transport_error(exc: BaseException) -> bool:
    """Return whether a model stream failed because of transient transport I/O."""
    for current in _exception_chain(exc):
        if isinstance(current, _RETRYABLE_HTTPX_TRANSPORT_ERRORS):
            return True
        if isinstance(current, TimeoutError):
            return True
        if isinstance(current, OSError) and current.errno in _RETRYABLE_OS_ERRNOS:
            return True
        if type(current).__name__ in _RETRYABLE_TRANSPORT_TYPE_NAMES:
            return True
        if _status_of(current) is not None:
            continue
        message = str(current).lower()
        if any(marker in message for marker in _RETRYABLE_TRANSPORT_MARKERS):
            return True
    return False


async def stream_with_transport_retry(
    factory: Callable[[Callable[..., None]], Awaitable[StreamResult]],
    publish: Callable[..., None],
    *,
    retries: int = TRANSPORT_MAX_RETRIES,
) -> StreamResult:
    """Run one complete model stream with bounded retry and delta rollback."""
    for attempt in range(retries + 1):
        emitted = {"token": 0, "reasoning": 0}
        retry_cleared = False

        def attempt_publish(channel: str, **payload: Any) -> None:
            nonlocal retry_cleared
            if attempt and not retry_cleared and channel in {"token", "reasoning"}:
                publish(
                    "model_retry",
                    active=False,
                    attempt=attempt,
                    max_retries=retries,
                    delay_seconds=0.0,
                )
                retry_cleared = True
            if channel in emitted:
                emitted[channel] += len(str(payload.get("text") or ""))
            publish(channel, **payload)

        try:
            result = await factory(attempt_publish)
        except Exception as exc:  # noqa: BLE001 - inspect provider-wrapped transport causes
            if not is_retryable_transport_error(exc) or attempt >= retries:
                raise
            delay = float(2 ** attempt)
            publish(
                "model_retry",
                active=True,
                attempt=attempt + 1,
                max_retries=retries,
                delay_seconds=delay,
                discard_text_chars=emitted["token"],
                discard_reasoning_chars=emitted["reasoning"],
            )
            await asyncio.sleep(delay)
            continue
        if attempt and not retry_cleared:
            publish(
                "model_retry",
                active=False,
                attempt=attempt,
                max_retries=retries,
                delay_seconds=0.0,
            )
        return result
    raise AssertionError("unreachable: transport retry loop exhausted")


# Daily quota exhaustion (Gemini's free-tier RPD, e.g.
# ``GenerateRequestsPerDayPerProjectPerModel``) is fundamentally different from
# per-minute throttling (RPM): backoff is pointless for it — the quota does not reset
# until the next day, so waiting out the suggested retryDelay (tens of seconds) merely
# delays the same failure. Once identified it should fail immediately with a clear message.
_DAILY_QUOTA_RE = re.compile(r"per[\s_]?day|requestsperday", re.I)


def is_daily_quota_error(exc: Exception) -> bool:
    """True when a 429 is *daily* quota exhaustion rather than per-minute throttling.
    Backoff retries do nothing for it."""
    return is_rate_limit_error(exc) and bool(_DAILY_QUOTA_RE.search(str(exc)))


def rate_limit_delay(exc: Exception, attempt: int) -> float:
    """Backoff in seconds: prefer the retryDelay hint in the provider text, otherwise
    exponential backoff (capped)."""
    match = _RETRY_HINT_RE.search(str(exc))
    if match:
        try:
            return min(max(float(match.group(1)), _RATE_LIMIT_BASE_DELAY), _RATE_LIMIT_MAX_DELAY)
        except ValueError:
            pass
    return min(_RATE_LIMIT_BASE_DELAY * (2 ** attempt), _RATE_LIMIT_MAX_DELAY)


# ── Model not found — translate each vendor's opaque 404 / model_not_found into a
# clear domain error ─────
#
# A model ID in the catalogue may drift from the vendor's real ID (e.g. deepseek-v4-pro
# vs deepseek-reasoner). On the first request the provider answers 404 / "model does not
# exist" / "model_not_found", and re-raising that as is produces a long SDK stack the
# user can do nothing with. This classifies it protocol-independently into one domain
# error so callers can fail fast with an actionable message.

class ModelNotFoundError(ValueError):
    """The selected model ID is invalid / does not exist (the provider returned
    model-not-found / 404)."""


# A matching code settles it; the text fallback requires both "model" and a
# not-found-style phrase, so unrelated errors are not caught by mistake.
_MODEL_NOT_FOUND_CODES = frozenset({"model_not_found", "model_not_found_error"})
_MODEL_ABSENT_MARKERS = (
    "does not exist",
    "not found",
    "unknown model",
    "invalid model",
    "no such model",
)


def is_model_not_found_error(exc: Exception) -> bool:
    """True when the exception means “the selected model does not exist” (as opposed to a
    transient, permission or parameter error)."""
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code.lower() in _MODEL_NOT_FOUND_CODES:
        return True
    low = str(exc).lower()
    if "model_not_found" in low:
        return True
    has_model = "model" in low
    if _status_of(exc) == 404 and has_model:
        return True
    return has_model and any(marker in low for marker in _MODEL_ABSENT_MARKERS)


def model_not_found_message(model: Optional[str]) -> str:
    """An actionable message for :class:`ModelNotFoundError`."""
    name = f"{model!r}" if model else backend_i18n.text("llm.selected_model")
    return backend_i18n.text(
        "llm.model_not_found",
        model_display=name,
    )


async def open_stream_with_retry(
    factory: Callable[[], Awaitable[Any]],
    *,
    retries: int = RATE_LIMIT_MAX_RETRIES,
    model: Optional[str] = None,
    publish: Optional[Callable[..., None]] = None,
) -> Any:
    """Call an async “open stream” factory, retrying with backoff on throttling or a
    transient 5xx; non-retryable errors propagate immediately.

    ``factory`` is a no-argument async callable returning the provider's stream object /
    iterator. Retrying is clean when the failure happens while opening — no stream state
    has been consumed yet. If ``publish`` is given, a ``model_retry`` status is emitted
    when the backoff starts and when the connection recovers. If ``model`` is given, a
    model-not-found 404 is translated into a clear :class:`ModelNotFoundError` (fail-fast).
    """
    for attempt in range(retries + 1):
        try:
            stream = await factory()
            if attempt and publish is not None:
                publish(
                    "model_retry",
                    active=False,
                    attempt=attempt,
                    max_retries=retries,
                    delay_seconds=0.0,
                )
            return stream
        except Exception as exc:  # noqa: BLE001 — non-retryable errors are re-raised immediately below
            # Daily quota exhausted: backoff is pointless (it resets tomorrow) → fail
            # immediately with a clear message instead of a long RuntimeError, and without
            # burning tens of seconds × N attempts first.
            if is_daily_quota_error(exc):
                raise RuntimeError(backend_i18n.text("llm.daily_quota_exhausted")) from exc
            # Throttling (not a daily quota) or a transient 5xx (capacity / overload /
            # gateway) → back off and retry.
            if is_retryable_stream_error(exc) and attempt < retries:
                delay = rate_limit_delay(exc, attempt)
                if publish is not None:
                    publish(
                        "model_retry",
                        active=True,
                        attempt=attempt + 1,
                        max_retries=retries,
                        delay_seconds=delay,
                    )
                await asyncio.sleep(delay)
                continue
            # Model not found: fail fast with an actionable message (intercepted before
            # the generic raise).
            if model and is_model_not_found_error(exc):
                raise ModelNotFoundError(model_not_found_message(model)) from exc
            raise
