import os
from pathlib import Path
from typing import Dict, List, Literal, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._browser import SessionBrowser

_BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME = {
    "navigate_to": "browser_open",
    "search": "browser_search",
    "get_current_page_info": "browser_page_info",
    "reload_page": "browser_reload",
    "go_back": "browser_back",
    "go_forward": "browser_forward",
    "get_snapshot_text": "browser_snapshot",
    "click_element_by_ref": "browser_click",
    "input_text_by_ref": "browser_input",
    "fill_form": "browser_fill_form",
    "scroll_element_into_view_by_ref": "browser_scroll_to_ref",
    "select_dropdown_option_by_ref": "browser_select",
    "get_dropdown_options_by_ref": "browser_get_dropdown_options",
    "check_checkbox_or_radio_by_ref": "browser_check",
    "uncheck_checkbox_by_ref": "browser_uncheck",
    "focus_element_by_ref": "browser_focus",
    "hover_element_by_ref": "browser_hover",
    "double_click_element_by_ref": "browser_double_click",
    "upload_file_by_ref": "browser_upload_file",
    "drag_element_by_ref": "browser_drag",
    "get_tabs": "browser_tabs",
    "new_tab": "browser_new_tab",
    "switch_tab": "browser_switch_tab",
    "close_tab": "browser_close_tab",
    "evaluate_javascript": "browser_evaluate_javascript",
    "evaluate_javascript_on_ref": "browser_evaluate_javascript_on_ref",
    "press_key": "browser_key",
    "type_text": "browser_type_text",
    "key_down": "browser_key_down",
    "key_up": "browser_key_up",
    "mouse_wheel": "browser_scroll",
    "mouse_click": "browser_mouse_click",
    "mouse_move": "browser_mouse_move",
    "mouse_drag": "browser_mouse_drag",
    "mouse_down": "browser_mouse_down",
    "mouse_up": "browser_mouse_up",
    "wait_for": "browser_wait",
    "take_screenshot": "browser_screenshot",
    "save_pdf": "browser_save_pdf",
    "start_network_capture": "browser_start_network_capture",
    "get_network_requests": "browser_get_network_requests",
    "stop_network_capture": "browser_stop_network_capture",
    "wait_for_network_idle": "browser_wait_for_network_idle",
    "setup_dialog_handler": "browser_setup_dialog_handler",
    "handle_dialog": "browser_handle_dialog",
    "remove_dialog_handler": "browser_remove_dialog_handler",
    "get_cookies": "browser_get_cookies",
    "set_cookie": "browser_set_cookie",
    "clear_cookies": "browser_clear_cookies",
    "save_storage_state": "browser_save_storage_state",
    "restore_storage_state": "browser_restore_storage_state",
    "verify_text_visible": "browser_verify_text",
    "verify_element_visible": "browser_verify_role_visible",
    "verify_url": "browser_verify_url",
    "verify_title": "browser_verify_title",
    "verify_element_state": "browser_verify_state",
    "verify_value": "browser_verify_value",
    "start_console_capture": "browser_start_console_capture",
    "get_console_messages": "browser_get_console_messages",
    "stop_console_capture": "browser_stop_console_capture",
    "start_tracing": "browser_start_tracing",
    "add_trace_chunk": "browser_add_trace_chunk",
    "stop_tracing": "browser_stop_tracing",
    "start_video": "browser_start_video",
    "stop_video": "browser_stop_video",
    "close": "browser_close",
    "browser_resize": "browser_resize",
}

BROWSER_BASIC_TOOL_NAMES = frozenset({
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_input",
    "browser_back",
    "browser_scroll",
    "browser_key",
    "browser_close",
    "load_browser_tools",
})

_BROWSER_CONVENIENCE_ADVANCED_TOOL_NAMES = frozenset({
    "browser_scroll_to_text",
    "browser_verify_visible",
})

BROWSER_ADVANCED_TOOL_NAMES = (
    frozenset(_BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME.values())
    - BROWSER_BASIC_TOOL_NAMES
    | _BROWSER_CONVENIENCE_ADVANCED_TOOL_NAMES
)

BROWSER_TOOL_NAMES = BROWSER_BASIC_TOOL_NAMES | BROWSER_ADVANCED_TOOL_NAMES

