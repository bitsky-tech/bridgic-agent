import asyncio
import contextlib
from typing import Any, Callable, Dict, List, Optional

import httpx

from ...i18n import backend_i18n
from bridgic.core.model.types import Message, Role
from bridgic.llms.openai import OpenAILlm

from ._image_inputs import IMAGE_INPUTS_EXTRA, image_data_url, image_inputs_of
from ._openai_params import is_kimi_code_endpoint, sanitize_openai_params, unsupported_param_of
from ._streaming import (
    RATE_LIMIT_MAX_RETRIES,
    ModelNotFoundError,
    StreamResult,
    accumulate_reasoning_details,
    accumulate_tool_deltas,
    is_model_not_found_error,
    is_retryable_stream_error,
    model_not_found_message,
    parse_tool_calls,
    rate_limit_delay,
    stream_with_transport_retry,
)

# (endpoint, model) -> the set of parameter names this API has already rejected;
# learned per process, so subsequent calls strip them up front.
_REJECTED_PARAMS: Dict[tuple, set] = {}

# Marker key on ``Message.extras`` identifying the per-round <runtime_state>
# tail (set by the agent layer; value duplicated here to keep this module free
# of agent imports). bridgic splats extras onto the wire message, so the flag
# must be stripped before conversion — providers reject unknown fields.
_VOLATILE_TAIL_EXTRA = "volatile_tail"

# Upper bound on parameter-stripping retries: in practice there are only a handful of
# unsupported parameters, so this is plenty and can never loop forever.
_MAX_SELF_HEAL_RETRIES = 8
_KIMI_RETRY_MAX_DELAY_SECONDS = 2.0
_KIMI_STREAM_OPEN_TIMEOUT_SECONDS = 15.0
_KIMI_STREAM_READ_TIMEOUT_SECONDS = 30.0


