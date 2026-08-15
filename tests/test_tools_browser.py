"""Unit coverage for browser tool schemas, validation, and Session delegation."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from bridgic.amphibious.builtin_tools import current_agent
from bridgic.browser._cli_catalog import (
    CLI_ALL_COMMANDS,
    CLI_COMMAND_TO_TOOL_METHOD,
    CLI_NON_TOOL_COMMANDS,
)

from src.amphi_agent._context import AmphiOTAContext
from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent.tools import (
    BROWSER_ADVANCED_TOOL_NAMES,
    BROWSER_BASIC_TOOL_NAMES,
    BROWSER_TOOL_NAMES,
    browser_tool_specs,
)
from src.amphi_agent.tools import _browser as browser_mod


BrowserTool = Callable[..., Awaitable[str]]


class _FakeSessionBrowser:
    """Record the narrow SessionBrowser surface consumed by browser tools."""

    def __init__(self) -> None:
        self.invoke_calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.close_calls = 0
        self.close_result = True

    async def invoke(self, method_name: str, *args: Any, **kwargs: Any) -> str:
        self.invoke_calls.append((method_name, args, kwargs))
        return f"invoked {method_name}"

    async def close(self) -> bool:
        self.close_calls += 1
        return self.close_result


@pytest.fixture
def session_browser() -> Iterator[_FakeSessionBrowser]:
    """Bind one fake exact-Session browser to the current Agent context."""
    browser = _FakeSessionBrowser()
    token = current_agent.set(SimpleNamespace(ctx=SimpleNamespace(browser=browser)))
    try:
        yield browser
    finally:
        current_agent.reset(token)


def test_browser_tool_names_and_library_registration() -> None:
    spec_names = {spec.tool_name for spec in browser_tool_specs}
    assert BROWSER_TOOL_NAMES == BROWSER_BASIC_TOOL_NAMES | BROWSER_ADVANCED_TOOL_NAMES
    assert spec_names == BROWSER_TOOL_NAMES
    library_names = {spec.tool_name for spec in TOOL_LIBRARY.all()}
    assert BROWSER_TOOL_NAMES <= library_names
    assert "load_browser_tools" in library_names


def test_every_bridgic_browser_catalog_command_is_exposed() -> None:
    catalog_commands = [
        command for command in CLI_ALL_COMMANDS
        if command not in CLI_NON_TOOL_COMMANDS
    ]
    catalog_methods = [CLI_COMMAND_TO_TOOL_METHOD[command] for command in catalog_commands]
    method_to_tool = browser_mod._BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME

    assert len(catalog_commands) == len(catalog_methods)
    assert len(catalog_methods) == len(set(catalog_methods))
    assert set(method_to_tool) == set(catalog_methods)
    assert len(method_to_tool) == len(catalog_commands)
    assert set(method_to_tool.values()) <= BROWSER_TOOL_NAMES


def test_browser_basic_and_advanced_sets() -> None:
    assert len(BROWSER_BASIC_TOOL_NAMES) == 9
    expected_advanced = (
        set(browser_mod._BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME.values())
        - BROWSER_BASIC_TOOL_NAMES
        | {"browser_scroll_to_text", "browser_verify_visible"}
    )
    assert BROWSER_ADVANCED_TOOL_NAMES == expected_advanced
    assert BROWSER_BASIC_TOOL_NAMES.isdisjoint(BROWSER_ADVANCED_TOOL_NAMES)


def test_tool_library_browser_queries() -> None:
    basic = {spec.tool_name for spec in TOOL_LIBRARY.get_browser_basic_tools()}
    advanced = {spec.tool_name for spec in TOOL_LIBRARY.get_browser_advanced_tools()}
    assert basic == BROWSER_BASIC_TOOL_NAMES
    assert advanced == BROWSER_ADVANCED_TOOL_NAMES
    assert {
        spec.tool_name for spec in TOOL_LIBRARY.get_browser_tools()
    } == BROWSER_BASIC_TOOL_NAMES
    assert {
        spec.tool_name
        for spec in TOOL_LIBRARY.get_browser_tools(include_advanced=True)
    } == BROWSER_TOOL_NAMES


def test_browser_tool_schemas() -> None:
    by_name = {spec.tool_name: spec for spec in browser_tool_specs}

    def description(name: str) -> str:
        # FunctionToolSpec preserves docstring line wrapping. Normalize whitespace
        # so these assertions protect model-facing meaning rather than source layout.
        return " ".join(by_name[name].tool_description.split())

    assert set(browser_mod._BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME.values()) <= set(by_name)

    assert "url" in by_name["browser_open"].tool_parameters["properties"]
    assert "ref" in by_name["browser_click"].tool_parameters["properties"]
    input_props = by_name["browser_input"].tool_parameters["properties"]
    assert {"ref", "text", "clear"} <= set(input_props)
    assert "is_secret" not in input_props
    scroll_props = by_name["browser_scroll"].tool_parameters["properties"]
    assert {"direction", "amount"} <= set(scroll_props)
    assert "key" in by_name["browser_key"].tool_parameters["properties"]
    assert by_name["browser_close"].tool_parameters["properties"] == {}
    close_description = description("browser_close")
    assert "only when the user explicitly asks" in close_description
    assert "Do not call it proactively" in close_description
    assert "Session browser" not in close_description
    assert "shared window" not in close_description
    assert "shared login state" not in close_description
    assert "session browser" not in description("browser_open").lower()
    snapshot_description = description("browser_snapshot")
    assert "inline display budget and spill threshold" in snapshot_description
    assert "does not reduce the captured page scope" in snapshot_description
    assert "bounded inline preview from the same capture" in snapshot_description
    assert "do not call this tool again merely to lower" in snapshot_description
    assert "overflow previews are capped at 10000 characters" in snapshot_description
    for name in ("browser_click", "browser_input"):
        assert "latest returned page snapshot" in description(name)
    for name in (
        "browser_forward",
        "browser_reload",
        "browser_search",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
        "browser_wait",
        "browser_wait_for_network_idle",
        "browser_scroll_to_text",
        "browser_hover",
        "browser_focus",
        "browser_select",
        "browser_check",
        "browser_uncheck",
    ):
        assert "snapshot" in description(name)

    fill_schema = by_name["browser_fill_form"].tool_parameters
    assert fill_schema["required"] == ["fields"]
    assert fill_schema["properties"]["fields"]["type"] == "array"
    assert by_name["browser_evaluate_javascript"].tool_parameters["required"] == ["code"]
    assert by_name["browser_mouse_click"].tool_parameters["properties"]["button"][
        "enum"
    ] == ["left", "right", "middle"]
    assert {
        "filename",
        "display_header_footer",
        "print_background",
        "scale",
        "landscape",
    } <= set(by_name["browser_save_pdf"].tool_parameters["properties"])
    assert by_name["browser_set_cookie"].tool_parameters["required"] == [
        "name",
        "value",
    ]
    assert by_name["browser_verify_state"].tool_parameters["properties"]["state"][
        "enum"
    ] == ["visible", "hidden", "enabled", "disabled", "checked", "unchecked"]


_DELEGATION_CASES: list[
    tuple[
        str,
        BrowserTool,
        tuple[Any, ...],
        dict[str, Any],
        str,
        tuple[Any, ...],
        dict[str, Any],
    ]
] = [
    (
        "open",
        browser_mod.browser_open,
        ("  https://example.com  ",),
        {},
        "navigate_to",
        ("https://example.com",),
        {},
    ),
    (
        "snapshot",
        browser_mod.browser_snapshot,
        (),
        {"interactive": True, "full_page": False, "limit": 500},
        "get_snapshot_text",
        (),
        {"limit": 500, "interactive": True, "full_page": False},
    ),
    (
        "click",
        browser_mod.browser_click,
        ("  ref-click  ",),
        {},
        "click_element_by_ref",
        ("ref-click",),
        {},
    ),
    (
        "input",
        browser_mod.browser_input,
        (),
        {
            "ref": "  ref-input  ",
            "text": "hello",
            "clear": False,
            "submit": True,
            "slowly": True,
        },
        "input_text_by_ref",
        (),
        {
            "ref": "ref-input",
            "text": "hello",
            "clear": False,
            "submit": True,
            "slowly": True,
        },
    ),
    ("back", browser_mod.browser_back, (), {}, "go_back", (), {}),
    (
        "scroll",
        browser_mod.browser_scroll,
        (),
        {"direction": "down", "amount": 600},
        "mouse_wheel",
        (),
        {"delta_x": 0, "delta_y": 600},
    ),
    (
        "key",
        browser_mod.browser_key,
        ("  Enter  ",),
        {},
        "press_key",
        ("Enter",),
        {},
    ),
    ("forward", browser_mod.browser_forward, (), {}, "go_forward", (), {}),
    (
        "reload",
        browser_mod.browser_reload,
        (),
        {"wait_until": "networkidle"},
        "reload_page",
        (),
        {"wait_until": "networkidle"},
    ),
    (
        "page-info",
        browser_mod.browser_page_info,
        (),
        {},
        "get_current_page_info",
        (),
        {},
    ),
    (
        "search",
        browser_mod.browser_search,
        ("  browser architecture  ",),
        {"engine": "google"},
        "search",
        ("browser architecture",),
        {"engine": "google"},
    ),
    ("tabs", browser_mod.browser_tabs, (), {}, "get_tabs", (), {}),
    (
        "new-tab",
        browser_mod.browser_new_tab,
        ("  https://example.com/new  ",),
        {},
        "new_tab",
        (),
        {"url": "https://example.com/new"},
    ),
    (
        "switch-tab",
        browser_mod.browser_switch_tab,
        ("  page-2  ",),
        {},
        "switch_tab",
        ("page-2",),
        {},
    ),
    (
        "close-tab",
        browser_mod.browser_close_tab,
        ("  page-3  ",),
        {},
        "close_tab",
        ("page-3",),
        {},
    ),
    (
        "wait",
        browser_mod.browser_wait,
        (),
        {"text": "Ready", "selector": "#app", "time_seconds": 1.5, "timeout": 4.0},
        "wait_for",
        (),
        {"time_seconds": 1.5, "text": "Ready", "selector": "#app", "timeout": 4.0},
    ),
    (
        "network-idle",
        browser_mod.browser_wait_for_network_idle,
        (),
        {"timeout": 7.0},
        "wait_for_network_idle",
        (),
        {"timeout": 7.0},
    ),
    (
        "screenshot",
        browser_mod.browser_screenshot,
        (),
        {"filename": "shot.png", "ref": "  hero  ", "full_page": True},
        "take_screenshot",
        (),
        {"filename": "shot.png", "ref": "hero", "full_page": True},
    ),
    (
        "verify-text",
        browser_mod.browser_verify_text,
        ("  Welcome  ",),
        {"exact": True, "timeout": 8.0},
        "verify_text_visible",
        ("Welcome",),
        {"exact": True, "timeout": 8.0},
    ),
    (
        "verify-visible",
        browser_mod.browser_verify_visible,
        ("  visible-ref  ",),
        {},
        "verify_element_state",
        ("visible-ref", "visible"),
        {},
    ),
    (
        "verify-url",
        browser_mod.browser_verify_url,
        ("  https://example.com/result  ",),
        {"exact": True},
        "verify_url",
        ("https://example.com/result",),
        {"exact": True},
    ),
    (
        "verify-title",
        browser_mod.browser_verify_title,
        ("  Result  ",),
        {"exact": True},
        "verify_title",
        ("Result",),
        {"exact": True},
    ),
    (
        "scroll-to-text",
        browser_mod.browser_scroll_to_text,
        ("  Details  ",),
        {},
        "scroll_to_text",
        ("Details",),
        {},
    ),
    (
        "hover",
        browser_mod.browser_hover,
        ("  hover-ref  ",),
        {},
        "hover_element_by_ref",
        ("hover-ref",),
        {},
    ),
    (
        "focus",
        browser_mod.browser_focus,
        ("  focus-ref  ",),
        {},
        "focus_element_by_ref",
        ("focus-ref",),
        {},
    ),
    (
        "select",
        browser_mod.browser_select,
        ("  select-ref  ", "  Option A  "),
        {},
        "select_dropdown_option_by_ref",
        ("select-ref", "Option A"),
        {},
    ),
    (
        "check",
        browser_mod.browser_check,
        ("  check-ref  ",),
        {},
        "check_checkbox_or_radio_by_ref",
        ("check-ref",),
        {},
    ),
    (
        "uncheck",
        browser_mod.browser_uncheck,
        ("  uncheck-ref  ",),
        {},
        "uncheck_checkbox_by_ref",
        ("uncheck-ref",),
        {},
    ),
    (
        "fill-form",
        browser_mod.browser_fill_form,
        ([{"ref": "  field-ref  ", "value": "hello"}],),
        {"submit": True},
        "fill_form",
        ([{"ref": "field-ref", "value": "hello"}],),
        {"submit": True},
    ),
    (
        "scroll-to-ref",
        browser_mod.browser_scroll_to_ref,
        ("  target-ref  ",),
        {},
        "scroll_element_into_view_by_ref",
        ("target-ref",),
        {},
    ),
    (
        "dropdown-options",
        browser_mod.browser_get_dropdown_options,
        ("  select-ref  ",),
        {},
        "get_dropdown_options_by_ref",
        ("select-ref",),
        {},
    ),
    (
        "double-click",
        browser_mod.browser_double_click,
        ("  double-ref  ",),
        {},
        "double_click_element_by_ref",
        ("double-ref",),
        {},
    ),
    (
        "upload-file",
        browser_mod.browser_upload_file,
        ("  upload-ref  ", "  /tmp/example.txt  "),
        {},
        "upload_file_by_ref",
        ("upload-ref", "/tmp/example.txt"),
        {},
    ),
    (
        "drag-ref",
        browser_mod.browser_drag,
        ("  start-ref  ", "  end-ref  "),
        {},
        "drag_element_by_ref",
        ("start-ref", "end-ref"),
        {},
    ),
    (
        "evaluate-javascript",
        browser_mod.browser_evaluate_javascript,
        ("() => document.title",),
        {},
        "evaluate_javascript",
        ("() => document.title",),
        {},
    ),
    (
        "evaluate-javascript-on-ref",
        browser_mod.browser_evaluate_javascript_on_ref,
        ("  eval-ref  ", "el => el.textContent"),
        {},
        "evaluate_javascript_on_ref",
        ("eval-ref", "el => el.textContent"),
        {},
    ),
    (
        "type-text",
        browser_mod.browser_type_text,
        ("hello",),
        {"submit": True},
        "type_text",
        ("hello",),
        {"submit": True},
    ),
    (
        "key-down",
        browser_mod.browser_key_down,
        ("  Shift  ",),
        {},
        "key_down",
        ("Shift",),
        {},
    ),
    (
        "key-up",
        browser_mod.browser_key_up,
        ("  Shift  ",),
        {},
        "key_up",
        ("Shift",),
        {},
    ),
    (
        "mouse-click",
        browser_mod.browser_mouse_click,
        (10.5, 20.5),
        {"button": "right", "click_count": 2},
        "mouse_click",
        (10.5, 20.5),
        {"button": "right", "click_count": 2},
    ),
    (
        "mouse-move",
        browser_mod.browser_mouse_move,
        (10.5, 20.5),
        {},
        "mouse_move",
        (10.5, 20.5),
        {},
    ),
    (
        "mouse-drag",
        browser_mod.browser_mouse_drag,
        (1.0, 2.0, 3.0, 4.0),
        {},
        "mouse_drag",
        (1.0, 2.0, 3.0, 4.0),
        {},
    ),
    (
        "mouse-down",
        browser_mod.browser_mouse_down,
        (),
        {"button": "middle"},
        "mouse_down",
        (),
        {"button": "middle"},
    ),
    (
        "mouse-up",
        browser_mod.browser_mouse_up,
        (),
        {"button": "middle"},
        "mouse_up",
        (),
        {"button": "middle"},
    ),
    (
        "save-pdf",
        browser_mod.browser_save_pdf,
        (),
        {"filename": "page.pdf", "display_header_footer": True, "landscape": True},
        "save_pdf",
        (),
        {
            "filename": "page.pdf",
            "display_header_footer": True,
            "print_background": True,
            "scale": 1.0,
            "paper_width": None,
            "paper_height": None,
            "margin_top": None,
            "margin_bottom": None,
            "margin_left": None,
            "margin_right": None,
            "landscape": True,
        },
    ),
    (
        "network-start",
        browser_mod.browser_start_network_capture,
        (),
        {},
        "start_network_capture",
        (),
        {},
    ),
    (
        "network-requests",
        browser_mod.browser_get_network_requests,
        (),
        {"include_static": True, "clear": False},
        "get_network_requests",
        (),
        {"include_static": True, "clear": False},
    ),
    (
        "network-stop",
        browser_mod.browser_stop_network_capture,
        (),
        {},
        "stop_network_capture",
        (),
        {},
    ),
    (
        "dialog-setup",
        browser_mod.browser_setup_dialog_handler,
        (),
        {"default_action": "dismiss", "default_prompt_text": "answer"},
        "setup_dialog_handler",
        (),
        {"default_action": "dismiss", "default_prompt_text": "answer"},
    ),
    (
        "dialog-handle",
        browser_mod.browser_handle_dialog,
        (True,),
        {"prompt_text": "answer"},
        "handle_dialog",
        (),
        {"accept": True, "prompt_text": "answer"},
    ),
    (
        "dialog-remove",
        browser_mod.browser_remove_dialog_handler,
        (),
        {},
        "remove_dialog_handler",
        (),
        {},
    ),
    (
        "get-cookies",
        browser_mod.browser_get_cookies,
        (),
        {"urls": ["https://example.com"], "name": "sid", "domain": "example.com"},
        "get_cookies",
        (),
        {
            "urls": ["https://example.com"],
            "name": "sid",
            "domain": "example.com",
            "path": None,
        },
    ),
    (
        "set-cookie",
        browser_mod.browser_set_cookie,
        ("  sid  ", "secret"),
        {"url": "https://example.com", "secure": True},
        "set_cookie",
        (),
        {
            "name": "sid",
            "value": "secret",
            "url": "https://example.com",
            "domain": None,
            "path": "/",
            "expires": None,
            "http_only": False,
            "secure": True,
            "same_site": None,
        },
    ),
    (
        "clear-cookies",
        browser_mod.browser_clear_cookies,
        (),
        {"domain": "example.com"},
        "clear_cookies",
        (),
        {"name": None, "domain": "example.com", "path": None},
    ),
    (
        "save-storage",
        browser_mod.browser_save_storage_state,
        (),
        {"filename": "state.json"},
        "save_storage_state",
        (),
        {"filename": "state.json"},
    ),
    (
        "restore-storage",
        browser_mod.browser_restore_storage_state,
        ("  state.json  ",),
        {},
        "restore_storage_state",
        ("state.json",),
        {},
    ),
    (
        "verify-role-visible",
        browser_mod.browser_verify_role_visible,
        ("  button  ", "  Save  "),
        {"timeout": 9.0},
        "verify_element_visible",
        ("button", "Save"),
        {"timeout": 9.0},
    ),
    (
        "verify-state",
        browser_mod.browser_verify_state,
        ("  state-ref  ", "enabled"),
        {},
        "verify_element_state",
        ("state-ref", "enabled"),
        {},
    ),
    (
        "verify-value",
        browser_mod.browser_verify_value,
        ("  value-ref  ", "ready"),
        {"attribute": "data-state"},
        "verify_value",
        ("value-ref", "ready"),
        {"attribute": "data-state"},
    ),
    (
        "console-start",
        browser_mod.browser_start_console_capture,
        (),
        {},
        "start_console_capture",
        (),
        {},
    ),
    (
        "console-messages",
        browser_mod.browser_get_console_messages,
        (),
        {"type_filter": "error", "clear": False},
        "get_console_messages",
        (),
        {"type_filter": "error", "clear": False},
    ),
    (
        "console-stop",
        browser_mod.browser_stop_console_capture,
        (),
        {},
        "stop_console_capture",
        (),
        {},
    ),
    (
        "trace-start",
        browser_mod.browser_start_tracing,
        (),
        {"screenshots": False, "snapshots": True, "sources": True},
        "start_tracing",
        (),
        {"screenshots": False, "snapshots": True, "sources": True},
    ),
    (
        "trace-chunk",
        browser_mod.browser_add_trace_chunk,
        (),
        {"title": "checkout"},
        "add_trace_chunk",
        (),
        {"title": "checkout"},
    ),
    (
        "trace-stop",
        browser_mod.browser_stop_tracing,
        (),
        {"filename": "trace.zip"},
        "stop_tracing",
        (),
        {"filename": "trace.zip"},
    ),
    (
        "video-start",
        browser_mod.browser_start_video,
        (),
        {"width": 1280, "height": 720},
        "start_video",
        (),
        {"width": 1280, "height": 720},
    ),
    (
        "video-stop",
        browser_mod.browser_stop_video,
        (),
        {"filename": "demo.webm"},
        "stop_video",
        (),
        {"filename": "demo.webm"},
    ),
    (
        "resize",
        browser_mod.browser_resize,
        (1280, 720),
        {},
        "browser_resize",
        (1280, 720),
        {},
    ),
]


def test_every_bridgic_catalog_wrapper_has_a_delegation_contract() -> None:
    delegated_tool_names = {case[1].__name__ for case in _DELEGATION_CASES}
    expected = set(browser_mod._BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME.values()) - {
        "browser_close"
    }
    assert expected <= delegated_tool_names


@pytest.mark.parametrize(
    ("_case", "tool", "args", "kwargs", "method_name", "expected_args", "expected_kwargs"),
    _DELEGATION_CASES,
    ids=[case[0] for case in _DELEGATION_CASES],
)
async def test_browser_tools_delegate_to_session_browser(
    _case: str,
    tool: BrowserTool,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    method_name: str,
    expected_args: tuple[Any, ...],
    expected_kwargs: dict[str, Any],
    session_browser: _FakeSessionBrowser,
) -> None:
    result = await tool(*args, **kwargs)

    assert result == f"invoked {method_name}"
    assert session_browser.invoke_calls == [
        (method_name, expected_args, expected_kwargs)
    ]


@pytest.mark.parametrize(
    ("tool", "args", "expected_method", "expected_args", "expected_kwargs"),
    [
        (browser_mod.browser_new_tab, (), "new_tab", (), {"url": None}),
        (browser_mod.browser_close_tab, (), "close_tab", (None,), {}),
        (
            browser_mod.browser_wait,
            (),
            "wait_for",
            (),
            {"time_seconds": None, "text": None, "selector": None, "timeout": 30.0},
        ),
        (
            browser_mod.browser_screenshot,
            (),
            "take_screenshot",
            (),
            {"filename": None, "ref": None, "full_page": False},
        ),
    ],
    ids=["new-tab", "close-current-tab", "wait", "screenshot"],
)
async def test_browser_tools_normalize_optional_arguments(
    tool: BrowserTool,
    args: tuple[Any, ...],
    expected_method: str,
    expected_args: tuple[Any, ...],
    expected_kwargs: dict[str, Any],
    session_browser: _FakeSessionBrowser,
) -> None:
    await tool(*args)

    assert session_browser.invoke_calls == [
        (expected_method, expected_args, expected_kwargs)
    ]


@pytest.mark.parametrize(
    ("limit", "expected"),
    [(0, 1), (-10, 1), (10_001, 10_000), (50_001, 10_000)],
)
async def test_browser_snapshot_clamps_limit(
    limit: int,
    expected: int,
    session_browser: _FakeSessionBrowser,
) -> None:
    await browser_mod.browser_snapshot(limit=limit)

    assert session_browser.invoke_calls == [
        (
            "get_snapshot_text",
            (),
            {"limit": expected, "interactive": False, "full_page": True},
        )
    ]


@pytest.mark.parametrize(
    ("direction", "amount", "expected"),
    [
        ("up", 0, {"delta_x": 0, "delta_y": -1}),
        ("down", 5_001, {"delta_x": 0, "delta_y": 5_000}),
        ("left", 25, {"delta_x": -25, "delta_y": 0}),
        ("right", 25, {"delta_x": 25, "delta_y": 0}),
    ],
)
async def test_browser_scroll_maps_direction_and_clamps_amount(
    direction: str,
    amount: int,
    expected: dict[str, int],
    session_browser: _FakeSessionBrowser,
) -> None:
    await browser_mod.browser_scroll(direction=direction, amount=amount)

    assert session_browser.invoke_calls == [("mouse_wheel", (), expected)]


_INVALID_ARGUMENT_CASES: list[
    tuple[str, BrowserTool, tuple[Any, ...], dict[str, Any], str]
] = [
    ("open", browser_mod.browser_open, ("  ",), {}, "url is required"),
    ("click", browser_mod.browser_click, ("  ",), {}, "ref is required"),
    ("input", browser_mod.browser_input, ("  ", "text"), {}, "ref is required"),
    ("key", browser_mod.browser_key, ("  ",), {}, "key is required"),
    ("search", browser_mod.browser_search, ("  ",), {}, "query is required"),
    ("switch-tab", browser_mod.browser_switch_tab, ("  ",), {}, "page_id is required"),
    ("verify-text", browser_mod.browser_verify_text, ("  ",), {}, "text is required"),
    ("verify-visible", browser_mod.browser_verify_visible, ("  ",), {}, "ref is required"),
    ("verify-url", browser_mod.browser_verify_url, ("  ",), {}, "expected_url is required"),
    (
        "verify-title",
        browser_mod.browser_verify_title,
        ("  ",),
        {},
        "expected_title is required",
    ),
    ("scroll-to-text", browser_mod.browser_scroll_to_text, ("  ",), {}, "text is required"),
    ("hover", browser_mod.browser_hover, ("  ",), {}, "ref is required"),
    ("focus", browser_mod.browser_focus, ("  ",), {}, "ref is required"),
    ("select-ref", browser_mod.browser_select, ("  ", "Option"), {}, "ref is required"),
    ("select-text", browser_mod.browser_select, ("ref", "  "), {}, "text is required"),
    ("check", browser_mod.browser_check, ("  ",), {}, "ref is required"),
    ("uncheck", browser_mod.browser_uncheck, ("  ",), {}, "ref is required"),
    ("fill-form-empty", browser_mod.browser_fill_form, ([],), {}, "at least one field"),
    (
        "fill-form-ref",
        browser_mod.browser_fill_form,
        ([{"ref": "  ", "value": "x"}],),
        {},
        r"fields\[0\]\.ref is required",
    ),
    (
        "fill-form-value",
        browser_mod.browser_fill_form,
        ([{"ref": "field"}],),
        {},
        r"fields\[0\]\.value is required",
    ),
    ("scroll-to-ref", browser_mod.browser_scroll_to_ref, ("  ",), {}, "ref is required"),
    (
        "dropdown-options",
        browser_mod.browser_get_dropdown_options,
        ("  ",),
        {},
        "ref is required",
    ),
    ("double-click", browser_mod.browser_double_click, ("  ",), {}, "ref is required"),
    (
        "upload-ref",
        browser_mod.browser_upload_file,
        ("  ", "/tmp/a"),
        {},
        "ref is required",
    ),
    (
        "upload-path",
        browser_mod.browser_upload_file,
        ("ref", "  "),
        {},
        "file_path is required",
    ),
    ("drag-start", browser_mod.browser_drag, ("  ", "end"), {}, "start_ref is required"),
    ("drag-end", browser_mod.browser_drag, ("start", "  "), {}, "end_ref is required"),
    (
        "evaluate-javascript",
        browser_mod.browser_evaluate_javascript,
        ("  ",),
        {},
        "code is required",
    ),
    (
        "evaluate-on-ref",
        browser_mod.browser_evaluate_javascript_on_ref,
        ("  ", "el => el"),
        {},
        "ref is required",
    ),
    (
        "evaluate-on-code",
        browser_mod.browser_evaluate_javascript_on_ref,
        ("ref", "  "),
        {},
        "code is required",
    ),
    ("key-down", browser_mod.browser_key_down, ("  ",), {}, "key is required"),
    ("key-up", browser_mod.browser_key_up, ("  ",), {}, "key is required"),
    (
        "restore-storage",
        browser_mod.browser_restore_storage_state,
        ("  ",),
        {},
        "filename is required",
    ),
    (
        "verify-role",
        browser_mod.browser_verify_role_visible,
        ("  ", "Save"),
        {},
        "role is required",
    ),
    (
        "verify-accessible-name",
        browser_mod.browser_verify_role_visible,
        ("button", "  "),
        {},
        "accessible_name is required",
    ),
    (
        "verify-state",
        browser_mod.browser_verify_state,
        ("  ", "visible"),
        {},
        "ref is required",
    ),
    (
        "verify-value-ref",
        browser_mod.browser_verify_value,
        ("  ", "x"),
        {},
        "ref is required",
    ),
    (
        "verify-value-attribute",
        browser_mod.browser_verify_value,
        ("ref", "x"),
        {"attribute": "  "},
        "attribute is required",
    ),
    ("set-cookie-name", browser_mod.browser_set_cookie, ("  ", "x"), {}, "name is required"),
]


@pytest.mark.parametrize(
    ("_case", "tool", "args", "kwargs", "message"),
    _INVALID_ARGUMENT_CASES,
    ids=[case[0] for case in _INVALID_ARGUMENT_CASES],
)
async def test_browser_tools_reject_invalid_required_arguments_before_invoking(
    _case: str,
    tool: BrowserTool,
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    message: str,
    session_browser: _FakeSessionBrowser,
) -> None:
    with pytest.raises(ValueError, match=message):
        await tool(*args, **kwargs)

    assert session_browser.invoke_calls == []


async def test_browser_scroll_rejects_invalid_direction_before_invoking(
    session_browser: _FakeSessionBrowser,
) -> None:
    with pytest.raises(ValueError, match="direction must be one of"):
        await browser_mod.browser_scroll(direction="diagonal")

    assert session_browser.invoke_calls == []


@pytest.mark.parametrize(
    ("closed", "expected"),
    [
        (True, "Closed the browser."),
        (False, "No browser is open."),
    ],
)
async def test_browser_close_delegates_to_session_handle(
    closed: bool,
    expected: str,
    session_browser: _FakeSessionBrowser,
) -> None:
    session_browser.close_result = closed

    assert await browser_mod.browser_close() == expected
    assert session_browser.close_calls == 1
    assert session_browser.invoke_calls == []


async def test_browser_tools_require_active_session_browser() -> None:
    token = current_agent.set(SimpleNamespace(ctx=SimpleNamespace(browser=None)))
    try:
        with pytest.raises(RuntimeError, match="active browser"):
            await browser_mod.browser_back()
    finally:
        current_agent.reset(token)


async def test_browser_file_paths_resolve_against_session_workspace(tmp_path) -> None:
    browser = _FakeSessionBrowser()
    work_dir = tmp_path / "work"
    token = current_agent.set(
        SimpleNamespace(
            ctx=SimpleNamespace(
                browser=browser,
                workspace=SimpleNamespace(work_dir=work_dir),
            )
        )
    )
    try:
        await browser_mod.browser_upload_file("upload-ref", "assets/report.csv")
        await browser_mod.browser_save_pdf(filename="exports/page.pdf")
    finally:
        current_agent.reset(token)

    assert browser.invoke_calls[0] == (
        "upload_file_by_ref",
        ("upload-ref", str(work_dir / "assets" / "report.csv")),
        {},
    )
    assert browser.invoke_calls[1][0] == "save_pdf"
    assert browser.invoke_calls[1][2]["filename"] == str(work_dir / "exports" / "page.pdf")


async def test_load_browser_tools_sets_flag() -> None:
    ota = AmphiOTAContext(user_input="x")
    agent = SimpleNamespace(ota_ctx=ota)
    token = current_agent.set(agent)
    try:
        result = await browser_mod.load_browser_tools()
    finally:
        current_agent.reset(token)

    assert ota.browser_tool_loaded is True
    assert "Advanced browser tools are loaded" in result
    assert "JavaScript" in result
    assert "Cookies, storage state, tracing, and video recording" in result


async def test_load_browser_tools_requires_agent_context() -> None:
    token = current_agent.set(None)
    try:
        with pytest.raises(RuntimeError, match="inside an agent turn"):
            await browser_mod.load_browser_tools()
    finally:
        current_agent.reset(token)