_DEFAULT_SNAPSHOT_LIMIT = 10_000
_MAX_SNAPSHOT_LIMIT = 10_000
_MIN_SCROLL_AMOUNT = 1
_MAX_SCROLL_AMOUNT = 5_000
_REF_REQUIRED_MESSAGE = "ref is required — use a ref from the newest page snapshot"


def _get_browser() -> SessionBrowser:
    agent = current_agent.get(None)
    ctx = getattr(agent, "ctx", None) if agent is not None else None
    browser = getattr(ctx, "browser", None) if ctx is not None else None
    if browser is None:
        raise RuntimeError("browser tools require an active browser")
    return browser


def _resolve_browser_file_path(path: Optional[str]) -> Optional[str]:
    """Resolve relative browser file arguments against the Session workspace."""
    if path is None:
        return None
    raw = path.strip()
    if not raw:
        return raw
    agent = current_agent.get(None)
    ctx = getattr(agent, "ctx", None) if agent is not None else None
    workspace = getattr(ctx, "workspace", None) if ctx is not None else None
    work_dir = getattr(workspace, "work_dir", None) if workspace is not None else None
    if work_dir is None:
        return raw
    directory_hint = raw.endswith(("/", os.sep))
    candidate = Path(raw).expanduser()
    resolved = (
        candidate.resolve()
        if candidate.is_absolute()
        else (Path(work_dir) / candidate).resolve()
    )
    result = str(resolved)
    if directory_hint and not result.endswith(os.sep):
        result += os.sep
    return result


async def browser_close() -> str:
    """Close the browser and all tabs opened for the current conversation.

    Use this only when the user explicitly asks to close the browser.
    Do not call it proactively, for cleanup, or merely because a browser task
    has finished: it may contain pages the user wants to keep.

    The saved sign-in state and browsers belonging to other conversations are
    preserved. A later ``browser_open()`` opens a fresh browser for the current
    conversation.

    Returns:
        A short message describing whether a browser was closed.
    """
    closed = await _get_browser().close()
    if closed:
        return "Closed the browser."
    return "No browser is open."


def _clamp_snapshot_limit(limit: int) -> int:
    return max(1, min(int(limit), _MAX_SNAPSHOT_LIMIT))


def _clamp_scroll_amount(amount: int) -> int:
    return max(_MIN_SCROLL_AMOUNT, min(int(amount), _MAX_SCROLL_AMOUNT))


async def browser_open(url: str) -> str:
    """Open a URL in the browser.

    Use this as the entry point for browser tasks. The result includes the
    latest page snapshot, so use that state directly before clicking or typing.

    Args:
        url: The URL to navigate to.

    Returns:
        The navigation result followed by the latest page snapshot.
    """
    if not (url or "").strip():
        raise ValueError("url is required")
    browser = _get_browser()
    return await browser.invoke("navigate_to", url.strip())


async def browser_snapshot(
    interactive: bool = False,
    full_page: bool = True,
    limit: int = _DEFAULT_SNAPSHOT_LIMIT,
) -> str:
    """Get the current page accessibility tree.

    The returned text includes the page URL, title, and element tree. Element
    refs in ``[ref=...]`` markers identify elements for ref-based browser
    tools. Use refs from the newest returned snapshot—whether it came from
    ``browser_snapshot()``, ``browser_open()``, or another state-advancing
    browser action—because page changes can invalidate older refs. Set
    ``interactive=True`` to list only interactive elements. ``limit`` is the
    inline display budget and spill threshold; it does not reduce the captured
    page scope or make the underlying tree shorter. Results over that budget
    retain a bounded inline preview from the same capture, and retained overflow
    previews are capped at 10000 characters. If the newest automatic snapshot
    already reports a full-snapshot file, read or search that file; do not call
    this tool again merely to lower ``limit`` or filter the view.

    Args:
        interactive: When True, return only interactive elements.
        full_page: When True, include elements outside the viewport.
        limit: Inline character budget and spill threshold (1–10000, default
            10000). Lower values show less inline preview and spill sooner;
            retained overflow previews are capped at 10000 characters so they
            remain inline.

    Returns:
        The page accessibility snapshot as text. If it exceeds the limit, the
        full snapshot is saved in the current conversation's private tool results directory
        and the result retains a bounded inline preview from the same capture.
    """
    browser = _get_browser()
    return await browser.invoke(
        "get_snapshot_text",
        limit=_clamp_snapshot_limit(limit),
        interactive=interactive,
        full_page=full_page,
    )


