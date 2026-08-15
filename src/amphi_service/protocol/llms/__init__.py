"""LLM provider integration — the protocol with upstream model providers.

What the service does when it needs to "build an LLM client": resolve
the user's stored credentials → init the right provider client → hand
a uniform ``bridgic.llms`` object back. Future provider families with
non-trivial auth flows (OAuth, device-code, MCP, ...) live alongside
:mod:`._factory` here.
"""

from __future__ import annotations

from ._factory import build_llm

__all__ = ["build_llm"]
