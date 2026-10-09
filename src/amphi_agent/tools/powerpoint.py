import json
from pathlib import Path
from typing import Any, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from ..powerpoint import SessionPowerPoint


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


def _target_path(target: str) -> str:
    raw = str(target or "").strip()
    if not raw:
        raise ValueError("target is required")
    candidate = Path(raw).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (_workspace_root() / candidate).resolve()
    resolved = resolved if resolved.suffix else resolved.with_suffix(".pptx")
    if resolved.suffix.lower() != ".pptx":
        raise ValueError("PowerPoint target must use the .pptx extension")
    return str(resolved)


def _format(value: Any) -> str:
    private_fields = {"deck_revision", "document_revision", "revision"}

    def public(item: Any) -> Any:
        if isinstance(item, dict):
            return {key: public(nested) for key, nested in item.items() if key not in private_fields}
        if isinstance(item, list):
            return [public(nested) for nested in item]
        return item

    return json.dumps(public(value), ensure_ascii=False, indent=2)


async def ppt_open(target: str) -> str:
    """Open an existing PPTX or create a new Session-owned deck at target.

    Call this first. The result contains the stable document id used by every
    other PowerPoint tool and a compact ordered page overview.
    """
    return _format(await _get_powerpoint().open(_target_path(target)))


async def ppt_read_deck(document_id: str, query: Optional[dict[str, Any]] = None) -> str:
    """Read deck structure and acquire the private revision required by ppt_manage_deck.

    Set query.include_theme to true when changing visual design. Re-read after
    a stale revision or when user edits may have changed the deck.
    """
    return _format(await _get_powerpoint().read_deck(document_id, query))


async def ppt_read_page(document_id: str, page_id: str, query: Optional[dict[str, Any]] = None) -> str:
    """Read one page and acquire the private revision required by ppt_edit_page.

    The default compact format is readable Markdown with stable element refs.
    Use format=model for native structured properties or format=both for both
    views. element_ids can limit a model read to selected objects.
    """
    return _format(await _get_powerpoint().read_page(document_id, page_id, query))


async def ppt_inspect(document_id: str, query: dict[str, Any]) -> str:
    """Inspect the live PowerPoint editor.

    Use {"kind":"render"} for the active page or include page_ids (maximum
    12). The returned PNGs come from the exact live canvas and should be opened
    with read_image for visual QA.
    """
    return _format(await _get_powerpoint().inspect(document_id, query))


async def ppt_edit_page(document_id: str, page_id: str, operations: list[dict[str, Any]], options: Optional[dict[str, Any]] = None) -> str:
    """Atomically edit one page with typed domain operations.

    Read the page first. Commands are set-page, add, patch, remove, reorder,
    add-comment, patch-comment, and remove-comment. Element ids are stable refs;
    patch includes the element_type read from the model, omitted fields are
    preserved, and null clears an optional property. Media src paths are
    Session-workspace-relative. Use options.validate_only to validate without
    committing.
    """
    return _format(await _get_powerpoint().edit_page(document_id, page_id, operations, options))


async def ppt_manage_deck(document_id: str, operations: list[dict[str, Any]], options: Optional[dict[str, Any]] = None) -> str:
    """Atomically change deck structure or global design with typed operations.

    Read the deck first. Commands are set-design, insert-page, duplicate-page,
    remove-page, and move-page. Page ids supplied for new pages become their
    stable refs. Use options.validate_only to validate without committing.
    """
    return _format(await _get_powerpoint().manage_deck(document_id, operations, options))


async def ppt_save(document_id: str, target: Optional[str] = None) -> str:
    """Flush one open PowerPoint document, optionally saving it to a new PPTX target."""
    resolved = None if target is None else _target_path(target)
    return _format(await _get_powerpoint().save(document_id, resolved))


def _object(properties: dict[str, Any], required: tuple[str, ...] = (), *, additional: bool = False) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional,
        **({"required": list(required)} if required else {}),
    }


def _nullable(schema: dict[str, Any]) -> dict[str, Any]:
    return {"anyOf": [schema, {"type": "null"}]}