async def browser_click(ref: str) -> str:
    """Click an element identified by a snapshot ref.

    The ``ref`` must come from the latest returned page snapshot. The click
    result includes a new snapshot of the resulting page state.

    Args:
        ref: Element ref from the newest returned page snapshot.

    Returns:
        The click outcome followed by the latest page snapshot.
    """
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("click_element_by_ref", ref.strip())


async def browser_input(
    ref: str,
    text: str,
    clear: bool = True,
    submit: bool = False,
    slowly: bool = False,
) -> str:
    """Type text into an input element identified by a snapshot ref.

    The ``ref`` must come from the latest returned page snapshot. The input
    result includes a new snapshot of the resulting page state.

    Args:
        ref: Element ref from the newest returned page snapshot.
        text: Text to enter.
        clear: When True (default), clear the field before typing.
        submit: When True, press Enter after typing.
        slowly: When True, emit per-character key events (for autocomplete UIs).

    Returns:
        The input outcome followed by the latest page snapshot.
    """
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke(
        "input_text_by_ref",
        ref=ref.strip(),
        text=text,
        clear=clear,
        submit=submit,
        slowly=slowly,
    )


async def browser_back() -> str:
    """Navigate back and return the resulting page's latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("go_back")


async def browser_scroll(
    direction: Literal["up", "down", "left", "right"] = "down",
    amount: int = 600,
) -> str:
    """Scroll the current page and return its latest snapshot.

    Args:
        direction: Scroll direction.
        amount: Scroll distance in pixels (1–5000, default 600).

    Returns:
        The scroll outcome followed by the latest page snapshot.
    """
    clamped = _clamp_scroll_amount(amount)
    delta_x = 0
    delta_y = 0
    if direction == "down":
        delta_y = clamped
    elif direction == "up":
        delta_y = -clamped
    elif direction == "right":
        delta_x = clamped
    elif direction == "left":
        delta_x = -clamped
    else:
        raise ValueError(
            f"direction must be one of up, down, left, right — got {direction!r}"
        )
    browser = _get_browser()
    return await browser.invoke("mouse_wheel", delta_x=delta_x, delta_y=delta_y)


async def browser_key(key: str) -> str:
    """Send a keyboard key to the focused page.

    Supports Playwright-style keys such as ``Enter``, ``Tab``, ``Escape``, and
    ``Control+A``.

    Args:
        key: The key or key combination to press.

    Returns:
        The key press outcome followed by the latest page snapshot.
    """
    if not (key or "").strip():
        raise ValueError("key is required")
    browser = _get_browser()
    return await browser.invoke("press_key", key.strip())


# ---------------------------------------------------------------------------
# Advanced browser tools (loaded on demand via load_browser_tools)
# ---------------------------------------------------------------------------

async def browser_forward() -> str:
    """Navigate forward and return the resulting page's latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("go_forward")


async def browser_reload(wait_until: str = "domcontentloaded") -> str:
    """Reload the current page and return its latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("reload_page", wait_until=wait_until)


async def browser_page_info() -> str:
    """Get the current page URL, title, viewport, and scroll position."""
    browser = _get_browser()
    return await browser.invoke("get_current_page_info")


async def browser_search(query: str, engine: str = "duckduckgo") -> str:
    """Search the web and return the results page's latest snapshot."""
    if not (query or "").strip():
        raise ValueError("query is required")
    browser = _get_browser()
    return await browser.invoke("search", query.strip(), engine=engine)


async def browser_tabs() -> str:
    """List the browser tabs opened for the current conversation."""
    browser = _get_browser()
    return await browser.invoke("get_tabs")


async def browser_new_tab(url: str = "") -> str:
    """Open a tab and return the new tab's latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("new_tab", url=url.strip() or None)


async def browser_switch_tab(page_id: str) -> str:
    """Switch tabs by page_id and return the selected tab's latest snapshot."""
    if not (page_id or "").strip():
        raise ValueError("page_id is required — call browser_tabs() first")
    browser = _get_browser()
    return await browser.invoke("switch_tab", page_id.strip())


