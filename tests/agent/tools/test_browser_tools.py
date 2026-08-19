import inspect
from typing import Any

import pytest

from src.amphi_agent.tools import _browser as browser_module
from src.amphi_agent.tools._browser import (
    browser_close,
    browser_fill_form,
    browser_input,
    browser_open,
    browser_restore_storage_state,
    browser_screenshot,
    browser_scroll,
    browser_snapshot,
    browser_upload_file,
    load_browser_tools,
)
from tests.agent.tools._harness import ToolHarness


class _RecordingBrowser:
    def __init__(self, *, closed: bool = True) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.closed = closed

    async def invoke(self, method: str, *args: Any, **kwargs: Any) -> str:
        self.calls.append((method, args, kwargs))
        return f"{method} result"

    async def close(self) -> bool:
        return self.closed


async def test_browser_actions(tool_harness: ToolHarness) -> None:
    """Final browser operations:

    {
      "navigate": "https://example.test",
      "snapshot_limit": 10000,
      "input": {"ref": "field-1", "submit": true},
      "scroll": {"delta_x": -1, "delta_y": 0},
      "form": [{"ref": "name", "value": "42"}]
    }

    Checks:
    1. Navigation trims the URL and maps to the browser's navigation operation.
    2. Snapshot options map to the capture operation and its display limit is bounded.
    3. Ref input retains text-entry controls and strips the snapshot reference.
    4. Scroll direction and distance become bounded coordinate deltas.
    5. Form values are normalized to strings before one batched browser operation.
    """
    browser = _RecordingBrowser()
    tool_harness.context.browser = browser  # type: ignore[assignment]

    # Check 1: Navigation trims the URL and maps to the browser's navigation operation.
    assert await browser_open("  https://example.test  ") == "navigate_to result"
    assert browser.calls[-1] == ("navigate_to", ("https://example.test",), {})

    # Check 2: Snapshot options map to the capture operation and its display limit is bounded.
    assert await browser_snapshot(interactive=True, full_page=False, limit=50_000) == "get_snapshot_text result"
    assert browser.calls[-1] == (
        "get_snapshot_text",
        (),
        {"limit": 10_000, "interactive": True, "full_page": False},
    )

    # Check 3: Ref input retains text-entry controls and strips the snapshot reference.
    input_result = await browser_input(" field-1 ", "hello", clear=False, submit=True, slowly=True)
    assert input_result == "input_text_by_ref result"
    assert browser.calls[-1] == (
        "input_text_by_ref",
        (),
        {"ref": "field-1", "text": "hello", "clear": False, "submit": True, "slowly": True},
    )

    # Check 4: Scroll direction and distance become bounded coordinate deltas.
    assert await browser_scroll("left", amount=0) == "mouse_wheel result"
    assert browser.calls[-1] == ("mouse_wheel", (), {"delta_x": -1, "delta_y": 0})

    # Check 5: Form values are normalized to strings before one batched browser operation.
    form_result = await browser_fill_form(
        [{"ref": " name ", "value": 42}],  # type: ignore[dict-item]
        submit=True,
    )
    assert form_result == "fill_form result"
    assert browser.calls[-1] == ("fill_form", ([{"ref": "name", "value": "42"}],), {"submit": True})


