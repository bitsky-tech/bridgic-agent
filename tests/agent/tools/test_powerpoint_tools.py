import json
from typing import Any

from src.amphi_agent.tools._powerpoint import (
    powerpoint_add_animation,
    powerpoint_apply,
    powerpoint_list,
    powerpoint_snapshot,
)
from tests.agent.tools._harness import ToolHarness


class _RecordingPowerPoint:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def list_presentations(self) -> Any:
        self.calls.append(("list", None))
        return {"presentations": []}

    async def snapshot(self, document_id: str | None = None) -> Any:
        self.calls.append(("snapshot", document_id))
        return {"document_id": document_id}

    async def apply(self, operations: list[dict[str, Any]]) -> Any:
        self.calls.append(("apply", operations))
        return {"applied": len(operations)}

    async def add_animation(self, element_id: str, effect: str, **kwargs: Any) -> Any:
        self.calls.append(("animation", (element_id, effect, kwargs)))
        return {"animated": element_id}


async def test_powerpoint_tools_use_the_session_handle(tool_harness: ToolHarness) -> None:
    powerpoint = _RecordingPowerPoint()
    tool_harness.context.powerpoint = powerpoint  # type: ignore[assignment]

    assert json.loads(await powerpoint_list()) == {"presentations": []}
    assert json.loads(await powerpoint_snapshot("deck-a")) == {"document_id": "deck-a"}
    assert json.loads(await powerpoint_apply([{"type": "add_slide"}])) == {"applied": 1}
    assert json.loads(await powerpoint_add_animation(
        "element-a",
        "fade",
        slide_id="slide-a",
        start="afterPrevious",
        duration=0.8,
        delay=0.2,
    )) == {"animated": "element-a"}

    assert powerpoint.calls == [
        ("list", None),
        ("snapshot", "deck-a"),
        ("apply", [{"type": "add_slide"}]),
        ("animation", ("element-a", "fade", {
            "slide_id": "slide-a",
            "start": "afterPrevious",
            "duration": 0.8,
            "delay": 0.2,
        })),
    ]
