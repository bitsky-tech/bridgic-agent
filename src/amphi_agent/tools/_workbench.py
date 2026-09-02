"""Shared plumbing for the App's embedded Univer workbenches.

Each workbench — the spreadsheet and the document — owns its own position in the
Session's right-side dock, backed by its own page, so a person can work in one
while the agent works in the other. Opening one and waiting for it to become
usable is identical either way; only what the bridge then offers differs, which
is why the tools themselves are separate.
"""

import asyncio
from typing import Optional

from bridgic.amphibious.builtin_tools import current_agent

from .._browser import SessionBrowser

_READY_TIMEOUT_SECONDS = 30.0
_READY_POLL_SECONDS = 0.5


def get_workbench_browser() -> SessionBrowser:
    """Return this Session's browser, or say what is missing."""
    agent = current_agent.get(None)
    ctx = getattr(agent, "ctx", None) if agent is not None else None
    browser = getattr(ctx, "browser", None) if ctx is not None else None
    if browser is None:
        raise RuntimeError("workbench tools require an active Session browser")
    return browser


async def workbench_status(kind: str) -> dict:
    """Ask one open workbench what it currently holds."""
    status = await get_workbench_browser().call_workbench_bridge(kind, "status")
    if not isinstance(status, dict):
        raise RuntimeError("The workbench page returned an unreadable status")
    return status


async def open_workbench(kind: str, name: str, language: str) -> dict:
    """Open one workbench in this Session's dock and wait until it is usable.

    Opening does not present it. The person decides what the dock shows, so a
    workbook prepared for a Session they are not watching stays in the
    background until they select its dock position.
    """
    browser = get_workbench_browser()
    await browser.open_workbench(
        kind,
        language="zh" if str(language).lower().startswith("zh") else "en",
        name=(name or "").strip() or "Untitled",
    )
    return await _await_ready(kind)


async def _await_ready(kind: str) -> dict:
    """Poll the freshly opened page until its document exists."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _READY_TIMEOUT_SECONDS
    last_error: Optional[str] = None
    while loop.time() < deadline:
        try:
            status = await workbench_status(kind)
        except RuntimeError as exc:
            last_error = str(exc)
        else:
            if status.get("ready"):
                return status
            last_error = "the workbench has not finished loading"
        await asyncio.sleep(_READY_POLL_SECONDS)
    raise RuntimeError(f"The workbench page did not become ready: {last_error}")


__all__ = ["get_workbench_browser", "open_workbench", "workbench_status"]