async def browser_close_tab(page_id: str = "") -> str:
    """Close a tab and return the resulting active tab's latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("close_tab", page_id.strip() or None)


async def browser_wait(
    text: str = "",
    selector: str = "",
    time_seconds: float = 0,
    timeout: float = 30.0,
) -> str:
    """Wait for time, text, or a selector and return the latest snapshot."""
    browser = _get_browser()
    return await browser.invoke(
        "wait_for",
        time_seconds=time_seconds or None,
        text=text or None,
        selector=selector or None,
        timeout=timeout,
    )


async def browser_wait_for_network_idle(timeout: float = 30.0) -> str:
    """Wait until network activity is idle and return the latest snapshot."""
    browser = _get_browser()
    return await browser.invoke("wait_for_network_idle", timeout=timeout)


async def browser_screenshot(
    filename: str = "",
    ref: str = "",
    full_page: bool = False,
) -> str:
    """Capture a screenshot of the page or a snapshot ref element."""
    browser = _get_browser()
    return await browser.invoke(
        "take_screenshot",
        filename=_resolve_browser_file_path(filename) or None,
        ref=ref.strip() or None,
        full_page=full_page,
    )


async def browser_verify_text(text: str, exact: bool = False, timeout: float = 5.0) -> str:
    """Verify that text is visible on the current page."""
    if not (text or "").strip():
        raise ValueError("text is required")
    browser = _get_browser()
    return await browser.invoke(
        "verify_text_visible", text.strip(), exact=exact, timeout=timeout,
    )


async def browser_verify_visible(ref: str) -> str:
    """Verify that a snapshot ref element is visible."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("verify_element_state", ref.strip(), "visible")


async def browser_verify_url(expected_url: str, exact: bool = False) -> str:
    """Verify the current page URL."""
    if not (expected_url or "").strip():
        raise ValueError("expected_url is required")
    browser = _get_browser()
    return await browser.invoke("verify_url", expected_url.strip(), exact=exact)


async def browser_verify_title(expected_title: str, exact: bool = False) -> str:
    """Verify the current page title."""
    if not (expected_title or "").strip():
        raise ValueError("expected_title is required")
    browser = _get_browser()
    return await browser.invoke("verify_title", expected_title.strip(), exact=exact)


async def browser_scroll_to_text(text: str) -> str:
    """Scroll until the given text is visible and return the latest snapshot."""
    if not (text or "").strip():
        raise ValueError("text is required")
    browser = _get_browser()
    return await browser.invoke("scroll_to_text", text.strip())


async def browser_hover(ref: str) -> str:
    """Hover over a snapshot ref element and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("hover_element_by_ref", ref.strip())


async def browser_focus(ref: str) -> str:
    """Focus a snapshot ref element and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("focus_element_by_ref", ref.strip())


async def browser_select(ref: str, text: str) -> str:
    """Select a dropdown option and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    if not (text or "").strip():
        raise ValueError("text is required")
    browser = _get_browser()
    return await browser.invoke("select_dropdown_option_by_ref", ref.strip(), text.strip())


async def browser_check(ref: str) -> str:
    """Check a checkbox or radio button and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("check_checkbox_or_radio_by_ref", ref.strip())


async def browser_uncheck(ref: str) -> str:
    """Uncheck a checkbox and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    browser = _get_browser()
    return await browser.invoke("uncheck_checkbox_by_ref", ref.strip())


async def browser_fill_form(
    fields: List[Dict[str, str]],
    submit: bool = False,
) -> str:
    """Fill multiple fields by snapshot ref and return the latest snapshot.

    Each item must contain ``ref`` and ``value``. Use ``browser_input`` when
    one field needs slow typing or other per-field behavior.
    """
    if not fields:
        raise ValueError("fields must contain at least one field")
    normalized: List[Dict[str, str]] = []
    for index, field in enumerate(fields):
        ref = str(field.get("ref") or "").strip()
        if not ref:
            raise ValueError(f"fields[{index}].ref is required")
        if "value" not in field:
            raise ValueError(f"fields[{index}].value is required")
        normalized.append({"ref": ref, "value": str(field["value"])})
    return await _get_browser().invoke("fill_form", normalized, submit=submit)


async def browser_scroll_to_ref(ref: str) -> str:
    """Scroll a snapshot ref element into view and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    return await _get_browser().invoke("scroll_element_into_view_by_ref", ref.strip())


async def browser_get_dropdown_options(ref: str) -> str:
    """List the available options for a dropdown identified by snapshot ref."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    return await _get_browser().invoke("get_dropdown_options_by_ref", ref.strip())


async def browser_double_click(ref: str) -> str:
    """Double-click a snapshot ref element and return the latest snapshot."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    return await _get_browser().invoke("double_click_element_by_ref", ref.strip())


