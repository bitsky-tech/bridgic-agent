"""build_llm — Registry dispatch by protocol + the shared api_key gate.

Construction is offline (SDK clients don't touch the network at init), so these
run without any API key. Codex dispatch is covered separately in
``test_codex_factory.py`` (it needs ~/.codex credential monkeypatching).
"""

from __future__ import annotations

import pytest

from src.amphi_service.protocol.llms._factory import build_llm
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicLlm
from src.amphi_service.protocol.llms.google_llm import GoogleLlm
from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm
from src.amphi_store import User


def _user(protocol: str, *, api_key="sk-test") -> User:
    return User(id="local", current_model="m", protocol=protocol, api_key=api_key)


def test_registry_dispatch_by_protocol() -> None:
    assert isinstance(build_llm(_user("anthropic"), "claude-x"), AnthropicLlm)
    assert isinstance(build_llm(_user("google"), "gemini-x"), GoogleLlm)
    assert isinstance(build_llm(_user("openai"), "gpt-x"), OpenAICompatLlm)


def test_unknown_protocol_falls_to_openai_compat() -> None:
    """A typo / unknown protocol must not 500 — it defaults to OpenAI-compat."""
    assert isinstance(build_llm(_user("totally-unknown"), "gpt-x"), OpenAICompatLlm)


def test_api_key_gate_fires_for_keyless_non_codex() -> None:
    for protocol in ("openai", "anthropic", "google"):
        with pytest.raises(ValueError, match="No API key"):
            build_llm(_user(protocol, api_key=None), "m")
