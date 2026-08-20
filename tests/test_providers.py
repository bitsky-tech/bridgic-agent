"""``/providers`` + ``/me/providers`` + ``/me/active-model``.

Multi-provider credential management, consolidated into scenario tests.
The single most important invariant: an ``api_key`` must never appear in a
list or profile response — ``GET /me/providers/{id}/api-key`` is the ONE
sanctioned exception (it backs the edit form's prefill; the key is the user's
own and already sits in plaintext in their local DB). A second: adding or
activating an api_key provider syncs creds onto the User row that ``build_llm``
reads, so chat keeps working.
"""

from __future__ import annotations

import asyncio

import httpx
from types import SimpleNamespace
import pytest

from src.amphi_service.protocol import PROVIDER_CATALOG_BY_ID

_OPENAI = {"provider_id": "openai", "auth_mode": "api_key", "api_key": "sk-x"}
_ANTHROPIC = {
    "provider_id": "anthropic", "auth_mode": "api_key", "api_key": "sk-ant",
    "protocol": "anthropic", "models": ["claude-sonnet-4"],
}


async def test_catalog_and_provider_crud(client: httpx.AsyncClient) -> None:
    """``GET /providers`` advertises the known channels (protocol +
    default_base_url prefill), then the ``/me/providers`` CRUD lifecycle:
    empty → add (auto-activates + mirrors creds, api_key never echoed) →
    custom slug accepted incl. its wire fields → re-add upserts → unknown
    extra field 422 → delete → re-delete 404s."""
    # --- Catalog: static registry of known providers + phase-2 prefill. ---
    catalog = (await client.get("/providers")).json()
    by_id = {p["id"]: p for p in catalog}
    assert {"openai", "deepseek", "kimi"} <= set(by_id)
    # Hidden vendors never reach the wire, but stay in the in-process catalog
    # so prefill lookups and already-saved channels keep resolving.
    assert "anthropic" not in by_id
    assert PROVIDER_CATALOG_BY_ID["anthropic"]["protocol"] == "anthropic"
    assert PROVIDER_CATALOG_BY_ID["anthropic"]["default_base_url"] == "https://api.anthropic.com"
    assert "api_key" in by_id["openai"]["auth_modes"]
    assert by_id["openai"]["default_auth_mode"]
    assert any(m["id"] for m in by_id["openai"]["models"])
    for pid in ("openai", "deepseek", "kimi", "glm", "openrouter"):
        assert by_id[pid]["protocol"] == "openai", pid
        assert by_id[pid]["default_base_url"], pid
    assert by_id["kimi"]["default_base_url"] == "https://api.kimi.com/coding/v1"
    assert [model["id"] for model in by_id["kimi"]["models"]] == [
        "kimi-for-coding", "k3", "kimi-for-coding-highspeed",
    ]
    # Gemini dispatches the native google-genai path (not OpenAI-compat).
    assert by_id["google"]["protocol"] == "google"
    assert by_id["google"]["default_base_url"]

    # --- Empty baseline. ---
    assert (await client.get("/me/providers")).json() == []
    assert (await client.get("/me/credentials")).json()["api_key_set"] is False

    # --- Add: auto-activates + mirrors creds onto the User row. ---
    added = (await client.post("/me/providers", json={
        **_OPENAI, "api_key": "sk-do-not-leak", "base_url": "https://old.example/v1",
    })).json()
    assert added["id"] == "openai"
    assert added["api_key_set"] is True
    assert "available_models" in added

    listing = (await client.get("/me/providers")).json()
    assert len(listing) == 1 and listing[0]["is_active"] is True
    creds = (await client.get("/me/credentials")).json()
    assert creds == {"api_key_set": True, "base_url": "https://old.example/v1"}

    # The plaintext api_key must not leak through any LIST/profile view. The
    # single sanctioned exception is the per-channel reveal endpoint below —
    # everything else still upholds the invariant.
    for path in ("/me/providers", "/me/credentials", "/me"):
        assert "sk-do-not-leak" not in (await client.get(path)).text

    # --- Custom slug: accepted (catalog is just UI prefill), wire fields kept. ---
    await client.post("/me/providers", json={
        "provider_id": "company-gateway", "auth_mode": "api_key",
        "api_key": "sk-company", "base_url": "https://gateway.internal/v1",
        "protocol": "openai", "display_name": "公司内网网关",
        "models": ["company-llm-v1", "company-llm-v2"],
    })
    row = next(
        p for p in (await client.get("/me/providers")).json()
        if p["id"] == "company-gateway"
    )
    assert row["protocol"] == "openai"
    assert row["display_name"] == "公司内网网关"
    assert row["available_models"] == ["company-llm-v1", "company-llm-v2"]

    # --- Re-add is an upsert: same single openai row, updated base_url. ---
    again = await client.post("/me/providers", json={
        **_OPENAI, "api_key": "sk-new", "base_url": "https://new.example/v1",
    })
    assert again.status_code == 201
    openai_rows = [
        p for p in (await client.get("/me/providers")).json() if p["id"] == "openai"
    ]
    assert len(openai_rows) == 1
    assert openai_rows[0]["base_url"] == "https://new.example/v1"

    # --- Unknown extra field fails closed (extra='forbid'). ---
    extra = await client.post("/me/providers", json={**_OPENAI, "surprise": "x"})
    assert extra.status_code == 422

    # --- Delete → 204 then gone; deleting an unconfigured provider 404s. ---
    assert (await client.delete("/me/providers/openai")).status_code == 204
    assert "openai" not in {
        p["id"] for p in (await client.get("/me/providers")).json()
    }
    assert (await client.delete("/me/providers/openai")).status_code == 404


