"""Codex 本地复用 handler — GET 检测 + POST 一键复用激活(授权兜底之前)。

最初核心需求:本机用 codex 登录过就直接复用,无需 OAuth。这些用例用
monkeypatch 隔离 ~/.codex 访问与模型探测,验证检测与复用激活的 wiring。
"""

from __future__ import annotations

import httpx

from src.amphi_service.handler import _providers_handler as ph


async def test_codex_local_detect_and_routing(client: httpx.AsyncClient, monkeypatch) -> None:
    """GET detection echoes peek_codex_local (present + absent), and a non-openai
    provider in the path 404s."""
    monkeypatch.setattr(ph, "peek_codex_local", lambda: {"account_id": "acct-9"})
    r = await client.get("/me/providers/openai/codex/local")
    assert r.json() == {"has_local": True, "account_id": "acct-9"}

    monkeypatch.setattr(ph, "peek_codex_local", lambda: None)
    r = await client.get("/me/providers/openai/codex/local")
    assert r.json() == {"has_local": False, "account_id": None}

    assert (await client.get("/me/providers/anthropic/codex/local")).status_code == 404


async def test_codex_local_reuse_activates(client: httpx.AsyncClient, monkeypatch) -> None:
    from src.amphi_service.protocol.llms._codex_credentials import CodexCreds

    monkeypatch.setattr(
        ph,
        "resolve_codex_credentials",
        lambda: CodexCreds(access_token="at", refresh_token="rt", account_id="acct-9", id_token=None),
    )

    r = await client.post("/me/providers/openai/codex/local")
    assert r.json() == {"ok": True}

    provs = (await client.get("/me/providers")).json()
    codex = [p for p in provs if p["id"] == "openai"]
    assert codex
    assert codex[0]["is_active"] is True
    assert codex[0]["auth_mode"] == "oauth"
    assert codex[0]["protocol"] == "openai-codex"
    # Activation seeds the whole static table so the channel is usable at once;
    # the user prunes it afterwards. Still a local table read — NOT the removed
    # auto-probe, which fired one cross-border request per candidate.
    from src.amphi_service.protocol.llms.codex_llm import (
        CODEX_CATALOG_MODELS,
        DEFAULT_CODEX_MODEL,
    )

    assert codex[0]["available_models"] == [m["id"] for m in CODEX_CATALOG_MODELS]
    assert DEFAULT_CODEX_MODEL in codex[0]["available_models"]


async def test_codex_local_reuse_no_creds(client: httpx.AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(ph, "resolve_codex_credentials", lambda: None)
    body = (await client.post("/me/providers/openai/codex/local")).json()
    assert body["ok"] is False
    assert body["error"]
