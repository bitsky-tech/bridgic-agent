"""Plain-language describer for commands under approval — independent of the security
classifier, it gives a non-technical user one sentence of "what this command does".

Used by the approval card's plain-language view. It is **completely unrelated** to the
execution mode (request/auto) and to the security check's result: every ASKed call gets a
description generated before the approval is parked, so the toggle button always shows
up. Fail-safe: no llm / timeout / parse failure → return a list of empty strings of the
same length, the frontend falls back to showing the raw command, and approval is never
blocked.

One LLM call describes the whole batch of commands. It uses the main conversation model
(the same one as the classifier), but the prompt is short, the output is short, and it
does no security-policy reasoning, so it is usually faster than the classifier. The
timeout can be overridden with ``AMPHI_DESCRIBE_TIMEOUT``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, List

from bridgic.core.model.types import Message, Role

from ..amphi_service.i18n import backend_i18n

logger = logging.getLogger(__name__)

# Timeout (seconds) for a single describe call; a timeout is handled fail-safe (empty
# description, fall back to the raw command).
_TIMEOUT_SECONDS = float(os.environ.get("AMPHI_DESCRIBE_TIMEOUT", "30"))

def _build_prompt(items: List[dict]) -> str:
    """Assemble the dynamic pending-approval calls into an index-aligned USER prompt."""
    lines = [
        backend_i18n.text("agent.describe.pending_count", count=len(items)),
        backend_i18n.text("agent.describe.pending_heading"),
    ]
    for i, it in enumerate(items):
        lines.append(
            json.dumps(
                {"index": i, "tool": it.get("tool"), "arguments": it.get("arguments")},
                ensure_ascii=False,
            )
        )
    return "\n".join(lines)


def _parse(content: str, n: int) -> List[str]:
    """Parse ``[{"index", "summary"}]`` → n index-aligned descriptions; anything
    non-conforming → all empty strings."""
    text = (content or "").strip()
    data: Any = None
    if text:
        try:
            parsed = json.loads(text)
            data = parsed if isinstance(parsed, list) else None
        except (json.JSONDecodeError, ValueError):
            match = re.search(r"\[.*\]", text, re.S)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                    data = parsed if isinstance(parsed, list) else None
                except (json.JSONDecodeError, ValueError):
                    data = None
    if not isinstance(data, list) or len(data) != n:
        return [""] * n
    out = [""] * n
    for entry in data:
        if not isinstance(entry, dict):
            continue
        idx = entry.get("index")
        if isinstance(idx, int) and not isinstance(idx, bool) and 0 <= idx < n:
            out[idx] = str(entry.get("summary", "") or "")
    return out


async def describe_commands(llm: Any, items: List[dict]) -> List[str]:
    """Generate one plain-language description per pending-approval call; on failure
    return empty strings of the same length (the frontend falls back to the raw command).

    Each item of ``items`` is ``{"tool", "arguments"}``; returns a description list of the
    same length, aligned in order.
    """
    n = len(items)
    if n == 0:
        return []
    if llm is None:
        return [""] * n
    messages = [
        Message.from_text(backend_i18n.text("agent.describe.system_prompt"), role=Role.SYSTEM),
        Message.from_text(_build_prompt(items), role=Role.USER),
    ]
    try:
        raw = await asyncio.wait_for(llm.achat(messages), timeout=_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 — usability enhancement; any failure falls back to the command and never blocks approval
        logger.warning("[describe] failed to generate plain-language summaries (%s) items=%d: %s", type(exc).__name__, n, exc)
        return [""] * n
    content = raw if isinstance(raw, str) else (
        getattr(getattr(raw, "message", None), "content", "") or ""
    )
    if not isinstance(content, str):
        content = ""
    return _parse(content, n)