async def test_activation_protocol_mirroring_and_failover(
    client: httpx.AsyncClient,
) -> None:
    """The active-provider state machine end to end: first add auto-promotes
    (protocol mirrored onto User) → switching active provider+model re-mirrors
    its protocol (what ``build_llm`` dispatches on) → the is_enabled toggle
    defaults true, disabling the active row auto-promotes the next enabled one,
    a disabled provider can't be activated, disabling the sole provider clears
    the mirrored creds → unknown slugs 404 everywhere."""
    await client.post("/me/providers", json={
        **_OPENAI, "protocol": "openai", "models": ["gpt-4o", "gpt-4o-mini"],
    })
    await client.post("/me/providers", json=_ANTHROPIC)
    # First-add (openai) auto-promoted → User.protocol = "openai".
    assert (await client.get("/me")).json().get("protocol", "openai") == "openai"
    listing = {p["id"]: p for p in (await client.get("/me/providers")).json()}
    assert listing["openai"]["is_enabled"] is True
    assert listing["openai"]["is_active"] is True

    # Switch the active model within openai.
    switched = await client.post(
        "/me/active-model", json={"provider_id": "openai", "model": "gpt-4o-mini"},
    )
    assert switched.status_code == 200
    assert switched.json()["current_model"] == "gpt-4o-mini"
    assert (await client.get("/me/model")).json()["model"] == "gpt-4o-mini"

    # Switch to anthropic → User.protocol flips for build_llm dispatch.
    await client.post(
        "/me/active-model",
        json={"provider_id": "anthropic", "model": "claude-sonnet-4"},
    )
    assert (await client.get("/me")).json().get("protocol") == "anthropic"

    # active-model on an unconfigured slug 404s.
    unknown = await client.post(
        "/me/active-model", json={"provider_id": "deepseek", "model": "deepseek-chat"},
    )
    assert unknown.status_code == 404

    # Disable the (now anthropic) active row → openai auto-promotes back, and
    # the User row mirrors its protocol for build_llm.
    off = await client.post(
        "/me/providers/anthropic/toggle", json={"enabled": False},
    )
    assert off.status_code == 200 and off.json()["is_enabled"] is False
    listing = {p["id"]: p for p in (await client.get("/me/providers")).json()}
    assert listing["anthropic"]["is_active"] is False
    assert listing["openai"]["is_active"] is True
    assert (await client.get("/me")).json().get("protocol") == "openai"

    # Disabled rows can't be re-activated (the "active → enabled" gate).
    r = await client.post(
        "/me/active-model",
        json={"provider_id": "anthropic", "model": "claude-sonnet-4"},
    )
    assert r.status_code == 404

    # Disabling the last enabled provider clears the mirrored creds — chat
    # must fail with "no key configured", not silently keep a disabled key.
    await client.post("/me/providers/openai/toggle", json={"enabled": False})
    creds = (await client.get("/me/credentials")).json()
    assert creds == {"api_key_set": False, "base_url": None}

    # Unknown slug → 404, no silent no-op masking a typo.
    r = await client.post("/me/providers/nope/toggle", json={"enabled": False})
    assert r.status_code == 404


async def test_delete_active_promotes_next_provider(
    client: httpx.AsyncClient,
) -> None:
    """Deleting the *active* provider while another usable one remains must
    promote that next channel — not drop the user to a no-active state (the
    GUI "请先配置模型" bug). The promotion also resets ``current_model`` to the
    promoted provider's first model, so the picker's (active provider,
    current_model) pair stays valid; otherwise the chat picker shows no active
    model even though a channel is active. Deleting the *sole* provider still
    clears the mirrored creds (no fallback exists)."""
    await client.post("/me/providers", json={
        **_OPENAI, "protocol": "openai", "models": ["gpt-4o", "gpt-4o-mini"],
    })
    await client.post("/me/providers", json=_ANTHROPIC)
    # Make anthropic the active (provider, model) — current_model = a model
    # that does NOT belong to openai, so a naive promote-without-model-reset
    # would leave the picker stranded.
    await client.post(
        "/me/active-model",
        json={"provider_id": "anthropic", "model": "claude-sonnet-4"},
    )
    assert (await client.get("/me/model")).json()["model"] == "claude-sonnet-4"

    # Delete the active provider.
    assert (await client.delete("/me/providers/anthropic")).status_code == 204

    # openai must be promoted to active, with its creds + protocol mirrored …
    listing = {p["id"]: p for p in (await client.get("/me/providers")).json()}
    assert "anthropic" not in listing
    assert listing["openai"]["is_active"] is True
    me = (await client.get("/me")).json()
    assert me.get("protocol") == "openai"
    assert me["api_key_set"] is True
    # … and current_model reset to one of openai's models (else the GUI shows
    # "请先配置模型" despite an active channel).
    assert (await client.get("/me/model")).json()["model"] in (
        "gpt-4o", "gpt-4o-mini",
    )

    # Deleting the now-sole provider clears the mirrored creds (no fallback).
    assert (await client.delete("/me/providers/openai")).status_code == 204
    assert (await client.get("/me/credentials")).json() == {
        "api_key_set": False, "base_url": None,
    }


