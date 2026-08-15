"""Live Gemini integration — the thought_signature round-trip the unit tests
can only mock. SKIPPED unless ``GOOGLE_API_KEY`` is set (needs a real key +
network), so CI stays hermetic.

Together the two tests form a differential proof of the fix, run against a model
that hard-enforces signatures (Gemini 3.x; default ``gemini-3.1-flash-lite``,
override with ``GOOGLE_TEST_MODEL``):

* WITHOUT the signature, round 2 of a tool-calling loop 400s ("Function call is
  missing a thought_signature") — the bug.
* WITH the captured signature replayed (exactly as ``turn_messages`` does), the
  same round 2 succeeds — the fix.

A model that doesn't return a signature (e.g. ``gemini-2.5-flash`` on a single
call) makes the proof vacuous, so each test skips in that case.
"""

from __future__ import annotations

import base64
import os

import pytest
from bridgic.core.model.types import Message, Role

from src.amphi_service.protocol.llms.google_llm import GoogleConfiguration, GoogleLlm

pytestmark = pytest.mark.skipif(
    not os.getenv("GOOGLE_API_KEY"),
    reason="set GOOGLE_API_KEY to run the live Gemini thought_signature test",
)

# A GA Gemini 3.x model that enforces the signature (verified 2026-06). Override
# via GOOGLE_TEST_MODEL if it gets retired.
_MODEL = os.getenv("GOOGLE_TEST_MODEL", "gemini-3.1-flash-lite")
_TOOLS = [{
    "name": "run_bash",
    "description": "Run a shell command and return its output.",
    "parameters": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}]
# Force a function call so round 1 deterministically produces a signed tool call.
_FORCE_TOOL = {"tool_config": {"function_calling_config": {"mode": "ANY"}}}


def _llm() -> GoogleLlm:
    return GoogleLlm(
        api_key=os.environ["GOOGLE_API_KEY"],
        configuration=GoogleConfiguration(model=_MODEL),
    )


async def _first_function_call(llm: GoogleLlm, messages):
    """Round 1: stream a forced tool call; return (call, base64 signature|None)."""
    params = llm._build_parameters(messages, tools=_TOOLS, extra_body=_FORCE_TOOL)
    call = None
    signature = None
    async for chunk in await llm.async_client.models.generate_content_stream(**params):
        for cand in chunk.candidates or []:
            for part in (getattr(cand.content, "parts", None) or []):
                if part.function_call is not None:
                    call = part.function_call
                    if part.thought_signature:
                        signature = base64.b64encode(part.thought_signature).decode()
    return call, signature


def _replay(call, signature):
    """Rebuild the assistant tool-call turn (optionally re-signed via extras,
    exactly as ``turn_messages`` does) + its tool result."""
    call_id = call.id or "call_0"
    ai = Message.from_tool_call(
        tool_calls=[{"id": call_id, "name": call.name, "arguments": dict(call.args or {})}],
        extras={"thought_signatures": [signature]} if signature else {},
    )
    result = Message.from_tool_result(tool_id=call_id, content="file_a.txt\nfile_b.txt")
    return ai, result


async def test_thought_signature_roundtrip_no_400() -> None:
    """THE FIX: replaying the captured signature lets round 2 through."""
    llm = _llm()
    asked = [Message.from_text("Use run_bash to run `ls`.", role=Role.USER)]
    call, signature = await _first_function_call(llm, asked)
    assert call is not None, "model did not emit a function call"
    if signature is None:
        pytest.skip(f"{_MODEL} returned no thought_signature — proof is vacuous")

    ai, result = _replay(call, signature)
    params = llm._build_parameters([*asked, ai, result], tools=_TOOLS)
    text_parts = []
    async for chunk in await llm.async_client.models.generate_content_stream(**params):
        if chunk.text:
            text_parts.append(chunk.text)
    assert isinstance("".join(text_parts), str)  # reached here == no 400


async def test_missing_signature_400s() -> None:
    """THE BUG (control): the same round 2 WITHOUT the signature 400s — proves
    the fix above is load-bearing, not a no-op."""
    llm = _llm()
    asked = [Message.from_text("Use run_bash to run `ls`.", role=Role.USER)]
    call, signature = await _first_function_call(llm, asked)
    assert call is not None, "model did not emit a function call"
    if signature is None:
        pytest.skip(f"{_MODEL} returned no thought_signature — nothing to enforce")

    ai, result = _replay(call, signature=None)  # drop the signature
    params = llm._build_parameters([*asked, ai, result], tools=_TOOLS)
    with pytest.raises(Exception) as exc:
        async for _chunk in await llm.async_client.models.generate_content_stream(**params):
            pass
    assert "thought_signature" in str(exc.value) or "400" in str(exc.value)