async def browser_upload_file(ref: str, file_path: str) -> str:
    """Upload a local file through a file-input ref and return the latest snapshot.

    This reads ``file_path`` and makes its contents available to the current
    page. Use only when the user has asked to upload that file.
    """
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    if not (file_path or "").strip():
        raise ValueError("file_path is required")
    return await _get_browser().invoke(
        "upload_file_by_ref",
        ref.strip(),
        _resolve_browser_file_path(file_path),
    )


async def browser_drag(start_ref: str, end_ref: str) -> str:
    """Drag one snapshot ref element onto another and return the latest snapshot."""
    if not (start_ref or "").strip():
        raise ValueError("start_ref is required — use a ref from the newest page snapshot")
    if not (end_ref or "").strip():
        raise ValueError("end_ref is required — use a ref from the newest page snapshot")
    return await _get_browser().invoke(
        "drag_element_by_ref",
        start_ref.strip(),
        end_ref.strip(),
    )


async def browser_evaluate_javascript(code: str) -> str:
    """Execute trusted JavaScript in the current page and return its result.

    ``code`` should be an arrow function such as ``() => document.title``.
    JavaScript can mutate the page, so the result includes the latest snapshot.
    """
    if not (code or "").strip():
        raise ValueError("code is required")
    return await _get_browser().invoke("evaluate_javascript", code)


async def browser_evaluate_javascript_on_ref(ref: str, code: str) -> str:
    """Execute trusted JavaScript with a snapshot ref element as its argument.

    ``code`` should be an arrow function such as ``el => el.textContent``.
    The result includes the latest page snapshot because the code may mutate it.
    """
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    if not (code or "").strip():
        raise ValueError("code is required")
    return await _get_browser().invoke(
        "evaluate_javascript_on_ref",
        ref.strip(),
        code,
    )


async def browser_type_text(text: str, submit: bool = False) -> str:
    """Type into the focused element character by character and return a snapshot."""
    return await _get_browser().invoke("type_text", text, submit=submit)


async def browser_key_down(key: str) -> str:
    """Press and hold a keyboard key; pair it with ``browser_key_up``."""
    if not (key or "").strip():
        raise ValueError("key is required")
    return await _get_browser().invoke("key_down", key.strip())


async def browser_key_up(key: str) -> str:
    """Release a keyboard key previously held with ``browser_key_down``."""
    if not (key or "").strip():
        raise ValueError("key is required")
    return await _get_browser().invoke("key_up", key.strip())


async def browser_mouse_click(
    x: float,
    y: float,
    button: Literal["left", "right", "middle"] = "left",
    click_count: int = 1,
) -> str:
    """Click viewport coordinates and return the latest page snapshot."""
    return await _get_browser().invoke(
        "mouse_click",
        x,
        y,
        button=button,
        click_count=click_count,
    )


async def browser_mouse_move(x: float, y: float) -> str:
    """Move the mouse to viewport coordinates and return the latest snapshot."""
    return await _get_browser().invoke("mouse_move", x, y)


async def browser_mouse_drag(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
) -> str:
    """Drag between viewport coordinates and return the latest page snapshot."""
    return await _get_browser().invoke(
        "mouse_drag",
        start_x,
        start_y,
        end_x,
        end_y,
    )


async def browser_mouse_down(
    button: Literal["left", "right", "middle"] = "left",
) -> str:
    """Press and hold a mouse button; pair it with ``browser_mouse_up``."""
    return await _get_browser().invoke("mouse_down", button=button)


async def browser_mouse_up(
    button: Literal["left", "right", "middle"] = "left",
) -> str:
    """Release a mouse button previously held with ``browser_mouse_down``."""
    return await _get_browser().invoke("mouse_up", button=button)


async def browser_save_pdf(
    filename: Optional[str] = None,
    display_header_footer: bool = False,
    print_background: bool = True,
    scale: float = 1.0,
    paper_width: Optional[str] = None,
    paper_height: Optional[str] = None,
    margin_top: Optional[str] = None,
    margin_bottom: Optional[str] = None,
    margin_left: Optional[str] = None,
    margin_right: Optional[str] = None,
    landscape: bool = False,
) -> str:
    """Save the current page as a PDF and return the output path."""
    return await _get_browser().invoke(
        "save_pdf",
        filename=_resolve_browser_file_path(filename),
        display_header_footer=display_header_footer,
        print_background=print_background,
        scale=scale,
        paper_width=paper_width,
        paper_height=paper_height,
        margin_top=margin_top,
        margin_bottom=margin_bottom,
        margin_left=margin_left,
        margin_right=margin_right,
        landscape=landscape,
    )