_STRING = {"type": "string"}
_NUMBER = {"type": "number"}
_BOOLEAN = {"type": "boolean"}
_PLACEMENT = {"before": _STRING, "after": _STRING}
_OPTIONS = _object({
    "validate_only": {"type": "boolean", "description": "Validate the whole batch without committing it."},
})
_FOOTER = _object({"text": _STRING, "showDate": _BOOLEAN, "showSlideNumber": _BOOLEAN})
_TRANSITION_PROPERTIES = {
    "effect": {"type": "string", "enum": ["none", "fade", "push", "wipe", "reveal", "cover", "zoom", "flip", "cube"]},
    "durationMs": _NUMBER,
    "direction": {"type": "string", "enum": ["left", "right", "up", "down", "in", "out"]},
    "throughBlack": _BOOLEAN,
}
_TRANSITION_PATCH = _object(_TRANSITION_PROPERTIES)
_TRANSITION_PATCH["minProperties"] = 1
_HYPERLINK = {
    "oneOf": [
        _object({"type": {"const": "url"}, "url": _STRING, "tooltip": _STRING}, ("type", "url")),
        _object({"type": {"const": "slide"}, "slideId": _STRING, "tooltip": _STRING}, ("type", "slideId")),
    ]
}
_SHAPE_TYPES = [
    "line", "lineArrow", "lineDoubleArrow", "elbowConnector", "elbowArrow", "curvedConnector", "curvedArrow",
    "rect", "roundRect", "snip1Rect", "snip2DiagRect", "round1Rect", "round2SameRect", "frame", "ellipse",
    "triangle", "rtTriangle", "parallelogram", "trapezoid", "diamond", "pentagon", "hexagon", "octagon",
    "decagon", "dodecagon", "pie", "teardrop", "plus", "star4", "star5", "star6", "star8", "heart",
    "lightningBolt", "sun", "moon", "cloud", "donut", "arc", "smileyFace", "can", "cube", "bevel",
    "bracePair", "bracketPair", "rightArrow", "leftArrow", "upArrow", "downArrow", "leftRightArrow",
    "upDownArrow", "quadArrow", "bentArrow", "bentUpArrow", "uturnArrow", "circularArrow", "chevron",
    "notchedRightArrow", "stripedRightArrow", "rightArrowCallout", "leftArrowCallout", "upArrowCallout",
    "downArrowCallout", "mathPlus", "mathMinus", "mathMultiply", "mathDivide", "mathEqual", "mathNotEqual",
    "flowChartProcess", "flowChartAlternateProcess", "flowChartDecision", "flowChartInputOutput",
    "flowChartDocument", "flowChartMultidocument", "flowChartTerminator", "flowChartPreparation",
    "flowChartManualInput", "flowChartManualOperation", "flowChartConnector", "flowChartOffpageConnector",
    "flowChartDelay", "flowChartDisplay", "flowChartPredefinedProcess", "flowChartInternalStorage",
]
_TEXT_STYLE = _object({
    "fontSize": _NUMBER, "fontFamily": _STRING,
    "fontWeight": {"type": "integer", "enum": [400, 500, 600, 700]},
    "italic": _BOOLEAN, "underline": _BOOLEAN, "strikethrough": _BOOLEAN,
    "baseline": {"type": "string", "enum": ["normal", "superscript", "subscript"]},
    "highlightColor": _STRING, "characterSpacing": _NUMBER, "color": _STRING, "opacity": _NUMBER,
})
_PARAGRAPH_STYLE = _object({
    "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
    "lineHeight": _NUMBER, "lineSpacing": _NUMBER, "indentLevel": {"type": "integer"},
    "listStyle": {"type": "string", "enum": ["none", "bullet", "number"]},
    "spaceBefore": _NUMBER, "spaceAfter": _NUMBER, "listStartAt": {"type": "integer"},
    "listNumberFormat": _STRING, "listBulletChar": _STRING, "listMarkerFontFamily": _STRING,
})
_COMMON_ELEMENT_PROPERTIES: dict[str, Any] = {
    "id": {"type": "string", "description": "Stable unique element ref."},
    "x": _NUMBER, "y": _NUMBER, "width": _NUMBER, "height": _NUMBER, "rotation": _NUMBER,
    "flipHorizontal": _BOOLEAN, "flipVertical": _BOOLEAN, "opacity": _NUMBER, "shadow": _BOOLEAN,
    "groupId": _STRING, "hyperlink": _HYPERLINK,
    "animation": {"type": "string", "enum": [
        "none", "appear", "fade", "blinds", "checkerboard", "dissolve", "flyIn", "floatIn", "split",
        "wipeIn", "zoomIn", "zoom", "fillColor", "textColor", "disappear", "blindsOut",
    ]},
    "animationDuration": _NUMBER, "animationDelay": _NUMBER,
    "animationStart": {"type": "string", "enum": ["onClick", "withPrevious", "afterPrevious"]},
    "animationTrigger": {"type": "string", "enum": ["slideClick", "elementClick"]},
    "animationColor": _STRING,
}
_TEXT_PROPERTIES: dict[str, Any] = {
    "text": _STRING, "fontSize": _NUMBER, "fontFamily": _STRING,
    "fontWeight": {"type": "integer", "enum": [400, 500, 600, 700]},
    "italic": _BOOLEAN, "underline": _BOOLEAN, "strikethrough": _BOOLEAN,
    "baseline": {"type": "string", "enum": ["normal", "superscript", "subscript"]},
    "highlightColor": _STRING, "characterSpacing": _NUMBER, "color": _STRING,
    "align": {"type": "string", "enum": ["left", "center", "right", "justify"]},
    "verticalAlign": {"type": "string", "enum": ["top", "middle", "bottom"]},
    "lineHeight": _NUMBER, "lineSpacing": _NUMBER, "indentLevel": {"type": "integer"},
    "listStyle": {"type": "string", "enum": ["none", "bullet", "number"]},
    "textDirection": {"type": "string", "enum": ["horizontal", "eastAsianVertical", "vertical", "vertical270", "stacked"]},
    "wordWrap": _BOOLEAN,
    "textInsets": _object({"left": _NUMBER, "top": _NUMBER, "right": _NUMBER, "bottom": _NUMBER}, ("left", "top", "right", "bottom")),
    "textRuns": {"type": "array", "items": _object({"start": {"type": "integer"}, "end": {"type": "integer"}, "style": _TEXT_STYLE}, ("start", "end", "style"))},
    "paragraphs": {"type": "array", "items": _object({
        "start": {"type": "integer"}, "end": {"type": "integer"}, "style": _PARAGRAPH_STYLE, "endStyle": _TEXT_STYLE,
    }, ("start", "end", "style"))},
}
_SHAPE_PROPERTIES = {
    "fill": _STRING, "borderColor": _STRING, "borderWidth": _NUMBER, "radius": _NUMBER, "connectorPath": _STRING,
}
_IMAGE_PROPERTIES = {
    "src": {"type": "string", "description": "Session-workspace-relative media path."},
    "altText": _STRING, "fit": {"type": "string", "enum": ["contain", "cover"]},
    "clipShape": {"type": "string", "enum": ["ellipse"]},
    "crop": _object({"left": _NUMBER, "top": _NUMBER, "right": _NUMBER, "bottom": _NUMBER}, ("left", "top", "right", "bottom")),
}
_MEDIA_PROPERTIES = {
    "src": {"type": "string", "description": "Session-workspace-relative media path."},
    "autoplay": _BOOLEAN, "loop": _BOOLEAN, "muted": _BOOLEAN,
}
_TABLE_PROPERTIES = {
    "cells": {"type": "array", "items": {"type": "array", "items": _STRING}},
    "headerRow": _BOOLEAN, "headerFill": _STRING, "headerTextColor": _STRING,
    "bodyFill": _STRING, "textColor": _STRING, "borderColor": _STRING, "fontSize": _NUMBER,
}
_CHART_PROPERTIES = {
    "chartType": {"type": "string", "enum": ["column", "bar", "line", "pie", "doughnut"]},
    "categories": {"type": "array", "items": _STRING},
    "series": {"type": "array", "items": _object({"name": _STRING, "values": {"type": "array", "items": {"anyOf": [_NUMBER, {"type": "null"}]}}}, ("name", "values"))},
    "showLegend": _BOOLEAN, "showValue": _BOOLEAN, "title": _STRING,
    "colors": {"type": "array", "items": _STRING},
    "displayBlanksAs": {"type": "string", "enum": ["gap", "zero", "span"]},
    "holeSize": _NUMBER, "chartAreaFill": _STRING, "plotAreaFill": _STRING,
    "categoryAxisLabelColor": _STRING, "valueAxisLabelColor": _STRING,
    "gridLineColor": _STRING, "dataLabelColor": _STRING,
}


