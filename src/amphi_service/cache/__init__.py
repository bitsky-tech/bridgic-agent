"""Service-owned in-memory caches that die with the daemon.

The hot cache (per-(user, model) LLM clients) and connected-client registry are
standalone :class:`Registry` peers held directly by ``ServiceState``. The live
turn-execution and event-bus machinery lives in :mod:`..runtime`.
"""

from __future__ import annotations

from ._base import Registry
from ._clients import ClientInfo, ClientRegistry, ClientType
from ._llms import LlmCache

__all__ = [
    "Registry",
    "LlmCache",
    "ClientInfo",
    "ClientRegistry",
    "ClientType",
]