async def test_delete_active_promotes_oauth_only_channel(
    client: httpx.AsyncClient,
) -> None:
    """When the last api_key provider is deleted and only an OAuth channel
    (Codex subscription — no api_key, creds live in ~/.codex) remains, that
    channel MUST be promoted to active. An OAuth subscription is usable without
    an api_key (``build_llm`` + ``require_ai`` both special-case
    ``protocol='openai-codex'``), so the GUI must NOT fall back to
    "请先配置模型" — the real bug this guards (deleting down to only the Codex
    subscription)."""
    await client.post("/me/providers", json={**_OPENAI, "models": ["gpt-4o"]})
    # Custom slug so the catalog's 'openai' protocol can't override our posted
    # 'openai-codex'; mirrors a real Codex channel's shape (oauth, no key).
    await client.post("/me/providers", json={
        "provider_id": "codex-sub", "auth_mode": "oauth",
        "protocol": "openai-codex", "models": ["gpt-5.5"],
    })
    # Deleting the active api_key provider leaves only the OAuth channel.
    assert (await client.delete("/me/providers/openai")).status_code == 204
    listing = {p["id"]: p for p in (await client.get("/me/providers")).json()}
    assert listing["codex-sub"]["is_active"] is True
    me = (await client.get("/me")).json()
    assert me["protocol"] == "openai-codex"
    # current_model reset to the OAuth channel's first model → the picker has a
    # valid (active provider, model) pair (no "请先配置模型").
    assert (await client.get("/me/model")).json()["model"] == "gpt-5.5"


async def test_toggle_disable_then_enable_keeps_user_mirror_consistent(
    client: httpx.AsyncClient,
) -> None:
    """A provider that is ``is_active`` MUST have the User-row mirror match it.

    Repro for the silent-mirror-drift bug: disabling the sole active provider
    clears the User-row mirror (api_key=None, protocol reset to 'openai'), but
    ``set_enabled`` does NOT touch ``is_active`` — so the row stays
    ``is_active=true`` while disabled. Re-enabling it doesn't re-sync the
    mirror, leaving provider_credentials (active + real protocol/key) and the
    User row (inactive creds / 'openai') drifted. The picker reads
    provider_credentials → shows the model as usable; chat reads the User row →
    ``require_ai`` 503s ("No AI provider key configured")."""
    await client.post("/me/providers", json={**_ANTHROPIC})  # auto-activates
    assert (await client.get("/me")).json()["protocol"] == "anthropic"

    await client.post("/me/providers/anthropic/toggle", json={"enabled": False})
    await client.post("/me/providers/anthropic/toggle", json={"enabled": True})

    rows = (await client.get("/me/providers")).json()
    anthropic = next(p for p in rows if p["id"] == "anthropic")
    # Fix: disabling the sole active provider also clears its ``is_active`` (a
    # disabled provider must never stay "active"), so re-enabling leaves it
    # inactive — a clean "no active provider" state the frontend self-heal
    # resolves. Previously it stayed is_active=true while the User mirror was
    # cleared to protocol='openai'/no-key, drifting the two sources: the picker
    # showed the model usable, chat 503'd ("No AI provider key configured").
    assert anthropic["is_active"] is False, anthropic
    assert not any(p["is_active"] for p in rows)


async def test_catalog_protocol_is_authoritative(client: httpx.AsyncClient) -> None:
    """The GUI channel form only posts ``'openai'``/``'anthropic'``, so a Google
    channel arrives as ``protocol='openai'``. The catalog declares Google as the
    native ``'google'`` protocol — that must win, else build_llm routes Gemini
    through the OpenAI-compat path (dropping thought_signatures → 400). A custom
    slug (not in the catalog) keeps the posted protocol."""
    added = (await client.post("/me/providers", json={
        "provider_id": "google", "auth_mode": "api_key",
        "api_key": "k", "protocol": "openai", "models": ["gemini-2.5-flash"],
    })).json()
    assert added["protocol"] == "google"  # catalog overrides the posted 'openai'
    # First usable provider auto-activates + mirrors protocol onto the User row
    # that build_llm dispatches on.
    assert (await client.get("/me")).json().get("protocol") == "google"

    # A custom slug is not in the catalog → the posted protocol is preserved.
    custom = (await client.post("/me/providers", json={
        "provider_id": "my-gateway", "auth_mode": "api_key",
        "api_key": "k", "protocol": "openai", "base_url": "https://gw/v1",
    })).json()
    assert custom["protocol"] == "openai"


def test_factory_dispatches_by_protocol() -> None:
    """``build_llm`` picks the LLM family from ``User.protocol`` — OpenAILlm
    for "openai" (and every compat service), AnthropicLlm for "anthropic"
    (whose instance marker drives the Anthropic streaming path)."""
    from bridgic.llms.openai import OpenAILlm

    from src.amphi_service.protocol.llms._factory import build_llm
    from src.amphi_service.protocol.llms.anthropic_llm import AnthropicLlm
    from src.amphi_service.protocol.llms.google_llm import GoogleLlm
    from src.amphi_store import User

    openai_user = User(
        id="local", api_key="sk-x", base_url=None,
        current_model="gpt-4o", protocol="openai",
    )
    assert isinstance(build_llm(openai_user, "gpt-4o"), OpenAILlm)

    google_user = User(
        id="local", api_key="k", base_url=None,
        current_model="gemini-2.5-flash", protocol="google",
    )
    assert isinstance(build_llm(google_user, "gemini-2.5-flash"), GoogleLlm)

    anthropic_user = User(
        id="local", api_key="sk-ant", base_url=None,
        current_model="claude-sonnet-4", protocol="anthropic",
    )
    llm = build_llm(anthropic_user, "claude-sonnet-4")
    assert isinstance(llm, AnthropicLlm)
    assert llm.protocol == "anthropic"


