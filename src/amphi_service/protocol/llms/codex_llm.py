"""Codex (ChatGPT subscription) LLM adapter over the Responses API.

Unlike OpenAI's public API, a ChatGPT-subscription Codex session speaks the
**Responses API** at ``https://chatgpt.com/backend-api/codex/responses`` and is
**stream-only** (SSE). bridgic's ``OpenAILlm`` (Chat Completions) therefore can't
drive it — this adapter does, mirroring the shape of ``anthropic_llm.py`` so the
agent's protocol-dispatching ``thinking()`` loop can branch on
``self._llm.protocol == "openai-codex"`` and reach the inner ``async_client``.

The contract uses model ``gpt-5.4``, requires ``stream: true``, and sends
headers ``chatgpt-account-id`` +
``OpenAI-Beta: responses=experimental``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import httpx
from bridgic.core.model import BaseLlm
from bridgic.core.model.types import (
    ContentBlock,
    Message,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)

from ...i18n import backend_i18n
from pydantic import BaseModel, Field

from ._codex_credentials import CodexAuthError, CodexCreds
from ._image_inputs import image_data_url, image_inputs_of
from ._streaming import (
    StreamResult,
    convert_tools,
    is_incomplete_stream_error,
    is_retryable_transport_error,
    open_stream_with_retry,
    parse_tool_calls,
    stream_with_transport_retry,
)

logger = logging.getLogger(__name__)

# A credential provider re-resolves fresh Codex creds per request; ``force``
# skips the local expiry check (used on a 401). ``None`` when the client was
# built without one (tests / deserialized clients) → static baked token.
CredentialProvider = Callable[..., Optional[CodexCreds]]

# ChatGPT-subscription Codex backend. The Responses path is derived from this.
DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
# Codex model availability is PER ACCOUNT (one account exposes gpt-5.4, another
# gpt-5.5 + gpt-5.4-mini; all *-codex suffixes 400). Models are user-managed,
# exactly like every API-key channel: activation seeds this single default and
# the user edits the channel's model list in the GUI. Auto-probing the account
# was removed — it fired 7 cross-border requests inside the oauth/status call
# and routinely blew the renderer's 30s timeout on a slow/blocked network.
DEFAULT_CODEX_MODEL = "gpt-5.5"

# Static Codex model catalog — the subscription backend has NO list-models
# endpoint (that's why the removed auto-probe had to POST one request per
# candidate). So "Fetch from provider" on a Codex channel is a table read, not a
# discovery call: zero network, zero credentials, instant.
#
# Two consequences the UI has to live with, both accepted deliberately:
#   1. This list ages with the code — a new Codex model needs a release here.
#   2. Per-account availability (see above) is NOT reflected; a listed model
#      may still 400 for a given account. The failure surfaces on first chat.
CODEX_CATALOG_MODELS: List[Dict[str, str]] = [
    {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra"},
    {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol"},
    {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna"},
    {"id": "gpt-5.5", "name": "GPT-5.5"},
    {"id": "gpt-5.4", "name": "GPT-5.4"},
    {"id": "gpt-5.4-mini", "name": "GPT-5.4 Mini"},
    {"id": "gpt-5.3-codex-spark", "name": "GPT-5.3 Codex Spark"},
]

_DEFAULT_TIMEOUT = 600.0
# In httpx the read timeout is the max wait BETWEEN two reads — semantically the
# same as the official codex-rs stream_idle_timeout
# (DEFAULT_STREAM_IDLE_TIMEOUT_MS=300_000). With the reasoning summary acting as a
# keepalive, a normal thinking phase never stays silent for 5 minutes; a stream that
# genuinely died silently gets cut by the client within 5 minutes → ReadTimeout
# (retryable) → reconnect, instead of idling for 10 minutes.
_READ_IDLE_TIMEOUT = 300.0
# Connection setup must FAIL FAST — when the link is down, don't sit through the whole
# read timeout (600s); raise quickly so a retry/switch is triggered.
_CONNECT_TIMEOUT = 30.0
# Stream-disconnect reconnect count aligned with the official codex-rs
# (model-provider-info DEFAULT_STREAM_MAX_RETRIES=5). Applies to the Codex path only;
# other providers keep the _streaming.TRANSPORT_MAX_RETRIES default.
_STREAM_MAX_RETRIES = 5
# httpx defaults to keepalive_expiry=5s while the Codex backend replies with
# ``Keep-Alive: timeout=5`` — the two boundaries coincide, so reusing an idle
# connection that just expired is very likely to be reset by the peer (surfacing as an
# incomplete chunked read). Long, sparse Codex requests don't depend on connection
# reuse anyway, so skip keepalive altogether: open a new connection every time — one
# handshake amortized over a multi-minute stream is negligible, yet it eradicates this
# whole class of "reused half-dead connection" stream breakage.
_NO_KEEPALIVE_LIMITS = httpx.Limits(max_keepalive_connections=0)


def _build_timeout() -> httpx.Timeout:
    """Read timeout IS the idle timeout (300s, aligned with the official client);
    the connect timeout is kept short (fail fast when the link is down)."""
    return httpx.Timeout(
        _DEFAULT_TIMEOUT, connect=_CONNECT_TIMEOUT, read=_READ_IDLE_TIMEOUT,
    )


def _build_sync_client(
    headers: Dict[str, str], transport: Optional[httpx.BaseTransport] = None
) -> httpx.Client:
    # http2=False: force HTTP/1.1. On a jittery/cross-border link, HTTP/2 multiplexing
    # means one broken underlying connection drags down every stream riding on it; a
    # single long SSE is more stable over HTTP/1.1 and is also forwarded correctly by
    # intermediaries more readily.
    # When a ``transport`` is injected (MockTransport), limits/http2 are taken over by
    # that transport — they have no effect, and raise no error either.
    return httpx.Client(
        headers=headers, timeout=_build_timeout(), limits=_NO_KEEPALIVE_LIMITS,
        http2=False, transport=transport,
    )


def _build_async_client(
    headers: Dict[str, str], transport: Optional[httpx.AsyncBaseTransport] = None
) -> httpx.AsyncClient:
    """Async twin of :func:`_build_sync_client` — same timeout / no-keepalive / HTTP-1.1 policy."""
    return httpx.AsyncClient(
        headers=headers, timeout=_build_timeout(), limits=_NO_KEEPALIVE_LIMITS,
        http2=False, transport=transport,
    )


class CodexConfiguration(BaseModel):
    """Per-request defaults for a :class:`CodexResponsesLlm` instance."""

    model: str = Field(default=DEFAULT_CODEX_MODEL, description="Codex model id.")
    temperature: float = Field(default=0.0)


def resolve_responses_url(base_url: str) -> str:
    """Normalise any Codex base url to its ``/codex/responses`` endpoint.

    Mirrors pi-ai's ``resolveCodexUrl`` so callers can pin a custom base
    (proxy/self-host) and still hit the right path.
    """
    norm = (base_url or DEFAULT_CODEX_BASE_URL).strip().rstrip("/")
    if norm.endswith("/codex/responses"):
        return norm
    if norm.endswith("/codex"):
        return f"{norm}/responses"
    return f"{norm}/codex/responses"


def parse_sse_event(line: str) -> Optional[Dict[str, Any]]:
    """Parse one SSE ``data:`` line into an event dict, else ``None``.

    Shared with the agent's ``_stream_codex`` loop. Non-data lines
    (``event:``, blank, ``[DONE]``) and malformed JSON yield ``None``.
    """
    if not line.startswith("data:"):
        return None
    payload = line[len("data:") :].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        event = json.loads(payload)
    except (ValueError, TypeError):
        return None
    return event if isinstance(event, dict) else None


class CodexResponsesLlm(BaseLlm):
    """Codex Responses-API client matching the bridgic ``BaseLlm`` surface.

    Exposes ``async_client`` / ``client`` (httpx) and ``protocol`` so the
    agent's ``thinking()`` loop drives the native SSE stream + tool calls that
    the abstract ``BaseLlm`` surface doesn't cover. The abstract methods below
    are a minimal text-in/text-out path used by connection probes.
    """

    # Consumed by ``MainThink.thinking`` to dispatch to ``_stream_codex``.
    protocol: str = "openai-codex"

    def __init__(
        self,
        *,
        access_token: str,
        account_id: Optional[str],
        configuration: Optional[CodexConfiguration] = None,
        api_base: Optional[str] = None,
        originator: str = "codex_cli_rs",
        credential_provider: Optional[CredentialProvider] = None,
        transport: Optional[httpx.BaseTransport] = None,
        async_transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.access_token = access_token
        self.account_id = account_id or ""
        # When set, each request re-resolves a fresh (auto-refreshing) token so a
        # long-lived cached client never sends an expired one. See §401-retry below.
        self._credential_provider = credential_provider
        self.api_base = (api_base or "").strip() or DEFAULT_CODEX_BASE_URL
        self.originator = originator
        self.configuration = configuration or CodexConfiguration()
        self.responses_url = resolve_responses_url(self.api_base)
        headers = self._default_headers()
        # ``transport`` injection keeps the adapter unit-testable (MockTransport).
        self.client = _build_sync_client(headers, transport)
        self.async_client = _build_async_client(headers, async_transport)

    def _default_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token}",
            "chatgpt-account-id": self.account_id,
            "originator": self.originator,
            "OpenAI-Beta": "responses=experimental",
        }

    # ------------------------------------------------------------------
    # Per-request credential freshness + 401 retry
    # ------------------------------------------------------------------

    def _apply_creds(self, creds: Optional[CodexCreds]) -> None:
        """Adopt freshly-resolved credentials, or fail with a relogin hint.

        ``creds is None`` means the local ``~/.codex`` login vanished mid-session
        — surface it as a relogin-required error rather than sending an empty
        token that would 401 confusingly.
        """
        if creds is None:
            raise CodexAuthError(
                backend_i18n.text("codex.login_missing"),
                code="codex_login_missing",
                relogin_required=True,
            )
        self.access_token = creds.access_token
        self.account_id = creds.account_id or ""

    def _request_headers(self) -> Dict[str, str]:
        """Per-request headers carrying the CURRENT token — override the client's
        baked ``Authorization``/``chatgpt-account-id`` so a refreshed token is
        used without rebuilding the httpx client (which owns originator + beta)."""
        return {
            "accept": "text/event-stream",
            "Authorization": f"Bearer {self.access_token}",
            "chatgpt-account-id": self.account_id,
        }

    def _sync_headers(self, *, force: bool) -> Dict[str, str]:
        """Resolve fresh creds (if a provider is wired) and return request headers."""
        if self._credential_provider is not None:
            self._apply_creds(self._credential_provider(force=force))
        return self._request_headers()

    async def _async_headers(self, *, force: bool) -> Dict[str, str]:
        """Async twin of :meth:`_sync_headers`. The provider is sync and may do a
        network refresh, so run it off the event loop."""
        if self._credential_provider is not None:
            self._apply_creds(await asyncio.to_thread(self._credential_provider, force=force))
        return self._request_headers()

    def _can_retry_401(self, exc: httpx.HTTPStatusError, attempt: int) -> bool:
        """A first-attempt 401 is retryable ONLY when a provider can force-refresh
        the token; a persistent 401 (or no provider) propagates."""
        return (
            attempt == 0
            and exc.response.status_code == 401
            and self._credential_provider is not None
        )

    # ------------------------------------------------------------------
    # Connectivity diagnostic logging
    # ------------------------------------------------------------------
    #
    # The Codex endpoint always targets ``chatgpt.com`` — on a restricted /
    # cross-border network that host is frequently blocked or times out, while
    # API-Key channels on the same machine (DeepSeek and other domestic hosts) keep
    # working. That is the classic root cause of "Codex can't connect, switching to
    # DeepSeek works". Whenever a connection/transport error appears on the request
    # path, log one explicit diagnostic line so nobody has to guess layer by layer; it
    # fires only for connection-class errors, never misfires on 4xx/5xx business
    # errors, and never logs the token.

    def _log_request_start(self, attempt: int) -> None:
        """Log one debug line with the target endpoint before opening the stream, to
        confirm the Codex request really lands on /codex/responses."""
        logger.debug(
            "codex request endpoint=%s model=%s account=%s creds_provider=%s attempt=%d",
            self.responses_url,
            self.configuration.model,
            _mask_account(self.account_id),
            self._credential_provider is not None,
            attempt,
        )

    def _log_transport_failure(self, exc: BaseException) -> None:
        """Connection/transport errors (cannot connect, timeout, connection reset,
        stream aborted mid-flight) → log one connectivity diagnostic line.

        "Is this a connection-class error?" is decided by the shared
        :func:`is_retryable_transport_error`, the same source as the streaming retry
        path, so 4xx/5xx business errors (which carry an HTTP status code) never
        trigger this diagnostic by mistake.
        """
        if is_retryable_transport_error(exc):
            logger.warning("%s", _describe_connectivity_error(exc, self.responses_url))

    def _stream_responses(self, body: Dict[str, Any], consume: Callable[[httpx.Response], Any]) -> Any:
        """POST ``body`` and let ``consume`` read the SSE response, refreshing the
        token first; on a 401 force-refresh once and retry."""
        for attempt in range(2):
            headers = self._sync_headers(force=attempt == 1)
            self._log_request_start(attempt)
            try:
                with self.client.stream("POST", self.responses_url, json=body, headers=headers) as resp:
                    resp.raise_for_status()
                    return consume(resp)
            except httpx.HTTPStatusError as exc:
                if not self._can_retry_401(exc, attempt):
                    raise
            except Exception as exc:  # noqa: BLE001 — log connectivity diagnostics, then propagate
                self._log_transport_failure(exc)
                raise
        raise AssertionError("unreachable: retry loop exhausted")  # pragma: no cover

    async def _astream_responses(
        self,
        body: Dict[str, Any],
        consume: Callable[[httpx.Response], Awaitable[Any]],
        publish: Optional[Callable[..., None]] = None,
    ) -> Any:
        """Async twin of :meth:`_stream_responses`.

        Two layered retry policies: the outer loop force-refreshes the token once
        on a 401; opening the stream runs through :func:`open_stream_with_retry` so
        a 429 / transient 5xx is backed off and retried BEFORE any event is consumed
        (clean — no partial stream state). A 401 raised while opening isn't
        retryable there, so it propagates to this outer force-refresh loop.
        """
        for attempt in range(2):
            headers = await self._async_headers(force=attempt == 1)
            self._log_request_start(attempt)

            async def _open() -> Any:
                # Raw httpx has no built-in status retry; open + status-check inside
                # the factory so ``open_stream_with_retry`` sees the status error.
                cm = self.async_client.stream(
                    "POST", self.responses_url, json=body, headers=headers,
                )
                response = await cm.__aenter__()
                try:
                    response.raise_for_status()
                except Exception:
                    await response.aread()  # drain so the error carries status/body
                    await cm.__aexit__(None, None, None)
                    raise
                return cm, response

            try:
                cm, response = await open_stream_with_retry(
                    _open, model=self.configuration.model, publish=publish,
                )
                try:
                    return await consume(response)
                finally:
                    await cm.__aexit__(None, None, None)
            except httpx.HTTPStatusError as exc:
                if not self._can_retry_401(exc, attempt):
                    raise
            except Exception as exc:  # noqa: BLE001 — log connectivity diagnostics, then propagate
                self._log_transport_failure(exc)
                raise
        raise AssertionError("unreachable: retry loop exhausted")  # pragma: no cover

    # ------------------------------------------------------------------
    # Message ↔ Responses API shape conversion
    # ------------------------------------------------------------------

    def _convert_messages(
        self, messages: List[Message]
    ) -> Tuple[Optional[str], List[Dict[str, Any]]]:
        """Split bridgic messages into (instructions, Responses input items).

        SYSTEM text becomes the top-level ``instructions``. Other messages map
        to Responses ``input`` items: user/assistant text → ``message`` items
        with ``input_text`` / ``output_text`` parts; tool calls → ``function_call``;
        tool results → ``function_call_output``.
        """
        instruction_parts: List[str] = []
        items: List[Dict[str, Any]] = []
        for msg in messages:
            if msg.role == Role.SYSTEM:
                instruction_parts.append(_text_of(msg))
                continue
            if msg.role == Role.AI:
                # Reasoning items first — the Responses API requires the original
                # output order (reasoning → message → function_call). Each reasoning
                # item must be immediately FOLLOWED by the message/function_call it
                # preceded; reordering (e.g. a message before its reasoning) triggers
                # a 400 "message ... without its required 'reasoning' item".
                for ri in (msg.extras or {}).get("reasoning_items") or []:
                    items.append(ri)
            images = image_inputs_of(msg)
            if msg.role == Role.USER and images:
                content = [
                    {"type": "input_text", "text": block.text}
                    for block in msg.blocks
                    if isinstance(block, TextBlock) and block.text
                ]
                content.extend({
                    "type": "input_image",
                    "image_url": image_data_url(image),
                } for image in images)
                items.append({"type": "message", "role": "user", "content": content})
                continue
            for block in msg.blocks:
                item = _block_to_input_item(block, msg.role)
                if item is not None:
                    items.append(item)
        instructions = "\n\n".join(p for p in instruction_parts if p) or None
        return instructions, items

    def _build_parameters(
        self,
        messages: List[Message],
        *,
        tools: Optional[List[Dict[str, Any]]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        stream: bool = True,
    ) -> Dict[str, Any]:
        """Assemble the Responses request body. Codex is stream-only."""
        instructions, input_items = self._convert_messages(messages)
        cfg = self.configuration
        body: Dict[str, Any] = {
            "model": cfg.model,
            "store": False,
            "stream": stream,
            "instructions": instructions or "",
            "input": input_items,
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        }
        # NOTE: gpt-5.4 (a reasoning model) rejects ``temperature`` on the Codex
        # Responses endpoint ("Unsupported parameter: temperature"). Phase 0
        # verified the working body omits it — so ``CodexConfiguration.temperature``
        # is kept for API symmetry but deliberately not sent.
        if tools:
            body["tools"] = tools
        if extra_body:
            body.update(extra_body)
        return body

    # ------------------------------------------------------------------
    # BaseLlm abstract methods — minimal text-in/text-out for probes.
    # ------------------------------------------------------------------

    def chat(self, messages: List[Message], **kwargs: Any) -> str:  # noqa: D401
        body = self._build_parameters(messages)
        return self._stream_responses(
            body, lambda resp: "".join(_iter_text_deltas(resp.iter_lines())),
        )

    def stream(self, messages: List[Message], **kwargs: Any) -> str:  # noqa: D401
        return self.chat(messages, **kwargs)

    async def achat(self, messages: List[Message], **kwargs: Any) -> str:  # noqa: D401
        body = self._build_parameters(messages)

        async def consume(resp: httpx.Response) -> str:
            parts: List[str] = []
            async for line in resp.aiter_lines():
                event = parse_sse_event(line)
                if event and event.get("type") == "response.output_text.delta":
                    parts.append(event.get("delta", ""))
            return "".join(parts)

        return await self._astream_responses(body, consume)

    async def astream(self, messages: List[Message], **kwargs: Any) -> str:  # noqa: D401
        return await self.achat(messages, **kwargs)

    async def agenerate_image(self, prompt: str) -> str:
        """Generate one image through the Responses hosted image tool.

        The Codex subscription endpoint is stream-only, so consume the full SSE
        response and return the final base64 payload from its
        ``image_generation_call`` output item.
        """
        body = self._build_parameters(
            [Message.from_text(prompt, role=Role.USER)],
            tools=[{"type": "image_generation", "action": "generate"}],
        )

        async def consume(response: httpx.Response) -> str:
            image_result = ""
            failure = ""

            def capture_item(item: Any) -> None:
                nonlocal image_result
                if not isinstance(item, dict) or item.get("type") != "image_generation_call":
                    return
                result = item.get("result")
                if isinstance(result, str) and result:
                    image_result = result

            async for line in response.aiter_lines():
                event = parse_sse_event(line)
                if event is None:
                    continue
                etype = event.get("type")
                if etype == "response.output_item.done":
                    capture_item(event.get("item"))
                elif etype == "response.completed":
                    output = (event.get("response") or {}).get("output")
                    if isinstance(output, list):
                        for item in output:
                            capture_item(item)
                elif etype in {"response.failed", "error"}:
                    error = event.get("error") or (event.get("response") or {}).get("error")
                    if isinstance(error, dict):
                        failure = str(error.get("message") or error.get("code") or "")
                    elif error:
                        failure = str(error)

            if not image_result:
                suffix = f": {failure[:500]}" if failure else ""
                raise RuntimeError(f"Codex returned no generated image{suffix}")
            return image_result

        return await self._astream_responses(body, consume)

    # ------------------------------------------------------------------
    # Agent streaming turn — full SSE loop with tool calls + usage
    # ------------------------------------------------------------------

    @staticmethod
    def _reduce_event(event: Dict[str, Any], state: Dict[str, Any], publish: Any) -> None:
        """Fold one Responses SSE event into ``state`` and push live deltas.

        ``state`` carries ``content`` (text fragments), ``tool_items`` (id→buffer),
        ``order`` (tool-call emission order), and ``usage``. ``publish(channel,
        **kw)`` streams ``token`` / ``reasoning`` deltas. Pure + synchronous so the
        whole event grammar is unit-testable without a live HTTP stream.
        """
        etype = event.get("type", "")
        if etype == "response.output_text.delta":
            delta = event.get("delta", "") or ""
            if delta:
                state["content"].append(delta)
                publish("token", text=delta)
        elif etype in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
            delta = event.get("delta", "") or ""
            if delta:
                publish("reasoning", text=delta)
        elif etype == "response.output_item.added":
            item = event.get("item", {}) or {}
            if item.get("type") == "function_call":
                iid = item.get("id", "")
                state["tool_items"][iid] = {
                    "call_id": item.get("call_id", ""),
                    "name": item.get("name", ""),
                    "arguments": item.get("arguments", "") or "",
                }
                state["order"].append(iid)
        elif etype == "response.function_call_arguments.delta":
            iid = event.get("item_id", "")
            buf = state["tool_items"].get(iid)
            if buf is not None:
                buf["arguments"] += event.get("delta", "") or ""
        elif etype == "response.output_item.done":
            item = event.get("item", {}) or {}
            if item.get("type") == "reasoning":
                state["reasoning_items"].append(item)
            elif item.get("type") == "function_call":
                iid = item.get("id", "")
                buf = state["tool_items"].get(iid)
                if buf is not None:
                    # The done event carries the authoritative final fields.
                    if item.get("arguments"):
                        buf["arguments"] = item["arguments"]
                    if item.get("name"):
                        buf["name"] = item["name"]
                    if item.get("call_id"):
                        buf["call_id"] = item["call_id"]
        elif etype == "response.completed":
            state["usage"] = (event.get("response", {}) or {}).get("usage")

    async def stream_turn(
        self,
        messages: List[Message],
        tools: Optional[List[Any]],
        *,
        publish: Callable[..., None],
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> StreamResult:
        """Stream a Codex Responses turn; push token / reasoning; return StreamResult.

        Codex speaks the Responses API over SSE (stream-only). Text arrives as
        ``response.output_text.delta``; tool calls as ``function_call`` items
        whose arguments stream via ``response.function_call_arguments.delta`` and
        finalize at ``response.output_item.done``; reasoning summaries via
        ``response.reasoning_summary_text.delta``. Event handling is delegated to
        the pure :meth:`_reduce_event` so it can be unit-tested directly.
        """
        body = self._build_parameters(
            messages, tools=convert_tools(tools, "responses") if tools else None,
            extra_body=extra_body,
        )
        # Thinking-phase keepalive: request a reasoning summary so the long thinking
        # stage keeps producing SSE delta traffic. Intermediaries (proxies/gateways)
        # commonly cap the idle time of a silent long-lived connection, and gpt-5.x's
        # multi-minute silent thinking hits exactly that cutoff (peer closed connection
        # / incomplete chunked read). The official codex-rs build_reasoning requests the
        # summary by default; it is also what makes _reduce_event's
        # reasoning_summary_text.delta handling and the UI reasoning channel actually
        # light up.
        # setdefault: when extra_body specifies reasoning explicitly, the caller wins.
        body.setdefault("reasoning", {"summary": "auto"})

        async def run_attempt(attempt_publish: Callable[..., None]) -> StreamResult:
            async def consume(response: httpx.Response) -> Dict[str, Any]:
                attempt_state: Dict[str, Any] = {
                    "content": [], "tool_items": {}, "order": [], "usage": None,
                    "reasoning_items": [],
                }
                async for line in response.aiter_lines():
                    event = parse_sse_event(line)
                    if event is not None:
                        self._reduce_event(event, attempt_state, attempt_publish)
                return attempt_state

            state = await self._astream_responses(body, consume, attempt_publish)
            capture = {"reasoning_items": state["reasoning_items"]} if state["reasoning_items"] else {}
            return StreamResult(
                tool_calls=parse_tool_calls(
                    state["tool_items"][iid]
                    for iid in state["order"]
                    if iid in state["tool_items"]
                ),
                content="".join(state["content"]),
                usage=state["usage"],
                capture=capture,
            )

        try:
            return await stream_with_transport_retry(
                run_attempt, publish, retries=_STREAM_MAX_RETRIES,
            )
        except httpx.HTTPStatusError as exc:
            # A few accounts/models don't support the reasoning parameter (Codex model
            # availability varies per account, see the CODEX_CATALOG_MODELS comment) →
            # strip it and retry once, rather than failing the whole turn.
            if "reasoning" not in body or not _is_unsupported_reasoning_400(exc):
                raise
            logger.warning("codex reasoning parameter rejected (400), retrying without it")
            body.pop("reasoning", None)
            return await stream_with_transport_retry(
                run_attempt, publish, retries=_STREAM_MAX_RETRIES,
            )

    # ------------------------------------------------------------------
    # Serializable contract (rebuild clients on load, never round-trip them)
    # ------------------------------------------------------------------

    def dump_to_dict(self) -> Dict[str, Any]:
        return {
            "access_token": self.access_token,
            "account_id": self.account_id,
            "api_base": self.api_base,
            "originator": self.originator,
            "configuration": self.configuration.model_dump(),
        }

    def load_from_dict(self, state_dict: Dict[str, Any]) -> None:
        self.access_token = state_dict["access_token"]
        self.account_id = state_dict.get("account_id", "")
        self.api_base = state_dict.get("api_base") or DEFAULT_CODEX_BASE_URL
        self.originator = state_dict.get("originator", "codex_cli_rs")
        self.configuration = CodexConfiguration(**state_dict.get("configuration", {}))
        self.responses_url = resolve_responses_url(self.api_base)
        headers = self._default_headers()
        self.client = _build_sync_client(headers)
        self.async_client = _build_async_client(headers)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _mask_account(account_id: str) -> str:
    """Mask the account id for logging: keep the first 4 characters for reconciliation,
    redact the rest; log ``<empty>`` when it is empty."""
    if not account_id:
        return "<empty>"
    return account_id[:4] + "…" if len(account_id) > 4 else account_id


def _is_unsupported_reasoning_400(exc: httpx.HTTPStatusError) -> bool:
    """A 400 whose body says the reasoning parameter is unsupported → self-healable by
    stripping the parameter and retrying."""
    if exc.response.status_code != 400:
        return False
    text = exc.response.text.lower()
    return "reasoning" in text and ("unsupported" in text or "unknown" in text)


def _fmt_exc(exc: BaseException) -> str:
    """One-line an exception: type + text, plus the wrapped direct root cause (e.g.
    RuntimeError←ConnectError)."""
    text = f"{type(exc).__name__}: {exc}"
    cause = exc.__cause__ or exc.__context__
    if cause is not None and cause is not exc:
        text += f" (caused by {type(cause).__name__}: {cause})"
    return text


def _describe_connectivity_error(exc: BaseException, url: str) -> str:
    """Compose one actionable diagnostic line for a Codex connection/transport failure
    (never contains the token).

    It distinguishes two typical shapes and points at different things to check:

    * **Stream cut off mid-flight** (``RemoteProtocolError: incomplete chunked read`` /
      read timeout) — the connection was established and data had started flowing, but
      a long response was severed partway. Cross-border links / proxy gateways commonly
      impose an idle or total-duration cap on long-lived connections (SSE), and
      long-running Codex turns (generating a PPT, that sort of thing) trigger it most
      easily; this is exactly the root cause of the ``peer closed connection without
      sending complete message body`` in the screenshot.
    * **Cannot connect / handshake failure / connection timeout** — the request never
      arrived, or was never established. On a cross-border/restricted network the
      ``chatgpt.com`` host may be blocked or time out, while API-Key channels on the
      same machine (DeepSeek and other domestic hosts) are unaffected.
    """
    host = urlsplit(url).netloc or url
    head = f"codex connectivity failure host={host} endpoint={url} :: {_fmt_exc(exc)}"
    if is_incomplete_stream_error(exc):
        return backend_i18n.text("codex.connectivity_stream_interrupted", details=head)
    return backend_i18n.text("codex.connectivity_unreachable", details=head, host=host)


def _text_of(message: Message) -> str:
    return "".join(b.text for b in message.blocks if isinstance(b, TextBlock))


def _block_to_input_item(block: ContentBlock, role: Role) -> Optional[Dict[str, Any]]:
    """Map one bridgic content block → a Responses ``input`` item."""
    if isinstance(block, ToolCallBlock):
        args = block.arguments
        if not isinstance(args, str):
            args = json.dumps(args or {})
        return {
            "type": "function_call",
            "call_id": block.id or "",
            "name": block.name,
            "arguments": args,
        }
    if isinstance(block, ToolResultBlock):
        content = block.content if isinstance(block.content, str) else str(block.content)
        return {
            "type": "function_call_output",
            "call_id": block.id or "",
            "output": content,
        }
    if isinstance(block, TextBlock):
        if role == Role.AI:
            return {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": block.text}],
            }
        return {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": block.text}],
        }
    return None


def _iter_text_deltas(lines: Any) -> Any:
    """Yield ``output_text.delta`` text fragments from a sync line iterator."""
    for line in lines:
        event = parse_sse_event(line)
        if event and event.get("type") == "response.output_text.delta":
            yield event.get("delta", "")


__all__ = [
    "CodexConfiguration",
    "CodexResponsesLlm",
    "CODEX_CATALOG_MODELS",
    "DEFAULT_CODEX_BASE_URL",
    "DEFAULT_CODEX_MODEL",
    "resolve_responses_url",
    "parse_sse_event",
]
