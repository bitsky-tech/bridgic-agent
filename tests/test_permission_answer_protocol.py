"""Phase 1.1 — permission-approval dedicated channel: protocol-level schema.

Covers the wire contract added for the dedicated approval channel (no longer
overloading ``chat``):
  - ``permission_answer`` inbound frame parses via ``parse_client_message``
    and is fail-closed on bad shapes;
  - ``PermissionRequestEvent`` carries ``request_id`` + per-item ``call_index``
    in its payload;
  - ``AwaitingPermission`` persists ``request_id`` and stays backward-compatible
    with old rows that lack it.

These are pure schema checks (no agent/stream) — the resume wiring is Phase 1.3.
"""

from __future__ import annotations

import pytest

from src.amphi_agent._state import AwaitingPermission
from src.amphi_service.protocol._events import PermissionRequestEvent
from src.amphi_service.protocol._ws_messages import (
    WsMessageError,
    WsPermissionAnswer,
    parse_client_message,
)


def test_permission_answer_frame_parses() -> None:
    """A valid permission_answer dict → typed WsPermissionAnswer with per-call answers."""
    msg = parse_client_message(
        {
            "type": "permission_answer",
            "session_id": "s1",
            "request_id": "req-abc",
            "answers": [
                {"call_index": 0, "decision": "allow", "instruction": "只读该文件"},
                {"call_index": 2, "decision": "deny"},
            ],
        }
    )
    assert isinstance(msg, WsPermissionAnswer)
    assert msg.session_id == "s1"
    assert msg.request_id == "req-abc"
    assert [(a.call_index, a.decision, a.instruction) for a in msg.answers] == [
        (0, "allow", "只读该文件"),
        (2, "deny", None),
    ]


def test_permission_answer_defaults_empty_answers() -> None:
    """answers is optional (defaults to empty) — an all-noop answer is still well-formed."""
    msg = parse_client_message(
        {"type": "permission_answer", "session_id": "s1", "request_id": "r"}
    )
    assert isinstance(msg, WsPermissionAnswer)
    assert msg.answers == []


@pytest.mark.parametrize(
    "bad",
    [
        {"decision": "maybe", "call_index": 0},   # decision not allow/deny
        {"decision": "allow", "call_index": -1},  # negative call_index
        {"decision": "allow"},                    # missing call_index
        {"call_index": 0},                        # missing decision
        {"call_index": 0, "decision": "allow", "extra": 1},  # extra field forbidden
    ],
)
def test_permission_answer_rejects_bad_item(bad: dict) -> None:
    """Malformed answer item → WsMessageError (fail-closed at the boundary)."""
    with pytest.raises(WsMessageError):
        parse_client_message(
            {
                "type": "permission_answer",
                "session_id": "s1",
                "request_id": "r",
                "answers": [bad],
            }
        )


def test_permission_answer_requires_request_id() -> None:
    """request_id is mandatory — it's how the daemon matches the parked round."""
    with pytest.raises(WsMessageError):
        parse_client_message(
            {"type": "permission_answer", "session_id": "s1", "answers": []}
        )


def test_permission_request_event_payload_carries_request_id_and_call_index() -> None:
    """The outbound gate event exposes request_id + each item's call_index for echo-back."""
    event = PermissionRequestEvent(
        questions=[{"question": "Approve read_file(path=a)?"}],
        items=[
            {
                "call_index": 0,
                "tool": "read_file",
                "arguments": {"path": "a"},
                "capability": "read",
                "boundary": "workspace",
                "label": "",
            }
        ],
        request_id="req-xyz",
    )
    payload = event.payload()
    assert payload["request_id"] == "req-xyz"
    assert payload["items"][0]["call_index"] == 0
    assert payload["kind"] == "choose"


def test_awaiting_permission_persists_request_id_roundtrip() -> None:
    """request_id survives model_dump → model_validate (it lives in state.interaction)."""
    parked = AwaitingPermission(permission={"items": []}, request_id="req-1")
    restored = AwaitingPermission.model_validate(parked.model_dump())
    assert restored.request_id == "req-1"


def test_awaiting_permission_backward_compatible_without_request_id() -> None:
    """Old persisted rows had no request_id → load as None, not an error."""
    restored = AwaitingPermission.model_validate({"permission": {"items": []}})
    assert restored.request_id is None