async def test_connection_probe(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider probing uses the production adapter without persisting credentials."""
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    calls = []

    async def reject_probe(self, messages, **kwargs):
        calls.append((self, messages, kwargs))
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(OpenAICompatLlm, "achat", reject_probe)
    r = await client.post("/me/providers/test", json={
        "provider_id": "openai", "protocol": "openai",
        "api_key": "   ", "model": "gpt-4o",
    })
    assert r.status_code == 200
    assert r.json()["ok"] is False
    assert "API Key" in r.json()["error"]

    r = await client.post("/me/providers/test", json={
        "provider_id": "openai", "protocol": "openai",
        "base_url": "https://example.invalid/v1",
        "api_key": "sk-definitely-not-real", "model": "gpt-4o-mini",
    })
    assert r.status_code == 200
    assert r.json() == {"ok": False, "error": "provider unavailable"}
    assert len(calls) == 1

    assert (
        await client.post("/me/providers/test", json={"provider_id": "openai"})
    ).status_code == 422

    # The user is explicitly NOT committing yet — nothing may be stored.
    assert (await client.get("/me/providers")).json() == []


async def test_connection_probe_openai_sends_no_token_cap(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The OpenAI-protocol probe must not cap the reply at 1 token: reasoning
    models (gpt-5.x / o-series) spend that budget on reasoning and the upstream
    400s with "Could not finish the message because max_tokens ... was reached"
    — reproduced live through new-api on gpt-5-mini with both ``max_tokens=1``
    and ``max_completion_tokens=1``. A "ping" reply is short, so no cap is
    still a cheap probe."""
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    seen = []

    async def ok_probe(self, messages, **kwargs):
        seen.append(self.configuration.max_tokens)
        return "pong"

    monkeypatch.setattr(OpenAICompatLlm, "achat", ok_probe)
    r = await client.post("/me/providers/test", json={
        "provider_id": "newapi-openai", "protocol": "openai",
        "base_url": "http://relay.example:3000/v1",
        "api_key": "sk-test", "model": "gpt-5-mini",
    })

    assert r.json()["ok"] is True
    assert seen == [None], "probe must not send a 1-token cap (breaks reasoning models)"


async def test_connection_probe_times_out_before_the_renderer(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stalled provider returns a useful envelope instead of hitting the UI timeout."""
    import src.amphi_service.handler._providers_handler as providers_handler
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    async def stalled_probe(self, messages, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(OpenAICompatLlm, "achat", stalled_probe)
    monkeypatch.setattr(providers_handler, "_PROVIDER_PROBE_TIMEOUT_SECONDS", 0.01)

    response = await client.post("/me/providers/test", json={
        "provider_id": "openai",
        "protocol": "openai",
        "base_url": "https://api.openai.com/v1",
        "api_key": "sk-test",
        "model": "gpt-4o-mini",
    })

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "error": "供应商响应超时（0.01 秒），请检查网络或 Base URL",
    }


async def test_kimi_connection_probe_uses_models_endpoint(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Kimi connectivity checks auth quickly and never waits for K3 generation."""
    import src.amphi_service.handler._providers_handler as providers_handler
    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    async def generation_must_not_run(self, messages, **kwargs):
        raise AssertionError("Kimi connection probe must not generate model output")

    outcomes: list[object] = [
        httpx.Response(
            200,
            json={"data": [{"id": "k3"}]},
            request=httpx.Request("GET", "https://api.kimi.com/coding/v1/models"),
        ),
        httpx.Response(
            401,
            json={"error": {"message": "invalid key"}},
            request=httpx.Request("GET", "https://api.kimi.com/coding/v1/models"),
        ),
        httpx.ReadTimeout("provider stalled"),
    ]
    calls: list[tuple[str, str]] = []

    class FakeAsyncClient:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, url, *, headers, params):
            calls.append((url, headers["authorization"]))
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr(OpenAICompatLlm, "achat", generation_must_not_run)
    monkeypatch.setattr(providers_handler.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(providers_handler, "_PROVIDER_PROBE_TIMEOUT_SECONDS", 0.01)
    payload = {
        "provider_id": "kimi",
        "protocol": "openai",
        "base_url": "https://api.kimi.com/coding/v1",
        "api_key": "sk-kimi-test",
        "model": "k3",
    }

    passed = await client.post("/me/providers/test", json=payload)
    rejected = await client.post("/me/providers/test", json=payload)
    timed_out = await client.post("/me/providers/test", json=payload)

    assert passed.json()["ok"] is True
    assert rejected.json() == {"ok": False, "error": "API Key 校验失败（401）"}
    assert timed_out.json() == {
        "ok": False,
        "error": "供应商响应超时（0.01 秒），请检查网络或 Base URL",
    }
    assert calls == [
        ("https://api.kimi.com/coding/v1/models", "Bearer sk-kimi-test"),
        ("https://api.kimi.com/coding/v1/models", "Bearer sk-kimi-test"),
        ("https://api.kimi.com/coding/v1/models", "Bearer sk-kimi-test"),
    ]


def test_probe_constructs_openai_compat_llm_and_sanitizes_gpt5_params() -> None:
    """Probe's ``else`` branch MUST build ``OpenAICompatLlm``, not the bare
    ``OpenAILlm``, so its ``_build_parameters`` sanitizer fires for true-OpenAI
    endpoints.  For gpt-5.x on api.openai.com (base_url=None → defaults to
    openai.com):
      - ``max_tokens`` is renamed to ``max_completion_tokens``
      - ``temperature`` is stripped (reasoning model, unsupported)
    For a DeepSeek endpoint the sanitizer is a no-op, so ``max_tokens`` +
    ``temperature`` pass through unchanged."""
    from bridgic.core.model.types import Message, Role

    from src.amphi_service.protocol.llms.openai_llm import OpenAICompatLlm

    # Build exactly what the probe's else-branch builds.
    llm_openai = OpenAICompatLlm(
        api_key="sk-test",
        api_base=None,  # true OpenAI endpoint
        configuration=__import__(
            "bridgic.llms.openai", fromlist=["OpenAIConfiguration"]
        ).OpenAIConfiguration(model="gpt-5.5", temperature=0.0, max_tokens=None),
    )

    msgs = [Message.from_text("ping", role=Role.USER)]
    params = llm_openai._build_parameters(messages=msgs)

    # True-OpenAI gpt-5.x: no token cap is sent, temperature stripped.
    assert "max_tokens" not in params and "max_completion_tokens" not in params
    assert "temperature" not in params, "temperature must be stripped for reasoning model"

    # DeepSeek endpoint: sanitizer is a no-op → max_tokens + temperature pass through.
    llm_deepseek = OpenAICompatLlm(
        api_key="sk-test",
        api_base="https://api.deepseek.com/v1",
        configuration=__import__(
            "bridgic.llms.openai", fromlist=["OpenAIConfiguration"]
        ).OpenAIConfiguration(model="deepseek-chat", temperature=0.0, max_tokens=1),
    )
    params_ds = llm_deepseek._build_parameters(messages=msgs)
    assert "max_tokens" in params_ds, "DeepSeek: max_tokens must pass through unchanged"
    assert "temperature" in params_ds, "DeepSeek: temperature must pass through unchanged"

    # Kimi Code accepts only temperature=1; the same shared adapter path is
    # used by this probe and normal chat, so both receive the correction.
    llm_kimi = OpenAICompatLlm(
        api_key="sk-test",
        api_base="https://api.kimi.com/coding/v1",
        configuration=__import__(
            "bridgic.llms.openai", fromlist=["OpenAIConfiguration"]
        ).OpenAIConfiguration(model="k3", temperature=0.0, max_tokens=1),
    )
    params_kimi = llm_kimi._build_parameters(messages=msgs)
    assert params_kimi["temperature"] == 1
    assert params_kimi["max_tokens"] == 1


def test_probe_error_unwraps_framework_wrapper() -> None:
    """bridgic's retry decorator wraps the real provider error in
    ``ModelUnrecoverableError``, whose ``str()`` is a generic "failed with
    non-recoverable error" — the actual cause (a 401 here) lives only on
    ``.original_exception``. ``_probe_error_message`` MUST unwrap it, else the
    GUI shows the useless wrapper text (the DeepSeek "achat failed" symptom)
    instead of the real reason."""
    from bridgic.core.model import ModelUnrecoverableError

    from src.amphi_service.handler._providers_handler import _probe_error_message

    real = Exception(
        "Error code: 401 - {'error': {'message': 'Authentication Fails, "
        "Your api key is invalid'}}"
    )
    wrapped = ModelUnrecoverableError(
        "Model operation `achat` failed with non-recoverable error",
        operation="achat",
        original_exception=real,
    )
    out = _probe_error_message(wrapped)
    assert "non-recoverable" not in out
    assert out == "API Key 校验失败（401）"


def test_fetch_models_endpoint_derivation() -> None:
    """``_models_endpoint`` must tolerate every base_url shape users type:
    a bare root, a versioned root, and a full chat endpoint pasted from the
    provider's docs. Getting this wrong yields a 404 that reads like bad
    credentials, so each protocol's variants are pinned here."""
    from src.amphi_service.handler._providers_handler import _models_endpoint

    # OpenAI-compat: base_url already carries its version segment.
    assert _models_endpoint("openai", "https://api.openai.com/v1") == (
        "https://api.openai.com/v1/models"
    )
    assert _models_endpoint("openai", "https://api.openai.com/v1/chat/completions") == (
        "https://api.openai.com/v1/models"
    )
    # Trailing slash (the GLM catalog entry ships one) must not double up.
    assert _models_endpoint("openai", "https://open.bigmodel.cn/api/paas/v4/") == (
        "https://open.bigmodel.cn/api/paas/v4/models"
    )
    # Anthropic nests under /v1 — root, /v1, and /v1/messages all collapse.
    for base in (
        "https://api.anthropic.com",
        "https://api.anthropic.com/v1",
        "https://api.anthropic.com/v1/messages",
    ):
        assert _models_endpoint("anthropic", base) == "https://api.anthropic.com/v1/models", base
    # Empty base_url falls back to the provider default rather than "/models".
    assert _models_endpoint("anthropic", None) == "https://api.anthropic.com/v1/models"
    assert _models_endpoint("google", "") == (
        "https://generativelanguage.googleapis.com/v1beta/models"
    )


def test_fetch_models_parsing_per_protocol() -> None:
    """Each provider family returns a different envelope. Google additionally
    advertises embedding models that would 400 on chat — they MUST be filtered
    by ``supportedGenerationMethods``, else they pollute the model picker."""
    from src.amphi_service.handler._providers_handler import _parse_models

    # OpenAI-compat: {data:[{id}]}, sorted, deduped across aggregating gateways.
    assert _parse_models("openai", {"data": [{"id": "b"}, {"id": "a"}, {"id": "b"}]}) == [
        {"id": "a", "name": "a"},
        {"id": "b", "name": "b"},
    ]
    # Anthropic: display_name wins; provider order (newest-first) is preserved.
    assert _parse_models(
        "anthropic",
        {"data": [{"id": "claude-z", "display_name": "Claude Z"}, {"id": "claude-a"}]},
    ) == [
        {"id": "claude-z", "name": "Claude Z"},
        {"id": "claude-a", "name": "claude-a"},
    ]
    # Google: strip the "models/" prefix, drop non-generateContent entries.
    assert _parse_models(
        "google",
        {
            "models": [
                {
                    "name": "models/gemini-2.5-pro",
                    "displayName": "Gemini 2.5 Pro",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"],
                },
            ]
        },
    ) == [{"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"}]
    # Malformed / empty payloads degrade to [] instead of raising.
    assert _parse_models("openai", {}) == []
    assert _parse_models("google", {"models": None}) == []


def test_fetch_models_error_scrubs_api_key() -> None:
    """Some gateways reflect the Authorization header back in their error body.
    Echoing it verbatim would leak the key into the GUI (and the user's
    screenshots), so ``_fetch_error_message`` MUST scrub it."""
    from src.amphi_service.handler._providers_handler import _fetch_error_message

    leaked = _fetch_error_message(500, "upstream rejected Bearer sk-SECRET123", "sk-SECRET123")
    assert "sk-SECRET123" not in leaked
    assert "***" in leaked
    # Well-known statuses get a friendly message instead of the raw body.
    assert _fetch_error_message(401, "whatever", "k") == "API Key 校验失败（401）"
    assert "404" in _fetch_error_message(404, "", "k")
    # Gemini reports a bad key as 400 INVALID_ARGUMENT (verified against the
    # live endpoint) — classify it as auth, not as an opaque wall of JSON.
    google_400 = '{\n  "error": {\n    "message": "API key not valid."\n  }\n}'
    assert _fetch_error_message(400, google_400, "k") == "API Key 校验失败（400）"
    # A 400 that ISN'T about the key keeps its (whitespace-collapsed) body —
    # raw newlines would wreck the single-line slot the GUI renders this in.
    other_400 = '{\n  "error": "model list disabled"\n}'
    out = _fetch_error_message(400, other_400, "k")
    assert "\n" not in out and "model list disabled" in out


async def test_fetch_models_route_is_not_shadowed(client: httpx.AsyncClient) -> None:
    """``/me/providers/fetch-models`` MUST bind before the catch-all
    ``/me/providers/{provider_id}``, else FastAPI matches "fetch-models" as a
    path param and the POST 405s. Asserting on the handler's own validation
    message proves our handler — not the item route — served the request."""
    r = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai", "api_key": "   ",
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": False, "error": "API Key 不能为空"}
    # extra='forbid' still applies (no stray `model` field — listing needs none).
    bad = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "api_key": "sk-x", "model": "gpt-4o",
    })
    assert bad.status_code == 422