_ELEMENT_TYPES = ["text", "image", "audio", "video", "table", "chart", *_SHAPE_TYPES]
_ELEMENT = _object({
    **_COMMON_ELEMENT_PROPERTIES,
    "type": {"type": "string", "enum": _ELEMENT_TYPES},
    **_TEXT_PROPERTIES,
    **_SHAPE_PROPERTIES,
    **_IMAGE_PROPERTIES,
    **_MEDIA_PROPERTIES,
    **_TABLE_PROPERTIES,
    **_CHART_PROPERTIES,
}, ("id", "type"))
_ELEMENT["description"] = "Use only fields valid for the selected type; image, audio, and video require src."
_OPTIONAL_COMMON_PROPERTIES = {
    "groupId", "flipHorizontal", "flipVertical", "opacity", "shadow", "hyperlink",
    "animation", "animationDuration", "animationDelay", "animationStart", "animationTrigger", "animationColor",
}
_OPTIONAL_TEXT_PROPERTIES = {
    "italic", "underline", "strikethrough", "baseline", "highlightColor", "characterSpacing",
    "verticalAlign", "lineHeight", "lineSpacing", "indentLevel", "listStyle", "textDirection", "wordWrap",
    "textInsets", "textRuns", "paragraphs",
}
_OPTIONAL_CHART_PROPERTIES = {
    "showValue", "title", "displayBlanksAs", "holeSize", "chartAreaFill", "plotAreaFill",
    "categoryAxisLabelColor", "valueAxisLabelColor", "gridLineColor", "dataLabelColor",
}


