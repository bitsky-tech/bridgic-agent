"""Stage declarations exposed to the Agent execution engine."""

from dataclasses import dataclass
from typing import Callable, TypeVar

from .base import MainThink


_Worker = TypeVar("_Worker", bound=MainThink)


@dataclass(frozen=True)
class CognitiveStage:
    """Routing metadata and the worker type owned by one stage."""

    mode: str
    stage: str
    order: int
    worker_class: type[MainThink]


_registry: dict[str, CognitiveStage] = {}


def cognitive_stage(*, mode: str, stage: str, order: int) -> Callable[[type[_Worker]], type[_Worker]]:
    """Register a stage when its module is imported, preserving its worker class."""
    def register(worker_class: type[_Worker]) -> type[_Worker]:
        if stage in _registry:
            raise ValueError(f"Cognitive stage {stage!r} is already registered.")
        _registry[stage] = CognitiveStage(mode, stage, order, worker_class)
        return worker_class

    return register


def get_cognitive_stages() -> tuple[CognitiveStage, ...]:
    """Return registered stage definitions in a stable order."""
    return tuple(sorted(_registry.values(), key=lambda entry: (entry.mode, entry.order, entry.stage)))


__all__ = ["CognitiveStage", "cognitive_stage", "get_cognitive_stages"]