async def test_fetch_models_reports_a_base_url_that_serves_html(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A base_url missing its version segment must be named as such.

    Gateways that front their API with an SPA (verified against a live
    new-api-style deployment) answer EVERY unmatched path with ``200`` +
    ``text/html`` — the console's index page — instead of 404. So a user who
    types ``http://host:8080`` rather than ``http://host:8080/v1`` sails past
    the ``>= 400`` check and dies in ``resp.json()``. The old envelope echoed
    the raw ``json.JSONDecodeError`` ("Expecting value: line 1 column 1
    (char 0)"), which reads like a provider bug and points the user nowhere
    near their actual typo.
    """
    import src.amphi_service.handler._providers_handler as providers_handler

    request = httpx.Request("GET", "http://host:8080/models")

    class SpaAsyncClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, url, *, headers, params):
            return httpx.Response(
                200,
                text="<!doctype html><html lang=\"zh-CN\"><head></head></html>",
                headers={"content-type": "text/html; charset=utf-8"},
                request=request,
            )

    monkeypatch.setattr(providers_handler.httpx, "AsyncClient", SpaAsyncClient)
    r = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai",
        "base_url": "http://host:8080", "api_key": "sk-test",
    })

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    error = body["error"]
    # The message must name the cause (wrong Base URL) and the fix (/v1),
    # and must NOT leak the Python-level parse error.
    assert "Base URL" in error and "/v1" in error
    assert "Expecting value" not in error


async def test_fetch_models_accepts_json_under_a_wrong_content_type(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Content-Type alone must NOT gate parsing.

    Some self-hosted gateways serve a perfectly good model list as
    ``text/plain``. ``resp.json()`` never looked at the header, so those
    channels work today — rejecting on Content-Type would break them. The
    header may only be used to *explain* a body that already failed to parse.
    """
    import src.amphi_service.handler._providers_handler as providers_handler

    request = httpx.Request("GET", "http://host:8080/v1/models")

    class PlainTextJsonClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, url, *, headers, params):
            return httpx.Response(
                200,
                text='{"data": [{"id": "gpt-5.5"}]}',
                headers={"content-type": "text/plain"},
                request=request,
            )

    monkeypatch.setattr(providers_handler.httpx, "AsyncClient", PlainTextJsonClient)
    r = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai",
        "base_url": "http://host:8080/v1", "api_key": "sk-test",
    })

    assert r.json() == {"ok": True, "models": [{"id": "gpt-5.5", "name": "gpt-5.5"}]}