async def browser_start_network_capture() -> str:
    """Start capturing requests from the current page."""
    return await _get_browser().invoke("start_network_capture")


async def browser_get_network_requests(
    include_static: bool = False,
    clear: bool = True,
) -> str:
    """Return captured network requests as JSON.

    Start capture before the activity of interest. By default, static assets
    are omitted and the captured buffer is cleared after reading.
    """
    return await _get_browser().invoke(
        "get_network_requests",
        include_static=include_static,
        clear=clear,
    )


async def browser_stop_network_capture() -> str:
    """Stop capturing network requests and clear the capture resources."""
    return await _get_browser().invoke("stop_network_capture")


async def browser_setup_dialog_handler(
    default_action: Literal["accept", "dismiss"] = "accept",
    default_prompt_text: Optional[str] = None,
) -> str:
    """Automatically accept or dismiss future JavaScript dialogs on this page."""
    return await _get_browser().invoke(
        "setup_dialog_handler",
        default_action=default_action,
        default_prompt_text=default_prompt_text,
    )


async def browser_handle_dialog(
    accept: bool,
    prompt_text: Optional[str] = None,
) -> str:
    """Prepare a one-time handler for the next JavaScript dialog.

    This call installs the handler; it does not wait for a dialog to appear.
    """
    return await _get_browser().invoke(
        "handle_dialog",
        accept=accept,
        prompt_text=prompt_text,
    )


async def browser_remove_dialog_handler() -> str:
    """Remove the automatic JavaScript dialog handler from the current page."""
    return await _get_browser().invoke("remove_dialog_handler")


async def browser_get_cookies(
    urls: Optional[List[str]] = None,
    name: Optional[str] = None,
    domain: Optional[str] = None,
    path: Optional[str] = None,
) -> str:
    """Return matching browser cookies as JSON.

    Cookies can contain authentication secrets. Use this only when cookie
    inspection is necessary for the user's request and do not reveal values.
    """
    return await _get_browser().invoke(
        "get_cookies",
        urls=urls,
        name=name,
        domain=domain,
        path=path,
    )


async def browser_set_cookie(
    name: str,
    value: str,
    url: Optional[str] = None,
    domain: Optional[str] = None,
    path: str = "/",
    expires: Optional[float] = None,
    http_only: bool = False,
    secure: bool = False,
    same_site: Optional[str] = None,
) -> str:
    """Set a cookie in the browser context."""
    if not (name or "").strip():
        raise ValueError("name is required")
    return await _get_browser().invoke(
        "set_cookie",
        name=name.strip(),
        value=value,
        url=url,
        domain=domain,
        path=path,
        expires=expires,
        http_only=http_only,
        secure=secure,
        same_site=same_site,
    )


async def browser_clear_cookies(
    name: Optional[str] = None,
    domain: Optional[str] = None,
    path: Optional[str] = None,
) -> str:
    """Clear matching cookies, or all cookies when no filter is provided."""
    return await _get_browser().invoke(
        "clear_cookies",
        name=name,
        domain=domain,
        path=path,
    )


async def browser_save_storage_state(filename: Optional[str] = None) -> str:
    """Save cookies and local storage to a JSON file and return its path.

    The output may contain authentication secrets. Do not expose its contents.
    """
    return await _get_browser().invoke(
        "save_storage_state",
        filename=_resolve_browser_file_path(filename),
    )


async def browser_restore_storage_state(filename: str) -> str:
    """Restore cookies and local storage from a local JSON state file."""
    if not (filename or "").strip():
        raise ValueError("filename is required")
    return await _get_browser().invoke(
        "restore_storage_state",
        _resolve_browser_file_path(filename),
    )


async def browser_verify_role_visible(
    role: str,
    accessible_name: str,
    timeout: float = 5.0,
) -> str:
    """Verify that an element identified by ARIA role and name is visible."""
    if not (role or "").strip():
        raise ValueError("role is required")
    if not (accessible_name or "").strip():
        raise ValueError("accessible_name is required")
    return await _get_browser().invoke(
        "verify_element_visible",
        role.strip(),
        accessible_name.strip(),
        timeout=timeout,
    )


