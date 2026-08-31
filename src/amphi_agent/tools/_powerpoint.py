import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._powerpoint import PowerPointPageView, PowerPointWriteResult, SessionPowerPoint

_MAX_PAGE_MARKDOWN_BYTES = 64 * 1024


def _get_agent() -> Any:
    agent = current_agent.get(None)
    if agent is None:
        raise RuntimeError("PowerPoint tools can only run inside an agent turn")
    return agent


def _get_powerpoint() -> SessionPowerPoint:
    context = getattr(_get_agent(), "ctx", None)
    powerpoint = getattr(context, "powerpoint", None) if context is not None else None
    if powerpoint is None:
        raise RuntimeError("PowerPoint tools require an active Session PowerPoint")
    return powerpoint


def _workspace_root() -> Path:
    context = getattr(_get_agent(), "ctx", None)
    workspace = getattr(context, "workspace", None) if context is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    if work_dir is None:
        raise RuntimeError("PowerPoint file operations require an active Session workspace")
    return Path(work_dir).expanduser().resolve()


def _view_target(target: str) -> str:
    raw = str(target or "").strip()
    if not raw:
        raise ValueError("target is required")
    candidate = Path(raw).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (_workspace_root() / candidate).resolve()
    return str(resolved if resolved.suffix else resolved.with_suffix(".pptx"))


def _page_markdown(markdown: str) -> str:
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError("PowerPoint page Markdown must be a non-empty string")
    size = len(markdown.encode("utf-8"))
    if size > _MAX_PAGE_MARKDOWN_BYTES:
        raise ValueError(
            f"PowerPoint page Markdown is {size} bytes; the per-page limit is "
            f"{_MAX_PAGE_MARKDOWN_BYTES} bytes"
        )
    return markdown


def _format_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def _format_page(view: PowerPointPageView) -> str:
    page = view.page
    details = {
        "page_id": page.page_id,
        "index": page.index,
        "title": page.title,
        "assets": [asdict(asset) for asset in view.assets],
    }
    return f"PowerPoint page Markdown\n{_format_json(details)}\n\n{page.markdown}"


def _format_write(result: PowerPointWriteResult) -> str:
    payload: dict[str, Any] = {
        "status": result.status,
        "diagnostics": [asdict(item) for item in result.diagnostics],
    }
    if result.page is not None:
        payload["page"] = {
            "page_id": result.page.page_id,
            "index": result.page.index,
            "title": result.page.title,
        }
    return _format_json(payload)


async def view_ppt(target: str) -> str:
    """Open or create the Session's live PowerPoint before doing longer PPT work.

    A name or relative path resolves in the Session workspace; a missing suffix
    becomes `.pptx`. An absolute path is used directly. If the file exists the
    editor imports it; otherwise it creates an empty live PPT with that identity.
    This is the first tool for every PPT task because it immediately opens the
    PPT surface and shows Agent activity. The result includes deck metadata and
    ordered page summaries, but never returns every page's Markdown.
    """
    return _format_json(await _get_powerpoint().view_ppt(_view_target(target)))


async def get_ppt_page(page_id: str) -> str:
    """Read one live PPT page as canonical Markdown with its referenced assets.

    The editor decompiles its current native page model at call time, including
    user edits made through the UI. Read this before changing or removing an
    existing page; the Session internally remembers the version that was read.
    Asset entries expose paths only; use a file-reading tool separately when the
    asset itself must be inspected.
    """
    return _format_page(await _get_powerpoint().read_page(page_id))


async def update_ppt_page(page_id: str, markdown: str) -> str:
    """Atomically replace one existing page from compact semantic Markdown.

    Send exactly one logical page, not a full deck and not a Markdown code fence.
    Prefer headings, lists, images, tables, notes, and small layout/theme
    directives; do not emit coordinate-level PptShape/PptText trees. The page
    must have been read with `get_ppt_page` first. The Session supplies its
    private version token and rejects a stale write without mutating the page.
    """
    result = await _get_powerpoint().update_page(page_id, _page_markdown(markdown))
    return _format_write(result)


async def insert_ppt_page(markdown: str, after_page_id: Optional[str] = None) -> str:
    """Insert one semantic-Markdown page, optionally after a stable page id.

    Send one page only. Repeat this tool page by page for a new deck; independent
    insert calls may be prepared concurrently but structural commits are guarded
    against a changed page order. Invalid Markdown creates no partial page.
    """
    return _format_write(await _get_powerpoint().insert_page(
        _page_markdown(markdown),
        after_page_id=after_page_id,
    ))


async def remove_ppt_page(page_id: str) -> str:
    """Remove a page that was first read with `get_ppt_page`."""
    return _format_json(await _get_powerpoint().remove_page(page_id))


async def move_ppt_page(page_id: str, target_page_id: str, position: Literal["before", "after"]) -> str:
    """Move one stable page before or after another and return the new page order."""
    return _format_json(await _get_powerpoint().move_page(page_id, target_page_id, position))


async def goto_ppt_page(page_id: str) -> str:
    """Navigate the visible editor to one page without changing its content."""
    return _format_json(await _get_powerpoint().goto_page(page_id))


_TOOLS = (
    view_ppt,
    get_ppt_page,
    update_ppt_page,
    insert_ppt_page,
    remove_ppt_page,
    move_ppt_page,
    goto_ppt_page,
)

powerpoint_tool_specs = [FunctionToolSpec.from_raw(tool) for tool in _TOOLS]
POWERPOINT_TOOL_NAMES = frozenset(spec.tool_name for spec in powerpoint_tool_specs)

__all__ = [
    "POWERPOINT_TOOL_NAMES",
    "get_ppt_page",
    "goto_ppt_page",
    "insert_ppt_page",
    "move_ppt_page",
    "powerpoint_tool_specs",
    "remove_ppt_page",
    "update_ppt_page",
    "view_ppt",
]
