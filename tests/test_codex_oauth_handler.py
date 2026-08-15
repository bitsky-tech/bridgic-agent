"""Codex OAuth handler — start / status / cancel wiring against the daemon.

The 1455 callback server is now a process-wide singleton; here it's swapped for
an in-memory routing-table fake (no real port bind). Token exchange + ~/.codex
persistence are monkeypatched too, so the suite stays offline.
"""

from __future__ import annotations

import httpx
import pytest

from src.amphi_service.handler import _providers_handler as ph


class _FakeCallbackServer:
    """Singleton callback-server fake: an in-memory ``state -> {code,error}``
    routing table, no real 1455 bind. ``register`` can be forced to fail to
    exercise the 409 (port held by an external process) path."""

    _pending: dict = {}
    _bind_ok: bool = True

    @classmethod
    def register(cls, state: str) -> bool:
        if not cls._bind_ok:
            return False
        cls._pending[state] = {"code": None, "error": None}
        return True

    @classmethod
    def unregister(cls, state: str) -> None:
        cls._pending.pop(state, None)

    @classmethod
    def code_for(cls, state: str):
        slot = cls._pending.get(state)
        return slot["code"] if slot else None

    @classmethod
    def error_for(cls, state: str):
        slot = cls._pending.get(state)
        return slot["error"] if slot else None

    # --- test helper ---
    @classmethod
    def deliver_code(cls, state: str, code: str) -> None:
        """Simulate the browser callback delivering ``code`` for ``state``."""
        cls._pending[state]["code"] = code


@pytest.fixture(autouse=True)
def _fake_singleton_server(monkeypatch):
    """Swap the singleton callback server for the in-memory fake (reset between
    tests), and clean residual sessions/timers afterwards."""
    _FakeCallbackServer._pending = {}
    _FakeCallbackServer._bind_ok = True
    monkeypatch.setattr(ph, "CodexCallbackServer", _FakeCallbackServer)
    yield
    ph._sweep_all_sessions()  # drop sessions + cancel timers + unregister states


async def test_codex_oauth_start_and_status(client: httpx.AsyncClient, monkeypatch) -> None:
    monkeypatch.setattr(
        ph,
        "exchange_code",
        lambda code, verifier: {"access_token": "at", "refresh_token": "rt", "id_token": "id"},
    )
    monkeypatch.setattr(ph, "persist_codex_tokens", lambda tokens: "acct-1")

    # Activation resolves creds (a liveness check) — mock it so the test stays
    # offline. Models are no longer probed; activation seeds the single default.
    from src.amphi_service.protocol.llms._codex_credentials import CodexCreds

    monkeypatch.setattr(
        ph,
        "resolve_codex_credentials",
        lambda: CodexCreds(access_token="at", refresh_token="rt", account_id="acct-1", id_token=None),
    )

    started = await client.post("/me/providers/openai/oauth/start")
    assert started.status_code == 200
    body = started.json()
    assert body["auth_url"].startswith("https://auth.openai.com/oauth/authorize")
    state = body["state"]

    # Simulate the browser callback delivering the code (routed by state).
    _FakeCallbackServer.deliver_code(state, "the-code")

    st = await client.get(f"/me/providers/openai/oauth/status?state={state}")
    assert st.json()["status"] == "success"

    # Terminal cleanup: session dropped + state unregistered from the server.
    assert state not in ph._CODEX_OAUTH_SESSIONS
    assert state not in _FakeCallbackServer._pending

    # Codex OAuth activates the "openai" channel with protocol openai-codex.
    provs = (await client.get("/me/providers")).json()
    codex = [p for p in provs if p["id"] == "openai"]
    assert codex
    assert codex[0]["is_active"] is True
    assert codex[0]["auth_mode"] == "oauth"
    assert codex[0]["api_key_set"] is False
    assert codex[0]["protocol"] == "openai-codex"
    # Activation seeds the whole static table (local read, no network); the user
    # prunes it later. current_model stays the pinned default, not the table head.
    from src.amphi_service.protocol.llms.codex_llm import (
        CODEX_CATALOG_MODELS,
        DEFAULT_CODEX_MODEL,
    )

    assert codex[0]["available_models"] == [m["id"] for m in CODEX_CATALOG_MODELS]
    assert DEFAULT_CODEX_MODEL in codex[0]["available_models"]


async def test_codex_oauth_edge_cases(client: httpx.AsyncClient) -> None:
    # Polling an unknown state is a benign "unknown" (not an error).
    st = await client.get("/me/providers/openai/oauth/status?state=nope")
    assert st.json() == {"status": "unknown"}

    # OAuth start is only wired for the openai channel (ChatGPT subscription).
    r = await client.post("/me/providers/anthropic/oauth/start")
    assert r.status_code == 404


async def test_codex_oauth_start_preempts_previous_session(client: httpx.AsyncClient) -> None:
    """同一用户重发授权:抢占清理上一个未完成 session(放弃后重试/连点自愈)。"""
    s1 = (await client.post("/me/providers/openai/oauth/start")).json()["state"]
    s2 = (await client.post("/me/providers/openai/oauth/start")).json()["state"]

    assert s1 != s2
    assert s1 not in ph._CODEX_OAUTH_SESSIONS  # 旧 session 被抢占清理
    assert s2 in ph._CODEX_OAUTH_SESSIONS
    assert s1 not in _FakeCallbackServer._pending  # 旧 state 被 unregister
    assert s2 in _FakeCallbackServer._pending


async def test_codex_oauth_start_409_on_external_occupation(client: httpx.AsyncClient) -> None:
    """1455 被外部进程占着(register 绑不上):如实报 409 且文案点明外部。"""
    _FakeCallbackServer._bind_ok = False

    r = await client.post("/me/providers/openai/oauth/start")
    assert r.status_code == 409
    assert "外部进程" in r.json()["detail"]


async def test_codex_oauth_ttl_reaps_abandoned_session(client: httpx.AsyncClient) -> None:
    """用户授权到一半放弃:TTL 到点回收 —— session 删除 + state 从路由表 unregister。"""
    state = (await client.post("/me/providers/openai/oauth/start")).json()["state"]
    assert state in ph._CODEX_OAUTH_SESSIONS
    assert state in _FakeCallbackServer._pending

    ph._reap_session(state)  # 模拟 TTL 到点(不等真实 300s)

    assert state not in ph._CODEX_OAUTH_SESSIONS  # 僵尸 session 被回收
    assert state not in _FakeCallbackServer._pending  # state 被 unregister


async def test_codex_oauth_cancel_drops_session_and_unregisters(client: httpx.AsyncClient) -> None:
    """用户中途放弃授权(点取消 / 返回卸载):cancel 立即清 session + unregister state,
    这样陈旧回调再也落不到一个已终结的会话上。"""
    state = (await client.post("/me/providers/openai/oauth/start")).json()["state"]
    assert state in ph._CODEX_OAUTH_SESSIONS

    r = await client.post(f"/me/providers/openai/oauth/cancel?state={state}")
    assert r.status_code == 204

    assert state not in ph._CODEX_OAUTH_SESSIONS  # session 被清
    assert state not in _FakeCallbackServer._pending  # state 被 unregister


async def test_codex_oauth_cancel_is_idempotent_and_guards_provider(
    client: httpx.AsyncClient,
) -> None:
    """cancel 不存在的 state 幂等(204,不抛);非 openai 厂商 404。"""
    r = await client.post("/me/providers/openai/oauth/cancel?state=does-not-exist")
    assert r.status_code == 204

    r = await client.post("/me/providers/anthropic/oauth/cancel?state=x")
    assert r.status_code == 404
