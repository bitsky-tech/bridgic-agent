import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from anthropic import Anthropic, AsyncAnthropic
from bridgic.core.model import BaseLlm
from bridgic.core.model.types import (
    ContentBlock,
    Message,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from pydantic import BaseModel, Field

from ._streaming import (
    RATE_LIMIT_MAX_RETRIES,
    StreamResult,
    convert_tools,
    stream_with_transport_retry,
)

# Provider's default Messages endpoint when the user doesn't pin a base url.
_DEFAULT_API_BASE = "https://api.anthropic.com"

# Anthropic requires max_tokens on every request (unlike OpenAI which
# treats it as optional). Pick a safe ceiling so callers that pass None
# still get a sane upper bound. 8K covers Claude Sonnet 4 / Opus 4 output
# limits comfortably; specific models can push lower or higher via the
# configuration.
_DEFAULT_MAX_TOKENS = 8192

# (base_url, model) -> sampling params this endpoint has already rejected.
# Newer Anthropic models (Opus 4.7+, Sonnet 5, Fable 5, ...) 400 with
# "`temperature` is deprecated for this model."; we learn the rejection once
# and pre-strip it on every later call so probe / chat / stream all stay
# clean. Process-level, mirrors the OpenAI path's ``_REJECTED_PARAMS``.
_REJECTED_PARAMS: Dict[Tuple[str, str], set] = {}

# The only params eligible for that self-heal — everything else re-raises.
_SAMPLING_PARAMS: Tuple[str, ...] = ("temperature", "top_p", "top_k")

# Strip-and-retry ceiling — the param set is tiny, so this never loops.
_MAX_SELF_HEAL_RETRIES = 4


class AnthropicConfiguration(BaseModel):
    """Per-request defaults for an :class:`AnthropicLlm` instance.

    Mirrors the shape of ``OpenAIConfiguration`` so call sites can switch
    LLM type without rewriting the configuration wiring. ``max_tokens``
    is special on Anthropic: it's required on every request, so ``None``
    here falls back to :data:`_DEFAULT_MAX_TOKENS` at request build time
    rather than at construction.
    """

    model: str = Field(description="Model id, e.g. 'claude-sonnet-4'.")
    temperature: float = Field(default=0.0)
    max_tokens: Optional[int] = Field(default=None)


class AnthropicLlm(BaseLlm):
    """Anthropic Messages-API client matching the Bridgic ``BaseLlm`` surface.

    The class deliberately exposes the inner ``async_client`` (and
    ``client``) attributes; the agent's ``thinking()`` loop needs them
    to drive native streaming + tool calling that the abstract
    :class:`BaseLlm` surface does not cover.
    """

    # Marker consumed by the Agent streaming runtime to select the Anthropic
    # ``messages.stream(...)`` path instead of OpenAI's
    # ``chat.completions.create(stream=True)``.
    protocol: str = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        api_base: Optional[str] = None,
        configuration: Optional[AnthropicConfiguration] = None,
    ) -> None:
        # Anthropic accepts ``base_url`` (no trailing slash) — match how the
        # SDK expects it; treat empty string the same as None.
        resolved_base = (api_base or "").strip() or _DEFAULT_API_BASE
        self.api_base = resolved_base
        self.api_key = api_key
        self.configuration = configuration or AnthropicConfiguration(
            model="claude-sonnet-4"
        )
        # The Anthropic SDK retries 429 / 5xx / overloaded (529) with backoff on
        # the request that opens the stream; lift its default (2) to our standard
        # count so a mid-loop rate-limit / overload doesn't abort the turn.
        self.client = Anthropic(
            api_key=api_key, base_url=resolved_base, max_retries=RATE_LIMIT_MAX_RETRIES
        )
        self.async_client = AsyncAnthropic(
            api_key=api_key, base_url=resolved_base, max_retries=RATE_LIMIT_MAX_RETRIES
        )

    # ------------------------------------------------------------------
    # Message ↔ Anthropic API shape conversion
    # ------------------------------------------------------------------

    def _extract_system_and_messages(
        self, messages: List[Message]
    ) -> Tuple[Optional[str], List[Dict[str, Any]]]:
        """Split a bridgic message list into Anthropic's (system, messages) pair.

        Anthropic's ``messages.create`` takes ``system`` as a separate
        top-level parameter; OpenAI keeps it inside ``messages`` as a
        ``role=system`` entry. We concatenate every SYSTEM-role message's
        text into one string (Anthropic accepts only one), and translate
        the rest of the conversation into Anthropic's role + content-block
        shape.
        """
        system_parts: List[str] = []
        api_messages: List[Dict[str, Any]] = []
        for msg in messages:
            if msg.role == Role.SYSTEM:
                system_parts.append(_text_of(msg))
                continue
            role = _bridgic_role_to_anthropic(msg.role)
            content = _blocks_to_anthropic_content(msg.blocks)
            if role == "assistant":
                # Replay the turn's captured thinking blocks (carried on
                # ``extras`` by turn_messages). A thinking-mode model (e.g.
                # DeepSeek) rejects a follow-up whose tool-calling assistant turn
                # omits them; Anthropic also requires thinking before other blocks.
                content = _thinking_blocks_of(msg) + content
            # Anthropic requires strict user/assistant alternation; fold any
            # consecutive same-role messages into one (e.g. a failed turn keeps
            # the user's question with no reply → two user messages in a row).
            if api_messages and api_messages[-1]["role"] == role:
                api_messages[-1]["content"].extend(content)
            else:
                api_messages.append({"role": role, "content": content})
        # Keep every assistant message's thinking blocks first — folding above can
        # interleave them (a thought-only round folded ahead of a tool-call round).
        for m in api_messages:
            if m["role"] == "assistant":
                m["content"] = _thinking_first(m["content"])
        system = "\n\n".join(p for p in system_parts if p) or None
        return system, api_messages

    def _reject_key(self) -> Tuple[str, str]:
        """Cache key for learned param rejections: (base url, model)."""
        return (self.api_base or "", str(self.configuration.model or ""))

    def _build_parameters(
        self,
        messages: List[Message],
        *,
        tools: Optional[List[Dict[str, Any]]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        stream: bool = False,
    ) -> Dict[str, Any]:
        """Assemble kwargs for ``self.async_client.messages.create(**...)``.

        Mirrors the role ``OpenAILlm._build_parameters`` plays in the
        agent's ``thinking()`` — it converts bridgic Messages into the
        provider's wire shape so callers can drive streaming + tools
        without re-implementing the mapping every time.

        ``tools`` is a list in Anthropic's tool-definition shape::

            [{"name": "...", "description": "...", "input_schema": {...}}]

        The agent layer is responsible for converting bridgic
        ``ToolSpec`` into this shape before passing in.

        ``stream`` is reflected in the params; the actual stream context
        manager is owned by the caller (``messages.stream(**params)`` vs
        ``messages.create(**params)``).
        """
        system, api_messages = self._extract_system_and_messages(messages)
        cfg = self.configuration
        params: Dict[str, Any] = {
            "model": cfg.model,
            "messages": api_messages,
            "max_tokens": cfg.max_tokens or _DEFAULT_MAX_TOKENS,
            "temperature": cfg.temperature,
        }
        if system is not None:
            params["system"] = system
        if tools:
            params["tools"] = tools
        if stream:
            params["stream"] = True
        if extra_body:
            # Anthropic SDK accepts arbitrary extra kwargs (it forwards them
            # to the request body). Merge last so callers can override the
            # built-in defaults if they really need to.
            params.update(extra_body)
        # Drop any sampling param this endpoint already rejected (learned via
        # the self-heal below) so every path stops re-sending it. Applied last
        # so a learned rejection wins over ``extra_body`` too.
        for param in _REJECTED_PARAMS.get(self._reject_key(), ()):
            params.pop(param, None)
        return params

    # ------------------------------------------------------------------
    # BaseLlm abstract methods — minimal "text in, text out" support
    # ------------------------------------------------------------------
    #
    # These exist so AnthropicLlm satisfies the BaseLlm ABC contract and
    # can be passed wherever the framework expects a BaseLlm. The agent's
    # streaming + tools path does NOT go through these (it reaches the
    # inner client directly). Callers using these methods get a Response
    # with a single TextBlock and no tool_calls — they're for
    # simple synchronous text exchanges such as connection probes.

    def chat(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        params = self._build_parameters(messages, stream=False)
        response = self.client.messages.create(**params)
        return _anthropic_response_to_text(response)

    def stream(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        # Sync streaming is rarely used; we materialise the stream to text
        # to keep the abstract surface satisfied without bringing the full
        # event-handling complexity into this minimal path.
        with self.client.messages.stream(**self._build_parameters(messages)) as stream:
            return "".join(stream.text_stream)

    async def achat(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        params = self._build_parameters(messages, stream=False)
        response = await self._acreate(params)
        return _anthropic_response_to_text(response)

    async def _acreate(self, params: Dict[str, Any]) -> Any:
        """``messages.create`` with sampling-param self-heal.

        Newer Anthropic models reject ``temperature`` / ``top_p`` / ``top_k``
        with a 400 "deprecated for this model."; on exactly that error we strip
        the named param, remember it for the process, and retry. Bounded by
        :data:`_MAX_SELF_HEAL_RETRIES`, so it never loops. Other errors re-raise.
        """
        key = self._reject_key()
        heal = 0
        while True:
            try:
                return await self.async_client.messages.create(**params)
            except Exception as exc:  # noqa: BLE001 — non-heal errors re-raised
                param = _deprecated_param_of(exc)
                if param is not None and param in params and heal < _MAX_SELF_HEAL_RETRIES:
                    params.pop(param, None)
                    _REJECTED_PARAMS.setdefault(key, set()).add(param)
                    heal += 1
                    continue
                raise

    async def astream(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        params = self._build_parameters(messages)
        async with self.async_client.messages.stream(**params) as stream:
            collected: List[str] = []
            async for text in stream.text_stream:
                collected.append(text)
            return "".join(collected)

    async def stream_turn(
        self,
        messages: List[Message],
        tools: Optional[List[Any]],
        *,
        publish: Callable[..., None],
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> StreamResult:
        """Stream an Anthropic Messages turn; push token / reasoning; return StreamResult.

        Anthropic emits typed content-block events instead of OpenAI's
        ``choices[0].delta`` deltas: text via ``text_delta``, tool arguments as
        ``input_json_delta`` chunks joined and parsed at block stop, and
        extended-thinking via ``thinking_delta``.

        A sampling-param 400 (newer models reject ``temperature`` etc.) is raised
        when the stream opens, before any token — so we strip the named param,
        cache it, and retry from a clean slate. Mirrors the OpenAI self-heal.
        """
        params = self._build_parameters(
            messages=messages,
            tools=convert_tools(tools, "anthropic") if tools else None,
            extra_body=extra_body,
        )
        # ``messages.stream`` is a context manager — must NOT pass stream=True.
        params.pop("stream", None)

        key = self._reject_key()
        heal = 0

        async def run_attempt(attempt_publish: Callable[..., None]) -> StreamResult:
            nonlocal heal
            while True:
                try:
                    return await self._run_stream(params, attempt_publish)
                except Exception as exc:  # noqa: BLE001 — parameter self-heal stays independent
                    param = _deprecated_param_of(exc)
                    if param is not None and param in params and heal < _MAX_SELF_HEAL_RETRIES:
                        params.pop(param, None)
                        _REJECTED_PARAMS.setdefault(key, set()).add(param)
                        heal += 1
                        continue
                    raise

        return await stream_with_transport_retry(run_attempt, publish)

    async def _run_stream(
        self, params: Dict[str, Any], publish: Callable[..., None]
    ) -> StreamResult:
        """Open one Anthropic stream and drain it into a StreamResult.

        Split out of :meth:`stream_turn` so the self-heal retry can re-open the
        stream with a fresh accumulator set. The deprecated-param 400 fires at
        ``__aenter__`` (before any ``publish``), so a retry never double-emits.
        """
        # Lazy-imported so the module stays import-safe where anthropic types
        # aren't needed (e.g. OpenAI-only runs, dispatch tests).
        from anthropic.types import (
            RawContentBlockDeltaEvent,
            RawContentBlockStartEvent,
            RawContentBlockStopEvent,
        )

        content_parts: List[str] = []
        tool_calls: List[Dict[str, Any]] = []
        current_tool: Optional[Dict[str, Any]] = None
        thinking_blocks: List[Dict[str, Any]] = []
        current_thinking: Optional[Dict[str, str]] = None
        async with self.async_client.messages.stream(**params) as response:
            async for event in response:
                if isinstance(event, RawContentBlockStartEvent):
                    block = getattr(event, "content_block", None)
                    btype = getattr(block, "type", None) if block is not None else None
                    if btype == "thinking":
                        current_thinking = {"type": "thinking", "thinking": "", "signature": ""}
                    elif btype == "redacted_thinking":
                        # opaque block — replay its data verbatim
                        thinking_blocks.append(
                            {"type": "redacted_thinking", "data": getattr(block, "data", "")}
                        )
                    elif btype == "tool_use":
                        current_tool = {
                            "name": getattr(block, "name", ""),
                            "id": getattr(block, "id", ""),
                            "arguments": "",
                        }
                elif isinstance(event, RawContentBlockDeltaEvent):
                    delta = getattr(event, "delta", None)
                    if delta is None:
                        continue
                    dtype = getattr(delta, "type", None)
                    if dtype == "text_delta":
                        text = getattr(delta, "text", "") or ""
                        if text:
                            content_parts.append(text)
                            publish("token", text=text)
                    elif dtype == "input_json_delta" and current_tool is not None:
                        current_tool["arguments"] += getattr(delta, "partial_json", "") or ""
                    elif dtype == "thinking_delta":
                        thinking = getattr(delta, "thinking", "") or ""
                        # Capture for replay (DeepSeek requires the turn's thinking
                        # block passed back) AND push to the live channel.
                        if current_thinking is not None:
                            current_thinking["thinking"] += thinking
                        if thinking:
                            publish("reasoning", text=thinking)
                    elif dtype == "signature_delta" and current_thinking is not None:
                        current_thinking["signature"] += getattr(delta, "signature", "") or ""
                elif isinstance(event, RawContentBlockStopEvent):
                    if current_thinking is not None:
                        thinking_blocks.append(current_thinking)
                        current_thinking = None
                    if current_tool is not None:
                        try:
                            args = json.loads(current_tool["arguments"] or "{}")
                        except (json.JSONDecodeError, TypeError):
                            args = {}
                        if not isinstance(args, dict):
                            args = {}
                        if current_tool["name"]:
                            call = {"name": current_tool["name"], "arguments": args}
                            if current_tool.get("id"):
                                call["call_id"] = current_tool["id"]
                            tool_calls.append(call)
                        current_tool = None
            try:  # best-effort usage from the finished message; metering never raises
                final_usage = getattr(await response.get_final_message(), "usage", None)
            except Exception:  # noqa: BLE001
                final_usage = None

        capture = {"thinking_blocks": thinking_blocks} if thinking_blocks else {}
        return StreamResult(
            tool_calls=tool_calls,
            content="".join(content_parts),
            usage=final_usage,
            capture=capture,
        )

    # ------------------------------------------------------------------
    # Serializable contract (required by BaseLlm via Serializable Protocol)
    # ------------------------------------------------------------------
    #
    # In practice the framework serialises LLM instances for history
    # serialized configuration snapshots; round-tripping a live SDK client doesn't make
    # sense, so we record the constructor inputs and rebuild the clients
    # on load. Mirrors how OpenAILlm does it.

    def dump_to_dict(self) -> Dict[str, Any]:
        return {
            "api_base": self.api_base,
            "api_key": self.api_key,
            "configuration": self.configuration.model_dump(),
        }

    def load_from_dict(self, state_dict: Dict[str, Any]) -> None:
        self.api_base = state_dict["api_base"]
        self.api_key = state_dict["api_key"]
        self.configuration = AnthropicConfiguration(**state_dict.get("configuration", {}))
        self.client = Anthropic(
            api_key=self.api_key, base_url=self.api_base, max_retries=RATE_LIMIT_MAX_RETRIES
        )
        self.async_client = AsyncAnthropic(
            api_key=self.api_key, base_url=self.api_base, max_retries=RATE_LIMIT_MAX_RETRIES
        )


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _error_text(exc: Exception) -> str:
    """Every human-readable string we can pull off an Anthropic error.

    Combines ``str(exc)``, ``.message`` and ``body['error']['message']`` so the
    match survives a relay/proxy that wraps the error oddly (e.g. ``type:
    '<nil>'``) — the deprecation sentence lives in at least one of them.
    """
    parts = [str(exc)]
    message = getattr(exc, "message", None)
    if isinstance(message, str):
        parts.append(message)
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            parts.append(err["message"])
    return " ".join(parts)


def _deprecated_param_of(exc: Exception) -> Optional[str]:
    """The sampling param a "deprecated for this model" 400 named, else None.

    Newer Anthropic models reject ``temperature`` / ``top_p`` / ``top_k``
    outright ("`temperature` is deprecated for this model."). Returns the
    offending param so the caller can strip it and retry.
    """
    text = _error_text(exc)
    if "deprecated for this model" not in text:
        return None
    for param in _SAMPLING_PARAMS:
        if param in text:
            return param
    return None


_THINKING_BLOCK_TYPES = ("thinking", "redacted_thinking")


def _thinking_blocks_of(message: Message) -> List[Dict[str, Any]]:
    """The assistant turn's captured thinking blocks, carried on ``extras``.

    ``turn_messages`` stashes ``{"thinking"|"redacted_thinking", ...}`` dicts under
    ``extras["thinking_blocks"]`` when the round produced them; an empty/absent
    value yields no blocks (the common case for non-thinking models).
    """
    blocks = (message.extras or {}).get("thinking_blocks")
    return list(blocks) if blocks else []


def _thinking_first(content: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Stable-partition an assistant content list so thinking blocks lead.

    Anthropic requires ``thinking`` / ``redacted_thinking`` before text and
    tool_use; this keeps that invariant even after same-role folding.
    """
    head = [b for b in content if b.get("type") in _THINKING_BLOCK_TYPES]
    tail = [b for b in content if b.get("type") not in _THINKING_BLOCK_TYPES]
    return head + tail if head else content


def _bridgic_role_to_anthropic(role: Role) -> str:
    """Map bridgic ``Role`` → Anthropic role string.

    Anthropic only knows ``user`` and ``assistant`` at the message-role
    level; tool results live as a ``role=user`` message with a
    ``tool_result`` content block (handled in
    :func:`_blocks_to_anthropic_content`). System messages are extracted
    separately by :meth:`AnthropicLlm._extract_system_and_messages` and
    never reach here.
    """
    if role == Role.AI:
        return "assistant"
    # Both USER and TOOL surface as ``role=user`` on the Anthropic wire —
    # tool results are encoded as content blocks within a user message.
    return "user"


def _blocks_to_anthropic_content(
    blocks: List[ContentBlock],
) -> List[Dict[str, Any]]:
    """Map bridgic content blocks → Anthropic content block list.

    Bridgic uses :class:`TextBlock` / :class:`ToolCallBlock` /
    :class:`ToolResultBlock`; Anthropic uses ``text`` / ``tool_use`` /
    ``tool_result`` content blocks. The wire shapes line up closely once
    you know the field names.
    """
    out: List[Dict[str, Any]] = []
    for block in blocks:
        if isinstance(block, TextBlock):
            out.append({"type": "text", "text": block.text})
        elif isinstance(block, ToolCallBlock):
            # Anthropic's tool_use block carries the tool call id + name
            # + arguments dict (``input`` rather than ``arguments``).
            args = block.arguments
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    args = {}
            out.append(
                {
                    "type": "tool_use",
                    "id": block.id or "",
                    "name": block.name,
                    "input": args or {},
                }
            )
        elif isinstance(block, ToolResultBlock):
            out.append(
                {
                    "type": "tool_result",
                    # bridgic ToolResultBlock carries the call id on ``.id``
                    # (the ToolCallBlock side above uses ``.id`` too); there is
                    # no ``.tool_use_id`` field — reading it crashed every
                    # multi-round tool turn under protocol: anthropic.
                    "tool_use_id": block.id or "",
                    "content": block.content if isinstance(block.content, str) else str(block.content),
                }
            )
        else:
            # Defensive: unknown block types degrade to a text dump rather
            # than blowing up the request. The framework's other block
            # variants are rare in practice; if a new one becomes common
            # it'll show up here as the "??" content and be obvious.
            out.append({"type": "text", "text": getattr(block, "text", "??")})
    return out


def _text_of(message: Message) -> str:
    """Concatenate all TextBlock content in a message — convenience for the
    system-prompt extraction path where we only care about plain text."""
    return "".join(b.text for b in message.blocks if isinstance(b, TextBlock))


def _anthropic_response_to_text(response: Any) -> str:
    """Pull plain text out of an Anthropic non-streaming ``Message`` response.

    The SDK returns a ``Message`` whose ``content`` is a list of typed
    content blocks; this helper joins every ``TextBlock`` together,
    ignoring tool_use blocks (caller asked for text-only).
    """
    pieces: List[str] = []
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) == "text":
            pieces.append(getattr(block, "text", ""))
    return "".join(pieces)


__all__ = ["AnthropicConfiguration", "AnthropicLlm"]
