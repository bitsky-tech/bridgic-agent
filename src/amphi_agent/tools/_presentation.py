from typing import List, Optional

from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._state import PresentationStepRecord


class PresentationToolRejection(ValueError):
    """Raised when a presentation progress report is incomplete."""


class PresentationStepReport:
    """The structured result of one presentation production step."""

    def __init__(self, summary: str, evidence: List[str]) -> None:
        self.summary = summary
        self.evidence = evidence


async def report_presentation_step(summary: str, evidence: Optional[List[str]] = None) -> PresentationStepReport:
    """Complete the current presentation step and advance its progress.

    Parameters
    ----------
    summary : str
        Concise, user-readable result of the current production step. Include
        concrete decisions or changes rather than a generic completion claim.
    evidence : list[str], optional
        Relevant source URLs, artifact paths, slide ranges, or inspection notes
        that make the result traceable from the presentation progress panel.

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
    return PresentationStepReport(summary, clean_evidence)


report_presentation_step_tool = FunctionToolSpec.from_raw(report_presentation_step)


__all__ = [
    "PresentationStepReport",
    "report_presentation_step",
    "report_presentation_step_tool",
]
