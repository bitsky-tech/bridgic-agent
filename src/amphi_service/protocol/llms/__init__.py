"""LLM provider integration — the protocol with upstream model providers.

What the service does when it needs to "build an LLM client": resolve
the user's stored credentials → init the right provider client → hand
a uniform ``bridgic.llms`` object back. Future provider families with
non-trivial auth flows (OAuth, device-code, MCP, ...) live alongside
:mod:`._factory` here.
"""

from __future__ import annotations

from ._factory import build_llm
from ._providers_catalog import (
    HIDDEN_PROVIDER_IDS,
    PROVIDER_CATALOG,
    PROVIDER_CATALOG_BY_ID,
    catalog_model,
    catalog_model_limits,
    resolve_model_limits,
    supports_image_generation,
    visible_catalog,
)

__all__ = [
    "HIDDEN_PROVIDER_IDS",
    "PROVIDER_CATALOG",
    "PROVIDER_CATALOG_BY_ID",
    "build_llm",
    "catalog_model",
    "catalog_model_limits",
    "resolve_model_limits",
    "supports_image_generation",
    "visible_catalog",
]
