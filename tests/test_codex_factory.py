"""Codex catalog folding + build_llm dispatch.

build_llm must route ``protocol == 'openai-codex'`` to CodexResponsesLlm using
~/.codex credentials (no api_key), and surface a clear error when none exist.
Codex is folded into the dual-auth ``openai`` catalog entry, not a separate one.
``resolve_codex_credentials`` is monkeypatched — no real ~/.codex access.
"""

from __future__ import annotations

import pytest

from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol._providers_catalog import PROVIDER_CATALOG_BY_ID
from src.amphi_service.protocol.llms import _factory
from src.amphi_service.protocol.llms._codex_credentials import CodexCreds
from src.amphi_service.protocol.llms.codex_llm import CodexResponsesLlm
from src.amphi_store import User


def _codex_user() -> User:
    return User(id="local", current_model="gpt-5.4", protocol="openai-codex")


def test_build_llm_codex_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    """build_llm routes a Codex user to CodexResponsesLlm via ~/.codex creds
    (protocol/account/model wired through, and the api_key gate stays silent for a
    keyless Codex user); missing creds raise a clear ValueError. Also asserts the
    catalog invariant Codex relies on: it is folded into the dual-auth ``openai``
    provider (api_key + oauth, oauth the recommended default), never a separate
    ``openai-codex`` catalog entry."""
    # Catalog: Codex is the oauth half of the openai channel, not its own entry.
    entry = PROVIDER_CATALOG_BY_ID["openai"]
    assert "oauth" in entry["auth_modes"]
    assert "api_key" in entry["auth_modes"]
    assert entry["default_auth_mode"] == "oauth"
    assert "openai-codex" not in PROVIDER_CATALOG_BY_ID

    monkeypatch.setattr(
        _factory,
        "resolve_codex_credentials",
        lambda: CodexCreds(
            access_token="at", refresh_token="rt", account_id="acct", id_token=None
        ),
    )
    user = _codex_user()
    # A Codex user has no api_key — the api_key gate must not fire.
    assert user.api_key is None
    llm = _factory.build_llm(user, "gpt-5.4")
    assert isinstance(llm, CodexResponsesLlm)
    assert llm.protocol == "openai-codex"
    assert llm.account_id == "acct"
    assert llm.configuration.model == "gpt-5.4"

    # No ~/.codex creds → clear, Codex-mentioning failure.
    monkeypatch.setattr(_factory, "resolve_codex_credentials", lambda: None)
    with pytest.raises(ValueError, match="Codex"):
        _factory.build_llm(_codex_user(), "gpt-5.4")


def test_missing_codex_credentials_error_uses_the_active_service_locale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_factory, "resolve_codex_credentials", lambda: None)

    with use_locale("en"), pytest.raises(ValueError) as error:
        _factory.build_llm(_codex_user(), "gpt-5.4")

    assert str(error.value) == (
        "No Codex credentials for user 'local'. Complete Codex subscription authorization "
        "and try again (POST /me/providers/openai-codex/oauth/start)."
    )
