"""GoogleLlm adapter — bridgic ``Message`` ↔ google-genai ``contents`` mapping.

Pure unit tests (no network): they pin the message→contents conversion and the
``thought_signature`` re-attach that fixes the Gemini multi-turn tool-calling
400 ("Function call is missing a thought_signature"). A live end-to-end probe
lives behind ``GOOGLE_API_KEY`` in ``test_google_live.py``.
"""

from __future__ import annotations

import base64

from bridgic.core.model.types import Message, Role
from google.genai import types

from src.amphi_service.protocol.llms.google_llm import GoogleConfiguration, GoogleLlm


def _llm() -> GoogleLlm:
    return GoogleLlm(api_key="k", configuration=GoogleConfiguration(model="gemini-2.5-flash"))


def test_protocol_and_default_base_url() -> None:
    """The dispatch marker, plus: an empty base_url displays the SDK's real
    default request URL (so the GUI shows where requests actually go)."""
    llm = _llm()
    assert llm.protocol == "google"
    assert llm.api_base == "https://generativelanguage.googleapis.com/"


def test_system_and_user_messages() -> None:
    """SYSTEM text is split into the separate system_instruction; USER text
    becomes a role=user content with a single text part."""
    system, contents = _llm()._messages_to_contents([
        Message.from_text("You are a coder.", role=Role.SYSTEM),
        Message.from_text("hi", role=Role.USER),
    ])
    assert system == "You are a coder."
    assert contents == [{"role": "user", "parts": [{"text": "hi"}]}]


def test_tool_call_reattaches_thought_signature() -> None:
    """An assistant tool-call turn → role=model content whose function_call part
    carries the captured thought_signature (base64 on the record → raw bytes on
    the wire). This is the crux of the 400 fix."""
    sig = b"\x01\x02\x03sig"
    sig_b64 = base64.b64encode(sig).decode()
    ai = Message.from_tool_call(
        tool_calls=[{"id": "c1", "name": "bash", "arguments": {"command": "ls"}}],
        text="let me list",
        extras={"thought_signatures": [sig_b64]},
    )
    _system, contents = _llm()._messages_to_contents([ai])
    assert len(contents) == 1 and contents[0]["role"] == "model"
    part_text, part_call = contents[0]["parts"]
    assert part_text == {"text": "let me list"}
    assert part_call["function_call"]["name"] == "bash"
    assert part_call["function_call"]["args"] == {"command": "ls"}
    assert part_call["thought_signature"] == sig


def test_tool_result_pairs_name_by_id() -> None:
    """A tool result → role=tool content with a function_response whose name is
    recovered from the matching call's id (ToolResultBlock has no name field)."""
    ai = Message.from_tool_call(tool_calls=[{"id": "c1", "name": "bash", "arguments": {}}])
    tool = Message.from_tool_result(tool_id="c1", content="file.txt")
    _system, contents = _llm()._messages_to_contents([ai, tool])
    fr = contents[1]["parts"][0]["function_response"]
    assert contents[1]["role"] == "tool"
    assert fr["name"] == "bash"
    assert fr["id"] == "c1"
    assert fr["response"] == {"result": "file.txt"}


def test_tool_call_without_signature_omits_field() -> None:
    """A non-thinking / signature-less round must NOT emit a thought_signature
    key (an empty/None one would corrupt the part)."""
    ai = Message.from_tool_call(tool_calls=[{"id": "c1", "name": "bash", "arguments": {}}])
    _system, contents = _llm()._messages_to_contents([ai])
    assert "thought_signature" not in contents[0]["parts"][-1]


def test_contents_validate_against_sdk() -> None:
    """The produced dict contents must pass the SDK's own schema — guards the
    wire shape (roles, part keys, bytes signature) without a network call."""
    sig_b64 = base64.b64encode(b"sig").decode()
    msgs = [
        Message.from_text("sys", role=Role.SYSTEM),
        Message.from_text("hi", role=Role.USER),
        Message.from_tool_call(
            tool_calls=[{"id": "c1", "name": "bash", "arguments": {"command": "ls"}}],
            extras={"thought_signatures": [sig_b64]},
        ),
        Message.from_tool_result(tool_id="c1", content="out"),
    ]
    _system, contents = _llm()._messages_to_contents(msgs)
    for content in contents:
        types.Content.model_validate(content)


# ---------------------------------------------------------------------------
# Streaming reduce — fold one google-genai chunk into (tool_calls, content,
# signatures) + live deltas. Pure: synthetic chunks, no network.
# ---------------------------------------------------------------------------


def _chunk(parts: list, usage: dict | None = None):
    payload: dict = {"candidates": [{"content": {"role": "model", "parts": parts}}]}
    if usage is not None:
        payload["usage_metadata"] = usage
    return types.GenerateContentResponse.model_validate(payload)


def _fresh_state() -> dict:
    return {"content": [], "tool_calls": [], "signatures": [], "usage": None}


def test_reduce_text_and_thought_split_channels() -> None:
    events: list = []
    state = _fresh_state()
    GoogleLlm._reduce_chunk(
        _chunk([{"text": "pondering", "thought": True}]), state, lambda c, **k: events.append((c, k))
    )
    GoogleLlm._reduce_chunk(
        _chunk([{"text": "hello"}]), state, lambda c, **k: events.append((c, k))
    )
    assert "".join(state["content"]) == "hello"
    assert ("reasoning", {"text": "pondering"}) in events
    assert ("token", {"text": "hello"}) in events


def test_reduce_function_call_captures_signature_base64() -> None:
    import base64

    state = _fresh_state()
    GoogleLlm._reduce_chunk(
        _chunk([{"function_call": {"id": "g1", "name": "bash", "args": {"command": "ls"}},
                 "thought_signature": b"SIG"}]),
        state, lambda c, **k: None,
    )
    assert state["tool_calls"] == [
        {"name": "bash", "arguments": {"command": "ls"}, "call_id": "g1"}
    ]
    assert state["signatures"] == [base64.b64encode(b"SIG").decode()]


def test_reduce_usage_normalized_for_meter() -> None:
    """Gemini's prompt/candidates/thoughts token counts fold into the
    input/output shape ``_usage_pair`` reads (thoughts billed as output)."""
    state = _fresh_state()
    GoogleLlm._reduce_chunk(
        _chunk([{"text": "x"}], usage={
            "prompt_token_count": 10, "candidates_token_count": 5, "thoughts_token_count": 3,
        }),
        state, lambda c, **k: None,
    )
    assert state["usage"] == {"input_tokens": 10, "output_tokens": 8}