async def browser_verify_state(
    ref: str,
    state: Literal[
        "visible",
        "hidden",
        "enabled",
        "disabled",
        "checked",
        "unchecked",
    ],
) -> str:
    """Verify a snapshot ref element's visible, enabled, or checked state."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    return await _get_browser().invoke("verify_element_state", ref.strip(), state)


async def browser_verify_value(
    ref: str,
    value: str,
    attribute: str = "value",
) -> str:
    """Verify that a snapshot ref element has an expected value or attribute."""
    if not (ref or "").strip():
        raise ValueError(_REF_REQUIRED_MESSAGE)
    if not (attribute or "").strip():
        raise ValueError("attribute is required")
    return await _get_browser().invoke(
        "verify_value",
        ref.strip(),
        value,
        attribute=attribute.strip(),
    )


async def browser_start_console_capture() -> str:
    """Start capturing console messages from the current page."""
    return await _get_browser().invoke("start_console_capture")


async def browser_get_console_messages(
    type_filter: Optional[
        Literal["log", "debug", "info", "error", "warning", "dir", "trace"]
    ] = None,
    clear: bool = True,
) -> str:
    """Return captured console messages as JSON.

    Start capture before the activity of interest. The buffer is cleared after
    reading by default.
    """
    return await _get_browser().invoke(
        "get_console_messages",
        type_filter=type_filter,
        clear=clear,
    )


async def browser_stop_console_capture() -> str:
    """Stop console capture and clear its resources."""
    return await _get_browser().invoke("stop_console_capture")


async def browser_start_tracing(
    screenshots: bool = True,
    snapshots: bool = True,
    sources: bool = False,
) -> str:
    """Start browser tracing for later export as a trace archive."""
    return await _get_browser().invoke(
        "start_tracing",
        screenshots=screenshots,
        snapshots=snapshots,
        sources=sources,
    )


async def browser_add_trace_chunk(title: Optional[str] = None) -> str:
    """Start a new named chunk in the active browser trace."""
    return await _get_browser().invoke("add_trace_chunk", title=title)


async def browser_stop_tracing(filename: Optional[str] = None) -> str:
    """Stop browser tracing, save its ZIP archive, and return the output path."""
    return await _get_browser().invoke(
        "stop_tracing",
        filename=_resolve_browser_file_path(filename),
    )


async def browser_start_video(
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> str:
    """Start recording the active browser tab to a single video stream."""
    return await _get_browser().invoke("start_video", width=width, height=height)


async def browser_stop_video(filename: Optional[str] = None) -> str:
    """Stop browser video recording and return the saved WebM path."""
    return await _get_browser().invoke(
        "stop_video",
        filename=_resolve_browser_file_path(filename),
    )


async def browser_resize(width: int, height: int) -> str:
    """Resize the browser viewport and return the latest page snapshot."""
    return await _get_browser().invoke("browser_resize", width, height)


_LOADED_ADVANCED_HINTS = (
    "- State-advancing browser tools return the latest page snapshot automatically; "
    "use it directly instead of calling browser_snapshot after every action.\n"
    "- If that snapshot reports a full-snapshot file, use its inline refs or inspect "
    "the file before recapturing the page; lowering limit only spills sooner.\n"
    "- Navigation, tabs, waits, screenshots, PDF, and viewport resizing.\n"
    "- Rich element, keyboard, coordinate-mouse, form, upload, and drag actions.\n"
    "- Trusted page JavaScript, network/console capture, dialogs, and verification.\n"
    "- Cookies, storage state, tracing, and video recording.\n"
)


async def load_browser_tools() -> str:
    """Load advanced browser tools into the next reasoning step.

    Call this whenever the basic tools cannot express the required browser
    action. This exposes all Bridgic Browser catalog operations through the
    existing Amphi adapters and advanced tools, plus Amphi's convenience tools,
    on the next observe-think-act round rather than the same model turn as this
    call.
    """
    agent = current_agent.get(None)
    ota_ctx = getattr(agent, "ota_ctx", None) if agent is not None else None
    if ota_ctx is None:
        raise RuntimeError("load_browser_tools can only run inside an agent turn.")
    ota_ctx.browser_tool_loaded = True
    return (
        "Advanced browser tools are loaded for the next reasoning step.\n\n"
        "New browser tools include:\n"
        + _LOADED_ADVANCED_HINTS
        + "\nContinue with the next reasoning step to call them."
    )


browser_tool_specs = [
    FunctionToolSpec.from_raw(tool)
    for tool in (
        browser_open,
        browser_snapshot,
        browser_click,
        browser_input,
        browser_back,
        browser_scroll,
        browser_key,
        browser_close,
        load_browser_tools,
        browser_forward,
        browser_reload,
        browser_page_info,
        browser_search,
        browser_tabs,
        browser_new_tab,
        browser_switch_tab,
        browser_close_tab,
        browser_wait,
        browser_wait_for_network_idle,
        browser_screenshot,
        browser_verify_text,
        browser_verify_visible,
        browser_verify_url,
        browser_verify_title,
        browser_scroll_to_text,
        browser_hover,
        browser_focus,
        browser_select,
        browser_check,
        browser_uncheck,
        browser_fill_form,
        browser_scroll_to_ref,
        browser_get_dropdown_options,
        browser_double_click,
        browser_upload_file,
        browser_drag,
        browser_evaluate_javascript,
        browser_evaluate_javascript_on_ref,
        browser_type_text,
        browser_key_down,
        browser_key_up,
        browser_mouse_click,
        browser_mouse_move,
        browser_mouse_drag,
        browser_mouse_down,
        browser_mouse_up,
        browser_save_pdf,
        browser_start_network_capture,
        browser_get_network_requests,
        browser_stop_network_capture,
        browser_setup_dialog_handler,
        browser_handle_dialog,
        browser_remove_dialog_handler,
        browser_get_cookies,
        browser_set_cookie,
        browser_clear_cookies,
        browser_save_storage_state,
        browser_restore_storage_state,
        browser_verify_role_visible,
        browser_verify_state,
        browser_verify_value,
        browser_start_console_capture,
        browser_get_console_messages,
        browser_stop_console_capture,
        browser_start_tracing,
        browser_add_trace_chunk,
        browser_stop_tracing,
        browser_start_video,
        browser_stop_video,
        browser_resize,
    )
]

__all__ = [
    "BROWSER_BASIC_TOOL_NAMES",
    "BROWSER_ADVANCED_TOOL_NAMES",
    "BROWSER_TOOL_NAMES",
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_input",
    "browser_back",
    "browser_scroll",
    "browser_key",
    "browser_close",
    "browser_forward",
    "browser_reload",
    "browser_page_info",
    "browser_search",
    "browser_tabs",
    "browser_new_tab",
    "browser_switch_tab",
    "browser_close_tab",
    "browser_wait",
    "browser_wait_for_network_idle",
    "browser_screenshot",
    "browser_verify_text",
    "browser_verify_visible",
    "browser_verify_url",
    "browser_verify_title",
    "browser_scroll_to_text",
    "browser_hover",
    "browser_focus",
    "browser_select",
    "browser_check",
    "browser_uncheck",
    "browser_fill_form",
    "browser_scroll_to_ref",
    "browser_get_dropdown_options",
    "browser_double_click",
    "browser_upload_file",
    "browser_drag",
    "browser_evaluate_javascript",
    "browser_evaluate_javascript_on_ref",
    "browser_type_text",
    "browser_key_down",
    "browser_key_up",
    "browser_mouse_click",
    "browser_mouse_move",
    "browser_mouse_drag",
    "browser_mouse_down",
    "browser_mouse_up",
    "browser_save_pdf",
    "browser_start_network_capture",
    "browser_get_network_requests",
    "browser_stop_network_capture",
    "browser_setup_dialog_handler",
    "browser_handle_dialog",
    "browser_remove_dialog_handler",
    "browser_get_cookies",
    "browser_set_cookie",
    "browser_clear_cookies",
    "browser_save_storage_state",
    "browser_restore_storage_state",
    "browser_verify_role_visible",
    "browser_verify_state",
    "browser_verify_value",
    "browser_start_console_capture",
    "browser_get_console_messages",
    "browser_stop_console_capture",
    "browser_start_tracing",
    "browser_add_trace_chunk",
    "browser_stop_tracing",
    "browser_start_video",
    "browser_stop_video",
    "browser_resize",
    "load_browser_tools",
    "browser_tool_specs",
]
