import ast
import json
from typing import Any, Dict, List, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._state import PresentationStepRecord


class PresentationToolRejection(ValueError):
    """Raised when a presentation progress report is incomplete."""


def parse_presentation_step_data(value: Any) -> Dict[str, Any]:
    """Decode the JSON-string transport contract for presentation report data."""
    if value is None or value == "":
        return {}
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        for parse in (json.loads, ast.literal_eval):
            try:
                parsed = parse(value)
            except (TypeError, ValueError, SyntaxError):
                continue
            if isinstance(parsed, dict):
                return dict(parsed)
    raise ValueError("`data` must be a JSON object string.")


class PresentationStepReport:
    """The structured result of one presentation production step."""

    def __init__(self, summary: str, evidence: List[str], data: Optional[Dict[str, Any]] = None) -> None:
        self.summary = summary
        self.evidence = evidence
        self.data = dict(data or {})


async def report_presentation_step(summary: str, evidence: Optional[List[str]] = None, data: Optional[str] = None) -> PresentationStepReport:
    """Complete the current presentation step and advance its progress.

    Parameters
    ----------
    summary : str
        Concise, user-readable result of the current production step. Include
        concrete decisions or changes rather than a generic completion claim.
    evidence : list[str], optional
        Relevant source URLs, artifact paths, slide ranges, or inspection notes
        that make the result traceable from the presentation progress panel.
    data : str, optional
        JSON-encoded current-step result. Plan uses ``sources`` for collected
        evidence and ``chapters`` for the editable chapter or slide outline.
        Stable source, chapter, and slide ids are assigned by the runtime.

    Returns
    -------
    PresentationStepReport
        Structured progress consumed by the Agent runtime.
    """
    summary = summary.strip()
    if not summary:
        raise PresentationToolRejection(
            "report_presentation_step rejected: `summary` must be non-empty."
        )
    clean_evidence = PresentationStepRecord.normalize_evidence(evidence)
    try:
        parsed_data = parse_presentation_step_data(data)
    except ValueError as exc:
        raise PresentationToolRejection(f"report_presentation_step rejected: {exc}") from exc
    return PresentationStepReport(summary, clean_evidence, parsed_data)


report_presentation_step_tool = FunctionToolSpec.from_raw(report_presentation_step)


__all__ = [
    "PresentationStepReport",
    "parse_presentation_step_data",
    "report_presentation_step",
    "report_presentation_step_tool",
]
