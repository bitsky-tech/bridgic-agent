"""OpenAI-compatible mock LLM server for end-to-end testing.

Runs a tiny FastAPI app on ``127.0.0.1:<random-port>`` as an asyncio
task in the test's event loop. The bridgic service's ``OpenAILlm``
client makes **real HTTP calls** to it, so tests exercise the
full wire path (auth header, streaming chunks parsing, tool-call
fragment accumulation) — only the remote that would normally cost
money is replaced.

Test usage::

    async def test_x(client, mock_llm):
        # 1. wire the mock as the service's AI provider
        await client.post("/credentials", json={
            "api_key": "test-key",
            "base_url": mock_llm.base_url,
        })
        # 2. queue what the mock should return next
        mock_llm.enqueue_text("Hello, world!")
        # 3. drive the service via its public HTTP API
        ...
        # 4. assert what the service sent to the mock
        assert mock_llm.last_request["messages"][0]["role"] == "system"
"""

from __future__ import annotations

import asyncio
import json
import socket
from typing import Any, AsyncIterator, ClassVar, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from src.amphi_agent._prompt import TITLE_PROMPT

# The session-title side-call is recognised by its system prompt, so the mock can
# answer it out-of-band (canned, queue-free, unlogged) instead of consuming a
# response scripted for the turn itself.
_TITLE_MARKER = TITLE_PROMPT[:24]


def _is_title_request(body: Dict[str, Any]) -> bool:
    """True for the session-title side-call (its system prompt is ``TITLE_PROMPT``)."""
    for message in body.get("messages") or []:
        if message.get("role") == "system" and _TITLE_MARKER in str(message.get("content") or ""):
            return True
    return False