def _patch_schema(properties: dict[str, Any], nullable: set[str]) -> dict[str, Any]:
    schema = _object({
        key: _nullable(value) if key in nullable else value
        for key, value in {**{key: value for key, value in _COMMON_ELEMENT_PROPERTIES.items() if key != "id"}, **properties}.items()
    })
    schema["minProperties"] = 1
    return schema


_PATCH = _patch_schema(
    {**_TEXT_PROPERTIES, **_SHAPE_PROPERTIES, **_IMAGE_PROPERTIES, **_MEDIA_PROPERTIES, **_TABLE_PROPERTIES, **_CHART_PROPERTIES},
    _OPTIONAL_COMMON_PROPERTIES | _OPTIONAL_TEXT_PROPERTIES | _OPTIONAL_CHART_PROPERTIES
    | {"clipShape", "crop", "connectorPath", "headerTextColor", "radius"},
)
_PATCH["description"] = "Use only fields valid for element_type; omitted fields are preserved."
_PATCH_OPERATION = _object({
    "type": {"const": "patch"},
    "id": _STRING,
    "element_type": {"type": "string", "enum": _ELEMENT_TYPES},
    "patch": _PATCH,
}, ("type", "id", "element_type", "patch"))
_COMMENT = _object({
    "id": _STRING, "author": _STRING, "createdAt": _STRING, "resolved": _BOOLEAN,
    "text": _STRING, "elementId": _STRING,
}, ("id", "text"))
_COMMENT_PATCH = _object({
    "author": _STRING, "resolved": _BOOLEAN, "text": _STRING, "elementId": _nullable(_STRING),
})
_COMMENT_PATCH["minProperties"] = 1
_PAGE_PATCH = _object({
    "name": _STRING,
    "layout": _nullable({"type": "string", "enum": ["blank", "title", "titleContent", "twoContent"]}),
    "background": _nullable(_STRING),
    "notes": _nullable(_STRING),
    "footer": _nullable(_FOOTER),
    "transition": _TRANSITION_PATCH,
})
_PAGE_PATCH["minProperties"] = 1
_PAGE_OPERATIONS = {
    "type": "array",
    "minItems": 1,
    "items": {"oneOf": [
        _object({"type": {"const": "set-page"}, "patch": _PAGE_PATCH}, ("type", "patch")),
        _object({"type": {"const": "add"}, "element": _ELEMENT, **_PLACEMENT}, ("type", "element")),
        _PATCH_OPERATION,
        _object({"type": {"const": "remove"}, "id": _STRING}, ("type", "id")),
        _object({"type": {"const": "reorder"}, "id": _STRING, **_PLACEMENT}, ("type", "id")),
        _object({"type": {"const": "add-comment"}, "comment": _COMMENT}, ("type", "comment")),
        _object({"type": {"const": "patch-comment"}, "id": _STRING, "patch": _COMMENT_PATCH}, ("type", "id", "patch")),
        _object({"type": {"const": "remove-comment"}, "id": _STRING}, ("type", "id")),
    ]},
}
_DESIGN_PATCH = _object({
    "theme": {"type": "string", "enum": ["light", "paper", "midnight", "lavender"]},
    "background": _STRING,
    "accentColors": {"type": "array", "minItems": 1, "items": _STRING},
    "titleFontFamily": _STRING,
    "bodyFontFamily": _STRING,
    "pageSize": {"type": "string", "enum": ["wide", "standard"]},
    "title": _STRING,
    "footer": _FOOTER,
    "transition": _TRANSITION_PATCH,
})
_DESIGN_PATCH["minProperties"] = 1
_NEW_PAGE = _object({
    "id": _STRING, "name": _STRING,
    "layout": {"type": "string", "enum": ["blank", "title", "titleContent", "twoContent"]},
    "background": _STRING, "notes": _STRING, "footer": _FOOTER, "transition": _TRANSITION_PATCH,
}, ("id",))
_DECK_OPERATIONS = {
    "type": "array",
    "minItems": 1,
    "items": {"oneOf": [
        _object({"type": {"const": "set-design"}, "patch": _DESIGN_PATCH}, ("type", "patch")),
        _object({"type": {"const": "insert-page"}, "page": _NEW_PAGE, **_PLACEMENT}, ("type", "page")),
        _object({"type": {"const": "duplicate-page"}, "pageId": _STRING, "id": _STRING, "name": _STRING, **_PLACEMENT}, ("type", "pageId", "id")),
        _object({"type": {"const": "remove-page"}, "pageId": _STRING}, ("type", "pageId")),
        _object({"type": {"const": "move-page"}, "pageId": _STRING, **_PLACEMENT}, ("type", "pageId")),
    ]},
}


