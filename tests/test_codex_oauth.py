"""Codex OAuth — PKCE, authorize URL, callback parsing, code exchange, persist.

The 1455 callback server's pure logic (route/state/code parsing) is tested via
``parse_callback``; HTTP/exchange via httpx.MockTransport; persist via a
CODEX_HOME-isolated tmp dir. No real network, no real ~/.codex.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from src.amphi_service.protocol.llms import _codex_oauth as oa
from src.amphi_service.protocol.llms._codex_credentials import CODEX_CLIENT_ID, CodexAuthError


def test_pkce_authorize_url_and_callback_parsing() -> None:
    """The pure auth-flow logic: generate_pkce yields an S256 verifier/challenge
    pair; build_authorize_url embeds the challenge/state plus all the fixed OAuth
    params; parse_callback returns (code, None) on a valid callback and
    (None, reason) for state mismatch / wrong route / provider-reported errors.
    """
    verifier, challenge = oa.generate_pkce()
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    assert challenge == expected
    assert "=" not in verifier and "=" not in challenge

    parts = urlsplit(oa.build_authorize_url(challenge=challenge, state="ST"))
    assert parts.scheme == "https"
    assert parts.netloc == "auth.openai.com"
    q = parse_qs(parts.query)
    assert q["client_id"] == [CODEX_CLIENT_ID]
    assert q["redirect_uri"] == ["http://localhost:1455/auth/callback"]
    assert q["code_challenge"] == [challenge]
    assert q["code_challenge_method"] == ["S256"]
    assert q["state"] == ["ST"]
    assert q["scope"] == ["openid profile email offline_access"]

    for path, want in [
        ("/auth/callback?code=abc&state=ST", ("abc", None)),
        ("/auth/callback?code=abc&state=WRONG", (None, "state_mismatch")),
        ("/other?code=x&state=ST", (None, "not_found")),
        ("/auth/callback?state=ST&error=access_denied", (None, "access_denied")),
    ]:
        assert oa.parse_callback(path, "ST") == want


def test_singleton_callback_routing() -> None:
    """单例 1455 server 按回调里的 state 路由(不靠 per-server expected_state)——这
    正是根治"重新授权 404"的关键:浏览器复用旧成功页连接送来的回调也能落到正确会话。

    一条 e2e 覆盖:并存注册多个 state 各自回调互不串话(命中只设它自己的 code);未注册
    的 state(陈旧回调走复用连接 / 已终结的会话)和 /favicon.ico 都被忽略,既不凭空创建
    路由槽、也不毒化任何活跃会话。
    """
    srv = oa.CodexCallbackServer
    assert srv.register("st-A")  # 首次 register 懒启动 1455 server
    assert srv.register("st-B")
    try:
        # --- 按 state 路由,互不串话。 ---
        callback = httpx.get(
            "http://127.0.0.1:1455/auth/callback?state=st-B&code=codeB",
            headers={"Accept-Language": "en-US,en;q=0.9"},
            timeout=5.0,
        )
        assert "Codex sign-in succeeded. You can return to the app." in callback.text
        assert srv.code_for("st-B") == "codeB"
        assert srv.code_for("st-A") is None  # 不串话
        httpx.get("http://127.0.0.1:1455/auth/callback?state=st-A&code=codeA", timeout=5.0)
        assert srv.code_for("st-A") == "codeA"
        assert srv.code_for("st-B") == "codeB"

        # --- 忽略无关路由与未注册 state,不毒化活跃会话。 ---
        httpx.get("http://127.0.0.1:1455/favicon.ico", timeout=5.0)
        httpx.get("http://127.0.0.1:1455/auth/callback?state=stale&code=x", timeout=5.0)
        assert srv.code_for("stale") is None  # 没凭空创建槽
        assert srv.error_for("st-A") is None  # 没毒化活跃会话
        assert srv.code_for("st-A") == "codeA"  # 活跃会话照旧
        assert srv.error_for("st-B") is None
        assert srv.code_for("st-B") == "codeB"
    finally:
        srv.unregister("st-A")
        srv.unregister("st-B")


def test_exchange_code_ok_and_failure() -> None:
    """exchange_code POSTs the authorization_code grant and returns the token
    payload on 200; a 4xx error surfaces as a relogin-required CodexAuthError."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = parse_qs(request.content.decode())
        assert body["grant_type"] == ["authorization_code"]
        assert body["code"] == ["the-code"]
        assert body["client_id"] == [CODEX_CLIENT_ID]
        assert body["code_verifier"] == ["the-verifier"]
        return httpx.Response(
            200, json={"access_token": "at", "refresh_token": "rt", "id_token": "id"}
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert oa.exchange_code("the-code", "the-verifier", client=client) == {
        "access_token": "at",
        "refresh_token": "rt",
        "id_token": "id",
    }

    fail_client = httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(400, json={"error": "invalid_grant"})
        )
    )
    with pytest.raises(CodexAuthError) as ei:
        oa.exchange_code("c", "v", client=fail_client)
    assert ei.value.relogin_required is True


def test_oauth_pages_and_exchange_errors_follow_browser_locale() -> None:
    """The browser callback keeps OAuth's localized display text off the API wire."""
    page = oa.render_success_page("en")
    assert "Codex sign-in succeeded. You can return to the app." in page
    # Product name comes from the constant, not a literal: it is mirrored from
    # app-meta.ts and pinned by tests/test_branding_contract.py, so a rename
    # should not have to be chased through unrelated assertions.
    assert f"Return to {oa.APP_PRODUCT_NAME}." in page

    fail_client = httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(400, text="invalid grant"))
    )
    with pytest.raises(CodexAuthError) as exc_info:
        oa.exchange_code("c", "v", client=fail_client, locale="en")
    assert str(exc_info.value) == (
        "Failed to exchange the Codex authorization code (HTTP 400): invalid grant"
    )


def test_persist_codex_tokens_writes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))

    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    payload = b64(
        json.dumps({"https://api.openai.com/auth": {"chatgpt_account_id": "acct-7"}}).encode()
    )
    access = f"{b64(b'{}')}.{payload}.sig"

    acct = oa.persist_codex_tokens(
        {"access_token": access, "refresh_token": "rt", "id_token": "id"}
    )
    assert acct == "acct-7"
    written = json.loads((tmp_path / ".codex" / "auth.json").read_text())
    assert written["tokens"]["access_token"] == access
    assert written["tokens"]["account_id"] == "acct-7"
    assert written["auth_mode"] == "chatgpt"