async def test_browser_boundaries(tool_harness: ToolHarness) -> None:
    """Final browser boundary results:

    {
      "relative_outputs": "resolved under <session>/.work",
      "missing_refs": "rejected",
      "invalid_form": "rejected",
      "advanced_tools": "loaded",
      "browser": "closed"
    }

    Checks:
    1. Browser file inputs and outputs resolve relative to the active Session Workspace.
    2. Empty references and malformed form entries fail before invoking the browser.
    3. Loading advanced operations updates the current Turn's tool surface state.
    4. Close reports the real browser lifecycle result without calling a generic operation.
    """
    browser = _RecordingBrowser()
    tool_harness.context.browser = browser  # type: ignore[assignment]
    work_dir = tool_harness.workspace.work_dir

    # Check 1: Browser file inputs and outputs resolve relative to the active Session Workspace.
    await browser_screenshot("artifacts/page.png", ref="page", full_page=True)
    assert browser.calls[-1] == (
        "take_screenshot",
        (),
        {"filename": str(work_dir / "artifacts" / "page.png"), "ref": "page", "full_page": True},
    )
    await browser_upload_file("upload", "inputs/data.csv")
    assert browser.calls[-1] == (
        "upload_file_by_ref",
        ("upload", str(work_dir / "inputs" / "data.csv")),
        {},
    )
    await browser_restore_storage_state("auth/state.json")
    assert browser.calls[-1] == (
        "restore_storage_state",
        (str(work_dir / "auth" / "state.json"),),
        {},
    )

    # Check 2: Empty references and malformed form entries fail before invoking the browser.
    count = len(browser.calls)
    with pytest.raises(ValueError, match="ref is required"):
        await browser_input("", "text")
    with pytest.raises(ValueError, match=r"fields\[0\].value is required"):
        await browser_fill_form([{"ref": "field"}])
    with pytest.raises(ValueError, match="direction must be one of"):
        await browser_scroll("diagonal")  # type: ignore[arg-type]
    assert len(browser.calls) == count

    # Check 3: Loading advanced operations updates the current Turn's tool surface state.
    assert tool_harness.ota_context.browser_tool_loaded is False
    assert "Advanced browser tools are loaded" in await load_browser_tools()
    assert tool_harness.ota_context.browser_tool_loaded is True

    # Check 4: Close reports the real browser lifecycle result without calling a generic operation.
    assert await browser_close() == "Closed the browser."
    browser.closed = False
    assert await browser_close() == "No browser is open."


async def test_browser_catalog(tool_harness: ToolHarness) -> None:
    """Final browser tool bridge:

    {
      "public_tools": "every declared browser operation invoked",
      "bridge": "each public tool reaches its matching browser method",
      "convenience_tools": ["scroll to text", "verify visible"]
    }

    Checks:
    1. Every canonical browser operation has a callable public tool that reaches its matching method.
    2. Every declared public browser tool is covered by this bridge check or a focused lifecycle check.
    3. Convenience tools map to their intended lower-level browser operations.
    """
    browser = _RecordingBrowser()
    tool_harness.context.browser = browser  # type: ignore[assignment]
    samples: dict[str, Any] = {
        "accept": True,
        "accessible_name": "Save",
        "code": "() => document.title",
        "end_ref": "target",
        "end_x": 30.0,
        "end_y": 40.0,
        "expected_title": "Example",
        "expected_url": "https://example.test",
        "fields": [{"ref": "field", "value": "value"}],
        "file_path": "inputs/file.txt",
        "filename": "state.json",
        "height": 600,
        "key": "Enter",
        "name": "cookie",
        "page_id": "page-1",
        "query": "agent testing",
        "ref": "ref-1",
        "role": "button",
        "start_ref": "source",
        "start_x": 10.0,
        "start_y": 20.0,
        "state": "visible",
        "text": "value",
        "url": "https://example.test",
        "value": "value",
        "width": 800,
        "x": 10.0,
        "y": 20.0,
    }
    executed: set[str] = set()

    # Check 1: Every canonical browser operation reaches its matching method.
    for method, tool_name in browser_module._BRIDGIC_BROWSER_METHOD_TO_TOOL_NAME.items():
        if tool_name == "browser_close":
            continue
        operation = getattr(browser_module, tool_name)
        arguments = {
            name: samples[name]
            for name, parameter in inspect.signature(operation).parameters.items()
            if parameter.default is inspect.Parameter.empty
        }
        assert await operation(**arguments) == f"{method} result"
        assert browser.calls[-1][0] == method
        executed.add(tool_name)

    # Check 2: The catalogue has no untested public browser operation.
    executed.update({"browser_close", "load_browser_tools"})
    assert executed | {"browser_scroll_to_text", "browser_verify_visible"} == set(
        browser_module.BROWSER_TOOL_NAMES
    )

    # Check 3: Convenience tools reach their intended lower-level operations.
    assert await browser_module.browser_scroll_to_text("Target") == "scroll_to_text result"
    assert browser.calls[-1][0] == "scroll_to_text"
    assert await browser_module.browser_verify_visible("ref-1") == "verify_element_state result"
    assert browser.calls[-1][0] == "verify_element_state"
