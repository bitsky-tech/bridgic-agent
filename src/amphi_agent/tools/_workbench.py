"""Shared plumbing for the App's embedded Univer workbenches.

Both workbenches — the spreadsheet and the document — are ordinary pages inside
the Session's embedded browser, so they appear in the same right-side dock as
any other page the agent opens and a person can edit them directly. Opening one
and waiting for it to become usable is identical either way; only what the
bridge then offers differs, which is why the tools themselves are separate.
"""

import asyncio
from typing import Optional
from urllib.parse import quote

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


async def workbench_status(browser: SessionBrowser) -> dict:
    """Ask the open workbench what it currently holds."""
    status = await browser.call_workbench_bridge("status")
    if not isinstance(status, dict):
        raise RuntimeError("The workbench page returned an unreadable status")
    return status


async def open_workbench(kind: str, name: str, language: str) -> dict:
    """Navigate this Session to one workbench page and wait until it is usable."""
    browser = get_workbench_browser()
    page_url = browser.workbench_page_url(kind)
    lang = "zh" if str(language).lower().startswith("zh") else "en"
    title = quote((name or "").strip() or "Untitled", safe="")
    # The navigation result carries a page snapshot that is meaningless for a
    # canvas-rendered workbench, so the caller reports its own status instead.
    await browser.invoke("navigate_to", f"{page_url}?lang={lang}&name={title}")
    return await _await_ready(browser)


async def _await_ready(browser: SessionBrowser) -> dict:
    """Poll the freshly navigated page until its document exists."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _READY_TIMEOUT_SECONDS
    last_error: Optional[str] = None
    while loop.time() < deadline:
        try:
            status = await workbench_status(browser)
        except RuntimeError as exc:
            last_error = str(exc)
        else:
            if status.get("ready"):
                return status
            last_error = "the workbench has not finished loading"
        await asyncio.sleep(_READY_POLL_SECONDS)
    raise RuntimeError(f"The workbench page did not become ready: {last_error}")


__all__ = ["get_workbench_browser", "open_workbench", "workbench_status"]