class OpenAICompatLlm(OpenAILlm):
    """Local subclass of bridgic's OpenAILlm: adds the protocol marker and the agent
    streaming entry point.

    Covers the OpenAI Chat Completions compatible family (OpenAI api_key / DeepSeek /
    GLM / OpenRouter); capturing reasoning_content gets a first-class home here.
    """

    protocol: str = "openai"

    def _reject_key(self) -> tuple:
        return (getattr(self, "api_base", None) or "", str(self.configuration.model or ""))

    def _is_kimi_code(self) -> bool:
        return is_kimi_code_endpoint(getattr(self, "api_base", None))

    def _kimi_access_error(self, exc: Exception) -> Optional[str]:
        """Translate Kimi subscription entitlement failures into actionable text."""
        if not self._is_kimi_code():
            return None
        low = str(exc).lower()
        if "does not have access to k3" in low:
            return backend_i18n.text("llm.kimi.k3_access_denied")
        if "does not have access to kimi-for-coding-highspeed" in low:
            return backend_i18n.text("llm.kimi.highspeed_access_denied")
        return None

    def _stream_client(self) -> Any:
        """Return the request client, disabling Kimi SDK-internal retries."""
        client = self.async_client
        if self._is_kimi_code() and hasattr(client, "with_options"):
            return client.with_options(
                max_retries=0,
                timeout=httpx.Timeout(
                    _KIMI_STREAM_READ_TIMEOUT_SECONDS,
                    connect=5.0,
                    pool=5.0,
                    write=10.0,
                ),
            )
        return client

    async def _open_stream_request(self, params: Dict[str, Any]) -> Any:
        """Open one provider stream with a bounded Kimi handshake."""
        request = self._stream_client().chat.completions.create(**params)
        if self._is_kimi_code():
            return await asyncio.wait_for(
                request,
                timeout=_KIMI_STREAM_OPEN_TIMEOUT_SECONDS,
            )
        return await request

    async def _create_stream(self, params: Dict[str, Any], publish: Callable[..., None]) -> Any:
        """Open a streaming create; two kinds of self-healing, counted independently, and
        never looping forever:

        * **Rate limiting / transient 5xx** (a 429 from upstream rate limiting on the
          DeepSeek/GLM/OpenRouter free models, or OpenRouter's 503 "No backends
          available", an upstream 502/504, overload) → back off and retry, respecting the
          provider's retryDelay hint. A multi-round agent turn no longer collapses
          because of a single hiccup; a 429 from an exhausted daily quota is NOT retried
          (it only resets the next day).
        * **400 unsupported_parameter** → strip the named parameter, retry, and cache it
          per process. Static sanitizing already covers the known reasoning models; this
          layer catches unknown / future ones.

        create(stream=True) raises 4xx/5xx before the first chunk, so retrying is clean;
        any other error is re-raised immediately.
        """
        key = self._reject_key()
        for p in list(_REJECTED_PARAMS.get(key, ())):
            params.pop(p, None)
        rate_retries = 0
        heal_retries = 0
        while True:
            try:
                response = await self._open_stream_request(params)
                if rate_retries:
                    publish(
                        "model_retry",
                        active=False,
                        attempt=rate_retries,
                        max_retries=RATE_LIMIT_MAX_RETRIES,
                        delay_seconds=0.0,
                    )
                return response
            except Exception as exc:  # noqa: BLE001 — non-self-healable errors are re-raised below
                access_error = self._kimi_access_error(exc)
                if access_error is not None:
                    raise RuntimeError(access_error) from exc
                # Rate limiting (not the daily quota) or a transient 5xx (capacity /
                # overload / gateway) → back off and retry. OpenRouter's free-tier 503
                # "No backends available" belongs to the latter.
                if (
                    is_retryable_stream_error(exc)
                    and rate_retries < RATE_LIMIT_MAX_RETRIES
                ):
                    delay = rate_limit_delay(exc, rate_retries)
                    if self._is_kimi_code():
                        delay = min(delay, _KIMI_RETRY_MAX_DELAY_SECONDS)
                    rate_retries += 1
                    publish(
                        "model_retry",
                        active=True,
                        attempt=rate_retries,
                        max_retries=RATE_LIMIT_MAX_RETRIES,
                        delay_seconds=delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                param = unsupported_param_of(exc)
                if param is not None and param in params and heal_retries < _MAX_SELF_HEAL_RETRIES:
                    params.pop(param, None)
                    _REJECTED_PARAMS.setdefault(key, set()).add(param)
                    heal_retries += 1
                    continue
                # Model does not exist: fail fast, translating the opaque 404 into an
                # actionable domain error.
                if is_model_not_found_error(exc):
                    raise ModelNotFoundError(
                        model_not_found_message(str(self.configuration.model or "") or None)
                    ) from exc
                raise

    def _build_parameters(self, *args: Any, **kwargs: Any) -> Dict[str, Any]:
        """On top of bridgic's parameter assembly, layer OpenAI reasoning-model
        sanitizing.

        Covers every exit: stream_turn (streaming) and the inherited chat/achat
        (probing/titling/compaction) all go through this assembly, so reasoning models'
        parameter 400s are cured here in one place. Reasoning-model rules are keyed
        on the model name, so they hold behind relays too; other endpoints pass through.
        """
        messages = kwargs.get("messages")
        image_groups = [image_inputs_of(message) for message in messages] if messages else []
        if messages:
            kwargs = {**kwargs, "messages": [
                msg.model_copy(update={
                    "extras": {
                        key: value
                        for key, value in (msg.extras or {}).items()
                        if key not in {_VOLATILE_TAIL_EXTRA, IMAGE_INPUTS_EXTRA}
                    }
                })
                if set((msg.extras or {})) & {_VOLATILE_TAIL_EXTRA, IMAGE_INPUTS_EXTRA}
                else msg
                for msg in messages
            ]}
        params = super()._build_parameters(*args, **kwargs)
        wire_messages = params.get("messages") or []
        for message, images, wire in zip(messages or [], image_groups, wire_messages):
            if message.role != Role.USER or not images:
                continue
            original = wire.get("content", "")
            content = list(original) if isinstance(original, list) else []
            if isinstance(original, str) and original:
                content.append({"type": "text", "text": original})
            content.extend({
                "type": "image_url",
                "image_url": {"url": image_data_url(image), "detail": "auto"},
            } for image in images)
            wire["content"] = content
        params = sanitize_openai_params(params, base_url=getattr(self, "api_base", None))
        # Drop what this endpoint already rejected (learned by ``_create_stream`` /
        # ``achat``), so the probe and the safety classifier don't re-hit the 400.
        for name in _REJECTED_PARAMS.get(self._reject_key(), ()):
            params.pop(name, None)
        return params

    async def achat(self, messages: List[Message], **kwargs: Any) -> Any:
        """bridgic's achat plus the unsupported-parameter self-heal.

        Known reasoning models are sanitized up front; this covers the rest — a
        model the name heuristic misses behind a strict relay (LiteLLM without
        ``drop_params``) rejects e.g. ``temperature`` on every call, including the
        provider probe and the safety classifier, which reach the model through
        achat before any stream could learn the rejection. A
        ``ModelUnrecoverableError`` wrapping such a 400 strips the named param,
        caches it, and retries; anything else propagates unchanged.
        """
        key = self._reject_key()
        heal_retries = 0
        while True:
            try:
                return await super().achat(messages, **kwargs)
            except Exception as exc:  # noqa: BLE001 — only the named-param 400 is healed
                original = getattr(exc, "original_exception", None) or exc
                param = unsupported_param_of(original)
                if (
                    param is not None
                    and param not in _REJECTED_PARAMS.get(key, set())
                    and heal_retries < _MAX_SELF_HEAL_RETRIES
                ):
                    _REJECTED_PARAMS.setdefault(key, set()).add(param)
                    heal_retries += 1
                    continue
                raise

    async def stream_turn(
        self,
        messages: List[Message],
        tools: Optional[List[Any]],
        *,
        publish: Callable[..., None],
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> StreamResult:
        params = self._build_parameters(
            messages=messages, tools=tools or None, extra_body=extra_body,
            stream=True, stream_options={"include_usage": True})

        async def run_attempt(attempt_publish: Callable[..., None]) -> StreamResult:
            response = await self._create_stream(params, attempt_publish)
            content_parts: List[str] = []
            reasoning_parts: List[str] = []
            reasoning_detail_buffers: dict = {}
            tool_buffers: dict = {}
            usage: Any = None
            try:
                async for chunk in response:
                    if getattr(chunk, "usage", None) is not None:
                        usage = chunk.usage
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                    if reasoning:
                        reasoning_parts.append(reasoning)
                        attempt_publish("reasoning", text=reasoning)
                    # OpenRouter also streams structured ``reasoning_details`` (signature-
                    # bearing for Claude/Gemini); accumulate for verbatim cross-turn replay.
                    details = getattr(delta, "reasoning_details", None)
                    if details:
                        accumulate_reasoning_details(reasoning_detail_buffers, details)
                    if delta.content:
                        content_parts.append(delta.content)
                        attempt_publish("token", text=delta.content)
                    if delta.tool_calls:
                        accumulate_tool_deltas(tool_buffers, delta.tool_calls)
            finally:
                with contextlib.suppress(Exception):
                    await response.close()
            capture: Dict[str, Any] = {}
            if reasoning_parts:
                capture["reasoning_content"] = "".join(reasoning_parts)
            if reasoning_detail_buffers:
                capture["reasoning_details"] = [
                    reasoning_detail_buffers[i] for i in sorted(reasoning_detail_buffers)
                ]
            return StreamResult(
                tool_calls=parse_tool_calls(tool_buffers[i] for i in sorted(tool_buffers)),
                content="".join(content_parts), usage=usage, capture=capture)

        return await stream_with_transport_retry(run_attempt, publish)


__all__ = ["OpenAICompatLlm"]
