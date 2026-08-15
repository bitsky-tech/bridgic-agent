"""Security layer — the permission policy for tool calls.

The public entry point is :class:`PermissionEngine` (a facade over the four-layer
engine): rules (capability + boundary) -> rule layer (cross-cutting always-deny /
always-allow) -> mode layer (ask / classify / allow) -> safety classifier (the
workhorse in auto mode).

The final verdict uses :class:`Permission`; the remaining types describe the
capability, boundary and action involved in reaching it.
"""

from __future__ import annotations

from ._classifier import (
    ClassifyItem,
    ClassifyVerdict,
    LlmSafetyClassifier,
    SafetyClassifier,
)
from ._engine import PermissionEngine
from ._types import Action, Boundary, Capability, ExecutionMode, Judgement, Permission

__all__ = [
    "PermissionEngine",
    "ExecutionMode",
    "Judgement",
    "Capability",
    "Boundary",
    "Action",
    "SafetyClassifier",
    "LlmSafetyClassifier",
    "ClassifyItem",
    "ClassifyVerdict",
    "Permission",
]