def _find_free_port() -> int:
    """Reserve a free TCP port; close socket before returning it.

    The "bind to 0, get port, close" pattern has a tiny race window
    where another process could grab the port between close and the
    uvicorn rebind. In a test environment that's negligible — if it
    does bite, restart the test.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class MockLLMServer:
    """An OpenAI ``/v1/chat/completions``-compatible mock.

    Tests interact through three surfaces:

    * :attr:`base_url` — feed this to the service via ``POST
      /credentials`` so the OpenAI client points at the mock.
    * :meth:`enqueue_text` / :meth:`enqueue_tool_calls` — set the
      next response (FIFO; defaults to a plain "Hello" if empty).
    * :attr:`requests_received` / :attr:`last_request` — inspect what
      the service actually sent, for assertion.
    """

    READY_POLL_INTERVAL: ClassVar[float] = 0.02
    READY_TIMEOUT: ClassVar[float] = 5.0
    SHUTDOWN_TIMEOUT: ClassVar[float] = 5.0

    def __init__(self) -> None:
        self.port: int = _find_free_port()
        self._responses: List[Dict[str, Any]] = []
        self._title_text: Optional[str] = None
        self.requests_received: List[Dict[str, Any]] = []
        self._server: Optional[uvicorn.Server] = None
        self._task: Optional[asyncio.Task] = None
        # Optional gate used by concurrency tests to keep a stream
        # in mid-flight while another request fires. The mock awaits
        # this event right before emitting the final ``[DONE]`` chunk,
        # giving the test deterministic control over completion.
        self._release_event: Optional[asyncio.Event] = None

        self.app = FastAPI()

        @self.app.post("/v1/chat/completions")
        async def chat_completions(request: Request) -> Any:
            body = await request.json()
            include_usage = bool(
                (body.get("stream_options") or {}).get("include_usage")
            )
            if _is_title_request(body):
                # Title side-call: canned, queue-free, and unlogged so it stays
                # invisible to tests asserting on the turn's own requests. Empty
                # by default → the service cleans it to no title; ``set_title``
                # opts a test in.
                titled = {"text": self._title_text or "", "tool_calls": []}
                if body.get("stream"):
                    return StreamingResponse(
                        self._stream_response(titled, include_usage=include_usage, gated=False),
                        media_type="text/event-stream",
                    )
                return JSONResponse(self._json_response(titled))
            self.requests_received.append(body)
            response = (
                self._responses.pop(0)
                if self._responses
                else {"text": "Hello from mock LLM", "tool_calls": []}
            )
            if body.get("stream"):
                return StreamingResponse(
                    self._stream_response(response, include_usage=include_usage),
                    media_type="text/event-stream",
                )
            return JSONResponse(self._json_response(response))

    # ------------------------------------------------------------------
    # Test-side configuration
    # ------------------------------------------------------------------
    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    @property
    def last_request(self) -> Optional[Dict[str, Any]]:
        return self.requests_received[-1] if self.requests_received else None

    def enqueue_text(self, text: str) -> None:
        """Next chat call returns this text as the assistant message."""
        self._responses.append({"text": text, "tool_calls": []})

    def enqueue_tool_calls(self, *calls: Dict[str, Any]) -> None:
        """Next chat call returns these tool calls.

        Each call is ``{"name": str, "arguments": dict}``. The mock
        JSON-encodes ``arguments`` and streams them in fragments, just
        like the real OpenAI streaming format.
        """
        self._responses.append({"text": "", "tool_calls": list(calls)})

    def set_title(self, text: str) -> None:
        """Make the session-title side-call return ``text`` (default: empty → no title)."""
        self._title_text = text

    def reset(self) -> None:
        """Clear queued responses + request log (between tests)."""
        self._responses.clear()
        self._title_text = None
        self.requests_received.clear()

    def hold_next_stream(self) -> None:
        """Block the *next* streaming response just before its final chunk.

        Used by concurrency tests that need a turn to stay "in flight"
        deterministically while another request is fired. Pair with
        :meth:`release_streams` to let the held stream finish.
        """
        self._release_event = asyncio.Event()

    def release_streams(self) -> None:
        """Release any in-flight stream that's been held by ``hold_next_stream``."""
        if self._release_event is not None:
            self._release_event.set()
            self._release_event = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def start(self) -> None:
        config = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=self.port,
            log_level="error",
            lifespan="off",
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())

        deadline = asyncio.get_event_loop().time() + self.READY_TIMEOUT
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(self.READY_POLL_INTERVAL)
            if self._server.started:
                return
        raise RuntimeError(
            f"MockLLMServer didn't start within {self.READY_TIMEOUT:.0f}s "
            f"(port {self.port})"
        )

    async def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=self.SHUTDOWN_TIMEOUT)
            except asyncio.TimeoutError:
                self._task.cancel()

    # ------------------------------------------------------------------
    # OpenAI wire format — streaming + non-streaming
    # ------------------------------------------------------------------
    async def _stream_response(
        self, response: Dict[str, Any], *, include_usage: bool = False, gated: bool = True,
    ) -> AsyncIterator[str]:
        text: str = response.get("text", "")
        tool_calls: List[Dict[str, Any]] = response.get("tool_calls", [])

        # Stream text content in small chunks so the service's
        # streaming-deltas accumulator gets exercised.
        if text:
            chunk_size = 5
            for i in range(0, len(text), chunk_size):
                payload = self._chunk_payload({"content": text[i : i + chunk_size]})
                yield f"data: {json.dumps(payload)}\n\n"

        # Stream tool calls in fragmented form (name first, then args
        # in chunks) — mirrors OpenAI's actual delta format.
        for tc_idx, call in enumerate(tool_calls):
            name_chunk = self._chunk_payload(
                {
                    "tool_calls": [{
                        "index": tc_idx,
                        "id": f"call_mock_{tc_idx}",
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": "",
                        },
                    }]
                }
            )
            yield f"data: {json.dumps(name_chunk)}\n\n"

            args_json = json.dumps(call.get("arguments", {}))
            for i in range(0, len(args_json), 10):
                args_chunk = self._chunk_payload(
                    {
                        "tool_calls": [{
                            "index": tc_idx,
                            "function": {"arguments": args_json[i : i + 10]},
                        }]
                    }
                )
                yield f"data: {json.dumps(args_chunk)}\n\n"

        # Concurrency-test gate: block here until the test releases. No-op when
        # no test has set the event, and skipped for out-of-band side-calls (the
        # title stream) so ``hold_next_stream`` only ever pins the turn itself.
        if gated and self._release_event is not None:
            await self._release_event.wait()

        # Final chunk announces finish_reason
        final = self._chunk_payload({})
        final["choices"][0]["finish_reason"] = (
            "tool_calls" if tool_calls else "stop"
        )
        yield f"data: {json.dumps(final)}\n\n"

        # OpenAI emits a usage-only chunk (empty choices) at the end when the
        # caller sets ``stream_options.include_usage`` — mirror it so the
        # agent's streaming token metering has something to read.
        if include_usage:
            completion = max(1, len(text.split()))
            usage_chunk = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "mock-model",
                "choices": [],
                "usage": {
                    "prompt_tokens": 11,
                    "completion_tokens": completion,
                    "total_tokens": 11 + completion,
                },
            }
            yield f"data: {json.dumps(usage_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    def _chunk_payload(self, delta: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "mock-model",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": None,
            }],
        }

    def _json_response(self, response: Dict[str, Any]) -> Dict[str, Any]:
        text: str = response.get("text", "")
        tool_calls: List[Dict[str, Any]] = response.get("tool_calls", [])
        message: Dict[str, Any] = {"role": "assistant", "content": text or None}
        if tool_calls:
            message["tool_calls"] = [
                {
                    "id": f"call_mock_{i}",
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(call.get("arguments", {})),
                    },
                }
                for i, call in enumerate(tool_calls)
            ]
            message["content"] = None
        return {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "created": 0,
            "model": "mock-model",
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
        }


__all__ = ["MockLLMServer"]