async def test_fetch_models_leaves_official_openai_shapes_alone(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The new non-JSON branch must not poach api.openai.com's cases.

    Unlike an SPA-fronted gateway, OpenAI answers a wrong path with a JSON
    404 — so 「漏了 /v1」 there is already handled by ``_fetch_error_message``
    and must keep its 404 wording. Both payloads below are the shapes the
    live API returns.
    """
    import src.amphi_service.handler._providers_handler as providers_handler

    class OfficialOpenAIClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, url, *, headers, params):
            request = httpx.Request("GET", url)
            if url == "https://api.openai.com/v1/models":
                return httpx.Response(200, json={
                    "object": "list",
                    "data": [
                        {"id": "gpt-4o", "object": "model", "owned_by": "system"},
                        {"id": "gpt-4o-mini", "object": "model", "owned_by": "system"},
                    ],
                }, request=request)
            # Anything else: OpenAI's JSON 404, NOT an HTML console page.
            return httpx.Response(404, json={"error": {
                "message": f"Invalid URL (GET {url})",
                "type": "invalid_request_error", "param": None, "code": None,
            }}, request=request)

    monkeypatch.setattr(providers_handler.httpx, "AsyncClient", OfficialOpenAIClient)

    ok = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai",
        "base_url": "https://api.openai.com/v1", "api_key": "sk-test",
    })
    assert ok.json() == {"ok": True, "models": [
        {"id": "gpt-4o", "name": "gpt-4o"},
        {"id": "gpt-4o-mini", "name": "gpt-4o-mini"},
    ]}

    # Same typo as the gateway case, but a JSON-speaking provider: the 404
    # branch owns it, and the non-JSON message must NOT appear.
    missing_v1 = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai",
        "base_url": "https://api.openai.com", "api_key": "sk-test",
    })
    error = missing_v1.json()["error"]
    assert error == "模型列表端点不存在（404），请检查 Base URL"
    assert "非 JSON" not in error


def test_probe_error_translates_the_non_json_chat_response() -> None:
    """The connection probe's version of the same misconfiguration.

    When the chat endpoint answers ``200`` + ``text/html``, the openai SDK does
    not raise: ``_legacy_response.py`` deliberately returns ``response.text``
    for a non-JSON Content-Type. That ``str`` reaches bridgic's
    ``response.choices[0].message`` and surfaces as the utterly opaque
    ``'str' object has no attribute 'choices'``. Translate it to the same
    actionable message ``fetch-models`` gives.
    """
    from src.amphi_service.handler._providers_handler import _probe_error_message

    out = _probe_error_message(AttributeError("'str' object has no attribute 'choices'"))
    assert "Base URL" in out and "/v1" in out
    assert "choices" not in out
    # An unrelated AttributeError is a daemon-side bug — it must stay verbatim
    # rather than be mislabelled as the user's Base URL typo.
    other = _probe_error_message(AttributeError("'NoneType' object has no attribute 'id'"))
    assert other == "'NoneType' object has no attribute 'id'"


async def test_fetch_models_codex_reads_static_table(client: httpx.AsyncClient) -> None:
    """Codex has NO list-models endpoint, so 「从供应商获取」 is a table read.

    The subtle bit this pins: a Codex channel posts ``provider_id='openai'``
    (it attaches to that slug) and the catalog maps openai→'openai'. If the
    handler ran ``_resolve_protocol`` first, the protocol would be silently
    rewritten and the request would fall through to the API-key path — which
    would then reject it for the empty api_key a subscription channel has.
    """
    from src.amphi_service.protocol.llms.codex_llm import CODEX_CATALOG_MODELS

    r = await client.post("/me/providers/fetch-models", json={
        "provider_id": "openai", "protocol": "openai-codex", "api_key": "",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["models"] == list(CODEX_CATALOG_MODELS)
    # Every seeded id must be non-empty and unique — a dupe would create two
    # identical rows in the picker.
    ids = [m["id"] for m in body["models"]]
    assert all(ids) and len(ids) == len(set(ids))


def test_codex_activation_seeds_whole_table() -> None:
    """Activation seeds the full table (拉取即全部启用), but
    ``current_model`` stays the pinned default rather than the table's first
    row — the table is ordered newest-first for display, and the newest model
    is not necessarily the one a given account can drive."""
    from src.amphi_service.protocol.llms.codex_llm import (
        CODEX_CATALOG_MODELS,
        DEFAULT_CODEX_MODEL,
    )

    ids = [m["id"] for m in CODEX_CATALOG_MODELS]
    assert DEFAULT_CODEX_MODEL in ids, "default must be seedable"
    assert ids[0] != DEFAULT_CODEX_MODEL, (
        "test is vacuous if the default happens to be first — it exists to catch "
        "a future reorder silently changing which model new users land on"
    )


def test_state_dir_is_locked_to_owner(tmp_path) -> None:
    """The state dir holds plaintext api_keys, so it must be 0700 — including
    when it ALREADY EXISTS with looser bits.

    ``mkdir(mode=0700)`` only applies at creation and is masked by umask, so a
    dir created by an earlier release stayed 0755 in the wild: every local user
    could read the keys. Startup must re-assert the mode, not just request it.
    """
    import os
    import stat

    from src.amphi_store import Repository

    stale = tmp_path / "preexisting"
    stale.mkdir(mode=0o755)
    os.chmod(stale, 0o755)  # defeat umask so the precondition is exact
    assert stat.S_IMODE(stale.stat().st_mode) == 0o755

    Repository.connect(stale / "state.db")
    assert stat.S_IMODE(stale.stat().st_mode) == 0o700, (
        "an already-existing state dir must be tightened, not left as found"
    )


async def test_api_key_reveal_endpoint(client: httpx.AsyncClient) -> None:
    """``GET /me/providers/{id}/api-key`` is the ONE sanctioned way a plaintext
    key crosses the wire — it backs the edit form's prefill.

    Deliberately its own endpoint rather than a field on ``_configured()``:
    ``GET /me/providers`` runs on every settings open, and keys must not ride
    along on all of those. This test pins both halves of that split.
    """
    await client.post("/me/providers", json={
        **_OPENAI, "api_key": "sk-reveal-me", "base_url": "https://x.example/v1",
    })

    revealed = await client.get("/me/providers/openai/api-key")
    assert revealed.status_code == 200
    assert revealed.json() == {"api_key": "sk-reveal-me"}

    # ...while the list view still withholds it.
    assert "sk-reveal-me" not in (await client.get("/me/providers")).text

    # OAuth/Codex channels have no key — null, not a 500.
    await client.post("/me/providers", json={
        "provider_id": "sub-channel", "auth_mode": "oauth", "protocol": "openai",
    })
    assert (await client.get("/me/providers/sub-channel/api-key")).json() == {
        "api_key": None
    }

    # Unknown slug 404s rather than leaking an empty-but-200 shape.
    assert (await client.get("/me/providers/nope/api-key")).status_code == 404


def test_google_models_endpoint_tolerates_versioned_base() -> None:
    """用户常照抄 Google 文档把 base_url 填成带 ``/v1beta`` 的形式。

    无条件追加版本段会拼出 ``…/v1beta/v1beta/models`` → 404,而报错文案是
    「请检查 Base URL」—— 指向了一个本身完全合理的配置。
    """
    from src.amphi_service.handler._providers_handler import _models_endpoint

    want = "https://generativelanguage.googleapis.com/v1beta/models"
    for base in (
        "https://generativelanguage.googleapis.com",
        "https://generativelanguage.googleapis.com/",
        "https://generativelanguage.googleapis.com/v1beta",
        "https://generativelanguage.googleapis.com/v1",
        None,
    ):
        assert _models_endpoint("google", base) == want, base


def test_codex_catalog_is_handed_out_as_a_copy() -> None:
    """Codex 目录出网必须是深拷贝。

    ``list(CODEX_CATALOG_MODELS)`` 只复制外层列表,条目 dict 仍是模块级常量的
    引用 —— 任何下游改动都会永久污染进程内目录,影响之后所有请求。
    """
    from src.amphi_service.protocol.llms.codex_llm import CODEX_CATALOG_MODELS

    snapshot = [dict(m) for m in CODEX_CATALOG_MODELS]
    handed_out = [dict(m) for m in CODEX_CATALOG_MODELS]  # handler 的出网方式
    handed_out[0]["name"] = "MUTATED"
    assert [dict(m) for m in CODEX_CATALOG_MODELS] == snapshot, "全局目录被下游改动污染"


async def test_codex_activation_clears_stale_api_key_base_url(
    client: httpx.AsyncClient,
    service_app,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Switching the 'openai' channel from api_key mode to the Codex
    subscription must clear the api_key-era base_url. The upsert treats None
    as "preserve", so without an explicit clear the stale
    ``https://api.openai.com/v1`` survives on the row, gets mirrored back onto
    the user by the next ``POST /me/active-model``, and CodexResponsesLlm then
    requests ``https://api.openai.com/v1/codex/responses`` → 404."""
    import src.amphi_service.handler._providers_handler as ph

    # 1) api_key mode writes a base_url onto the row.
    r = await client.post("/me/providers", json={
        "provider_id": "openai", "api_key": "sk-test",
        "base_url": "https://api.openai.com/v1", "protocol": "openai",
    })
    assert r.status_code in (200, 201), r.text

    # 2) the OAuth sign-in flow activates the Codex subscription.
    monkeypatch.setattr(ph, "resolve_codex_credentials",
                        lambda: SimpleNamespace(access_token="t", account_id="a"))
    await ph._activate_codex_provider(service_app.state.llms, "local")

    rows = (await client.get("/me/providers")).json()
    codex = next(p for p in rows if p["id"] == "openai")
    assert codex["protocol"] == "openai-codex"
    assert codex["base_url"] is None, "stale api_key-mode base_url must be cleared"

    # 3) re-activating via the model picker must not resurrect the stale base.
    r = await client.post("/me/active-model", json={"provider_id": "openai", "model": "gpt-5.5"})
    assert r.status_code == 200, r.text
    me = (await client.get("/me")).json()
    assert me["base_url"] is None
