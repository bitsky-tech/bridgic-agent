from collections.abc import Callable
from typing import Any

import pytest

from src.amphi_service.protocol.llms import _factory
from src.amphi_service.protocol.llms._codex_credentials import CodexCreds
from src.amphi_service.protocol.llms.anthropic_llm import AnthropicLlm
from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm
from src.amphi_service.protocol.llms.google_llm import GoogleLlm
from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm
from src.amphi_store import User


async def test_factory_routes_credentials_to_the_protocol_adapter(provider_user: Callable[..., User], monkeypatch: pytest.MonkeyPatch) -> None:
    clients: list[Any] = []

    async def close_clients() -> None:
        for llm in clients:
            llm.client.close()
            close = getattr(llm.async_client, "aclose", None) or llm.async_client.close
            await close()

    try:
        adapters = (
            _factory.build_llm(provider_user("openai"), "gpt-test"),
            _factory.build_llm(provider_user("anthropic"), "claude-test"),
            _factory.build_llm(provider_user("google"), "gemini-test"),
            _factory.build_llm(provider_user("unknown"), "compatible-test"),
        )
        clients.extend(adapters)
        assert [type(adapter) for adapter in adapters] == [
            OpenAICompatLlm,
            AnthropicLlm,
            GoogleLlm,
            OpenAICompatLlm,
        ]
        assert [adapter.configuration.model for adapter in adapters] == [
            "gpt-test",
            "claude-test",
            "gemini-test",
            "compatible-test",
        ]

        monkeypatch.setattr(
            _factory,
            "resolve_codex_credentials",
            lambda: CodexCreds(
                access_token="access-token",
                refresh_token="refresh-token",
                account_id="account-id",
                id_token=None,
            ),
        )
        codex = _factory.build_llm(provider_user("openai-codex", api_key=None), "gpt-codex")
        clients.append(codex)
        assert isinstance(codex, CodexResponsesLlm)
        assert codex.account_id == "account-id"
        assert codex.configuration.model == "gpt-codex"

        for protocol in ("openai", "anthropic", "google"):
            with pytest.raises(ValueError, match="No API key"):
                _factory.build_llm(provider_user(protocol, api_key=None), "model")
        monkeypatch.setattr(_factory, "resolve_codex_credentials", lambda: None)
        with pytest.raises(ValueError, match="Codex"):
            _factory.build_llm(provider_user("openai-codex", api_key=None), "model")
    finally:
        await close_clients()
