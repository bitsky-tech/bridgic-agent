import base64
import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from bridgic.core.model import BaseLlm
from bridgic.core.model.types import (
    Message,
    Role,
    TextBlock,
    ToolCallBlock,
    ToolResultBlock,
)
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from ._streaming import (
    StreamResult,
    convert_tools,
    open_stream_with_retry,
    stream_with_transport_retry,
)

# The google-genai SDK's resolved default request endpoint (introspected from
# genai 2.8: HttpOptions → https://generativelanguage.googleapis.com/ @ v1beta).
# Used purely for DISPLAY: an empty user base_url means "let the SDK use its
# default", and the GUI should show that real URL rather than a blank field.
_DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/"


class GoogleConfiguration(BaseModel):
    """Per-request defaults for a :class:`GoogleLlm` instance.

    Mirrors ``OpenAIConfiguration`` / ``AnthropicConfiguration`` so call sites
    can switch LLM type without rewriting the configuration wiring.
    """

    model: str = Field(description="Model id, e.g. 'gemini-2.5-flash'.")
    temperature: float = Field(default=0.0)
    max_tokens: Optional[int] = Field(default=None)


class GoogleLlm(BaseLlm):
    """Native Gemini client (google-genai SDK) matching Bridgic's ``BaseLlm``.

    Why a native adapter instead of the OpenAI-compat endpoint: Gemini's
    function calls carry a ``thought_signature`` that MUST be echoed back on the
    next turn, else the API 400s ("Function call is missing a thought_signature").
    The OpenAI-compat shim smuggles it in a non-standard ``extra_content`` field
    that bridgic's shared OpenAI serializer drops. Owning the conversion here
    gives the signature a first-class home on the ``Part`` (``thought_signature``)
    and keeps Google-specific quirks out of the shared OpenAI path.

    Like the other native adapters, this deliberately exposes ``client`` /
    ``async_client`` so the agent's ``thinking()`` loop can drive native
    streaming + tool calling that the abstract ``BaseLlm`` surface doesn't cover.
    """

    # Marker consumed by ``MainThink.thinking`` to dispatch to ``_stream_google``.
    protocol: str = "google"

    def __init__(
        self,
        *,
        api_key: str,
        api_base: Optional[str] = None,
        configuration: Optional[GoogleConfiguration] = None,
    ) -> None:
        # Empty/whitespace base_url → None → the SDK uses its built-in endpoint.
        # ``api_base`` (the display value) then reflects that real default.
        resolved = (api_base or "").strip() or None
        self.api_base = resolved or _DEFAULT_API_BASE
        self.api_key = api_key
        self.configuration = configuration or GoogleConfiguration(model="gemini-2.5-flash")
        http_options = types.HttpOptions(base_url=resolved) if resolved else None
        self.client = genai.Client(api_key=api_key, http_options=http_options)
        self.async_client = self.client.aio

    # ------------------------------------------------------------------
    # Message ↔ Gemini contents conversion
    # ------------------------------------------------------------------

    def _messages_to_contents(
        self, messages: List[Message]
    ) -> Tuple[Optional[str], List[Dict[str, Any]]]:
        """Split a bridgic message list into Gemini's (system_instruction,
        contents) pair.

        SYSTEM text is concatenated into the separate ``system_instruction``;
        the rest map to ``role`` + ``parts`` contents. A ``ToolResultBlock``
        carries no tool name, so its ``function_response`` recovers the name
        from the matching call's id (collected as the assistant turns stream by).
        """
        system_parts: List[str] = []
        contents: List[Dict[str, Any]] = []
        id_to_name: Dict[str, str] = {}
        for msg in messages:
            if msg.role == Role.SYSTEM:
                system_parts.append(_text_of(msg))
            elif msg.role == Role.TOOL:
                contents.append(self._tool_message_to_content(msg, id_to_name))
            elif msg.role == Role.AI:
                for block in msg.blocks:
                    if isinstance(block, ToolCallBlock):
                        id_to_name[block.id or ""] = block.name
                contents.append(self._ai_message_to_content(msg))
            else:  # Role.USER
                contents.append({"role": "user", "parts": [{"text": _text_of(msg)}]})
        system = "\n\n".join(p for p in system_parts if p) or None
        return system, contents

    def _ai_message_to_content(self, msg: Message) -> Dict[str, Any]:
        """An assistant turn → a ``role=model`` content: the thought text first,
        then one ``function_call`` part per tool call, each re-attaching its
        captured ``thought_signature`` (base64 on the record → raw bytes here).

        The signatures ride on ``extras["thought_signatures"]`` as an ordered
        list aligned to the turn's tool calls (``turn_messages`` stashes them);
        a missing / falsy entry emits no signature key.
        """
        parts: List[Dict[str, Any]] = []
        text = _text_of(msg)
        if text:
            parts.append({"text": text})
        signatures = (msg.extras or {}).get("thought_signatures") or []
        call_index = 0
        for block in msg.blocks:
            if not isinstance(block, ToolCallBlock):
                continue
            args = block.arguments
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    args = {}
            call: Dict[str, Any] = {"name": block.name, "args": args or {}}
            if block.id:
                call["id"] = block.id
            part: Dict[str, Any] = {"function_call": call}
            sig = signatures[call_index] if call_index < len(signatures) else None
            if sig:
                part["thought_signature"] = base64.b64decode(sig)
            parts.append(part)
            call_index += 1
        return {"role": "model", "parts": parts}

    def _tool_message_to_content(
        self, msg: Message, id_to_name: Dict[str, str]
    ) -> Dict[str, Any]:
        """A tool result → a ``role=tool`` content with a ``function_response``
        part. Gemini matches the response to its call by name (+ id); the name
        is recovered from ``id_to_name`` since the result block lacks it."""
        parts: List[Dict[str, Any]] = []
        for block in msg.blocks:
            if not isinstance(block, ToolResultBlock):
                continue
            content = block.content if isinstance(block.content, str) else str(block.content)
            response: Dict[str, Any] = {
                "name": id_to_name.get(block.id or "", block.id or ""),
                "response": {"result": content},
            }
            if block.id:
                response["id"] = block.id
            parts.append({"function_response": response})
        return {"role": "tool", "parts": parts}

    def _build_parameters(
        self,
        messages: List[Message],
        *,
        tools: Optional[List[Dict[str, Any]]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        stream: bool = False,
    ) -> Dict[str, Any]:
        """Assemble kwargs for ``client.models.generate_content[_stream](**...)``.

        ``tools`` is a list of Gemini function declarations
        (``[{"name", "description", "parameters"}]``); the agent layer converts
        bridgic ``ToolSpec`` into that shape before passing in. ``stream`` is a
        no-op here (the caller picks ``generate_content`` vs the stream variant);
        it stays in the signature for parity with the other adapters.
        """
        system, contents = self._messages_to_contents(messages)
        cfg = self.configuration
        config_kwargs: Dict[str, Any] = {"temperature": cfg.temperature}
        if system:
            config_kwargs["system_instruction"] = system
        if cfg.max_tokens:
            config_kwargs["max_output_tokens"] = cfg.max_tokens
        if tools:
            config_kwargs["tools"] = [{"function_declarations": tools}]
        if extra_body:
            config_kwargs.update(extra_body)
        return {
            "model": cfg.model,
            "contents": contents,
            "config": types.GenerateContentConfig(**config_kwargs),
        }

    # ------------------------------------------------------------------
    # BaseLlm abstract methods — minimal "text in, text out" support
    # ------------------------------------------------------------------
    #
    # The agent's streaming + tools path does NOT go through these (it reaches
    # the inner client directly via ``_stream_google``). These satisfy the ABC
    # and back simple text exchanges such as the connection probe.

    def chat(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        response = self.client.models.generate_content(**self._build_parameters(messages))
        return _response_text(response)

    async def achat(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        response = await self.async_client.models.generate_content(
            **self._build_parameters(messages)
        )
        return _response_text(response)

    def stream(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        # These minimal paths only need the final text for probes;
        # the non-streaming call already returns it, so don't pay for streaming.
        return self.chat(messages, **kwargs)

    async def astream(self, messages: List[Message], **kwargs: Any) -> Any:  # noqa: D401
        return await self.achat(messages, **kwargs)

    # ------------------------------------------------------------------
    # Native streaming — text + reasoning + tool calls in one pass
    # ------------------------------------------------------------------

    @staticmethod
    def _reduce_chunk(chunk: Any, state: Dict[str, Any], publish: Any) -> None:
        """Fold one google-genai stream chunk into ``state`` and push live deltas.

        ``state`` carries ``content`` (text fragments), ``tool_calls``
        ({name, arguments}), ``signatures`` (base64 thought_signature per call,
        index-aligned to ``tool_calls``; ``None`` when absent), and ``usage``.
        A ``function_call`` part contributes a call + its signature; a thought
        part (``.thought`` text) streams on ``reasoning``; plain text on
        ``token``. Pure + synchronous so the grammar is unit-testable without a
        live stream.
        """
        usage = getattr(chunk, "usage_metadata", None)
        if usage is not None:
            # Normalize to the shape ``_usage_values`` reads; Gemini's thinking
            # tokens are billed as output.
            normalized_usage = {
                "input_tokens": getattr(usage, "prompt_token_count", 0) or 0,
                "output_tokens": (getattr(usage, "candidates_token_count", 0) or 0)
                + (getattr(usage, "thoughts_token_count", 0) or 0),
            }
            cached_input_tokens = getattr(usage, "cached_content_token_count", None)
            if cached_input_tokens is not None:
                normalized_usage["cached_input_tokens"] = cached_input_tokens
            state["usage"] = normalized_usage
        candidates = getattr(chunk, "candidates", None) or []
        if not candidates:
            return
        content = getattr(candidates[0], "content", None)
        for part in (getattr(content, "parts", None) or []):
            call = getattr(part, "function_call", None)
            if call is not None:
                tool_call = {"name": call.name or "", "arguments": dict(call.args or {})}
                call_id = getattr(call, "id", None)
                if call_id:
                    tool_call["call_id"] = str(call_id)
                state["tool_calls"].append(tool_call)
                sig = getattr(part, "thought_signature", None)
                state["signatures"].append(base64.b64encode(sig).decode() if sig else None)
                continue
            text = getattr(part, "text", None)
            if not text:
                continue
            if getattr(part, "thought", False):
                publish("reasoning", text=text)
            else:
                state["content"].append(text)
                publish("token", text=text)

    async def stream_turn(
        self,
        messages: List[Message],
        tools: Optional[List[Any]],
        *,
        publish: Callable[..., None],
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> StreamResult:
        """Stream a Gemini turn via the native google-genai SDK; push token /
        reasoning; return a :class:`StreamResult`.

        Gemini attaches a ``thought_signature`` to each function-call part that
        MUST be echoed back next turn (else a 400). We capture each call's
        signature (base64) into the result's ``capture``; ``turn_messages``
        replays it through GoogleLlm's native conversion. Chunk folding is
        delegated to the pure :meth:`_reduce_chunk` so the grammar is unit-testable.
        """
        params = self._build_parameters(
            messages, tools=convert_tools(tools, "google") if tools else None,
            extra_body=extra_body,
        )
        async def run_attempt(attempt_publish: Callable[..., None]) -> StreamResult:
            state: Dict[str, Any] = {
                "content": [], "tool_calls": [], "signatures": [], "usage": None,
            }
            # The Gemini free tier allows 5 RPM, so a multi-round agent is almost
            # guaranteed to hit a 429 (RESOURCE_EXHAUSTED); when opening the stream, back
            # off and retry per the provider's retryDelay instead of collapsing the whole
            # turn.
            stream = await open_stream_with_retry(
                lambda: self.async_client.models.generate_content_stream(**params),
                model=self.configuration.model,
                publish=attempt_publish,
            )
            async for chunk in stream:
                self._reduce_chunk(chunk, state, attempt_publish)

            capture = {"thought_signatures": state["signatures"]} if any(state["signatures"]) else {}
            return StreamResult(
                tool_calls=state["tool_calls"],
                content="".join(state["content"]),
                usage=state["usage"],
                capture=capture,
            )

        return await stream_with_transport_retry(run_attempt, publish)

    # ------------------------------------------------------------------
    # Serializable contract (BaseLlm) — record ctor inputs, rebuild on load
    # ------------------------------------------------------------------

    def dump_to_dict(self) -> Dict[str, Any]:
        return {
            "api_base": self.api_base,
            "api_key": self.api_key,
            "configuration": self.configuration.model_dump(),
        }

    def load_from_dict(self, state_dict: Dict[str, Any]) -> None:
        self.api_base = state_dict["api_base"]
        self.api_key = state_dict["api_key"]
        self.configuration = GoogleConfiguration(**state_dict.get("configuration", {}))
        # api_base may be the display default; only forward a genuinely custom
        # endpoint to the SDK (the default → None → SDK's built-in endpoint).
        resolved = (self.api_base or "").strip() or None
        if resolved == _DEFAULT_API_BASE:
            resolved = None
        http_options = types.HttpOptions(base_url=resolved) if resolved else None
        self.client = genai.Client(api_key=self.api_key, http_options=http_options)
        self.async_client = self.client.aio


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _text_of(message: Message) -> str:
    """Concatenate every TextBlock's content in a message."""
    return "".join(b.text for b in message.blocks if isinstance(b, TextBlock))


def _response_text(response: Any) -> str:
    """Pull plain text out of a google-genai ``GenerateContentResponse``."""
    return getattr(response, "text", None) or ""


__all__ = ["GoogleConfiguration", "GoogleLlm"]