def _spec(function: Any, properties: dict[str, Any], required: tuple[str, ...]) -> FunctionToolSpec:
    return FunctionToolSpec.from_raw(function, tool_parameters=_object(properties, required))


powerpoint_tool_specs = [
    _spec(ppt_open, {"target": _STRING}, ("target",)),
    _spec(ppt_read_deck, {
        "document_id": _STRING,
        "query": _object({"include_theme": _BOOLEAN}),
    }, ("document_id",)),
    _spec(ppt_read_page, {
        "document_id": _STRING,
        "page_id": _STRING,
        "query": _object({
            "format": {"type": "string", "enum": ["compact", "model", "both"]},
            "element_ids": {"type": "array", "items": _STRING},
        }),
    }, ("document_id", "page_id")),
    _spec(ppt_inspect, {
        "document_id": _STRING,
        "query": _object({
            "kind": {"const": "render"},
            "page_ids": {"type": "array", "minItems": 1, "maxItems": 12, "items": _STRING},
        }, ("kind",)),
    }, ("document_id", "query")),
    _spec(ppt_edit_page, {
        "document_id": _STRING, "page_id": _STRING, "operations": _PAGE_OPERATIONS, "options": _OPTIONS,
    }, ("document_id", "page_id", "operations")),
    _spec(ppt_manage_deck, {
        "document_id": _STRING, "operations": _DECK_OPERATIONS, "options": _OPTIONS,
    }, ("document_id", "operations")),
    _spec(ppt_save, {"document_id": _STRING, "target": _STRING}, ("document_id",)),
]

POWERPOINT_TOOL_NAMES = frozenset(spec.tool_name for spec in powerpoint_tool_specs)
POWERPOINT_READ_TOOL_NAMES = frozenset({"ppt_read_deck", "ppt_read_page", "ppt_inspect"})

__all__ = [
    "POWERPOINT_READ_TOOL_NAMES",
    "POWERPOINT_TOOL_NAMES",
    "powerpoint_tool_specs",
    "ppt_edit_page",
    "ppt_inspect",
    "ppt_manage_deck",
    "ppt_open",
    "ppt_read_deck",
    "ppt_read_page",
    "ppt_save",
]
