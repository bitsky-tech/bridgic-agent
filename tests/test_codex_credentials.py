"""Codex 凭证解析 — 读 ~/.codex/auth.json,临期刷新并原子写回。

不变量:token 真相源是 ~/.codex/auth.json(与官方 codex CLI 共享);本应用
像另一个 codex CLI 客户端,读取并在临期时刷新写回。所有用例用 CODEX_HOME 指向
tmp_path 隔离,绝不触碰真实 ~/.codex;刷新走注入的 httpx.MockTransport,不发真网络。
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from src.amphi_service.i18n import use_locale
from src.amphi_service.protocol.llms import _codex_credentials as cc


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_access_token(*, exp: int, account_id: str = "acct-123") -> str:
    """构造一个最小 JWT(alg=none),带 exp 与 OpenAI auth claim。"""
    header = _b64url(b'{"alg":"none","typ":"JWT"}')
    payload = _b64url(
        json.dumps(
            {"exp": exp, cc.JWT_AUTH_CLAIM: {"chatgpt_account_id": account_id}}
        ).encode()
    )
    return f"{header}.{payload}.sig"


def _write_auth(
    home: Path,
    *,
    access: str,
    refresh: str = "rt-1",
    id_token: str = "id-1",
    account_id: str = "acct-123",
) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    p = home / "auth.json"
    p.write_text(
        json.dumps(
            {
                "OPENAI_API_KEY": None,
                "tokens": {
                    "id_token": id_token,
                    "access_token": access,
                    "refresh_token": refresh,
                    "account_id": account_id,
                },
                "last_refresh": "2026-06-01T00:00:00Z",
                "auth_mode": "chatgpt",
            }
        )
    )
    return p


@pytest.fixture
def codex_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".codex"
    monkeypatch.setenv("CODEX_HOME", str(home))
    return home


def _never_refresh_client() -> httpx.Client:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("未过期的 token 不应触发刷新")

    return httpx.Client(transport=httpx.MockTransport(handler))


# 刷新失败分类表:429 限流(可重试,无需重登);invalid_grant / refresh_token_reused
# 都是 refresh token 失效 → 必须重新登录。
_REFRESH_ERROR_CASES = [
    # (status, body, expected_code, relogin_required)
    (429, {}, "codex_rate_limited", False),
    (400, {"error": "invalid_grant"}, "invalid_grant", True),
    (400, {"error": "refresh_token_reused"}, "refresh_token_reused", True),
]


def test_codex_credentials_lifecycle(codex_home: Path) -> None:
    """凭证的完整生命周期,分阶段串联:

    1. 缺失 / tokenless → None,且未过期 token 不触发刷新(注入会爆炸的 client 守卫)。
    2. 临期 → 刷新 + 原子写回(POST refresh_token grant,新 token 落盘,结构/时间戳更新)。
    3. 刷新失败分类(参数化保留 429 / invalid_grant / refresh_token_reused)。
    4. 从合法 JWT 的 OpenAI auth claim 抽取 chatgpt_account_id;畸形输入 → None。
    """
    # ── 1. 读取 / 解析:缺失 → fresh(不刷新) ──────────────────────────────
    # 文件不存在
    assert cc.read_codex_auth() is None
    assert cc.resolve_codex_credentials() is None

    # 存在但没有 tokens 段 → 仍视作缺失
    codex_home.mkdir(parents=True, exist_ok=True)
    (codex_home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": None}))
    assert cc.read_codex_auth() is None

    # 写入未过期 token → 直接可用,不刷新
    _write_auth(codex_home, access=_make_access_token(exp=int(time.time()) + 3600))
    creds = cc.resolve_codex_credentials(client=_never_refresh_client())
    assert creds is not None
    assert creds.account_id == "acct-123"
    assert creds.access_token
    assert creds.refresh_token == "rt-1"

    # ── 2. 临期:刷新 + 原子写回 ──────────────────────────────────────────
    _write_auth(
        codex_home,
        access=_make_access_token(exp=int(time.time()) - 10),  # 已过期
        refresh="rt-old",
    )
    new_access = _make_access_token(exp=int(time.time()) + 7200)

    def refresh_handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == cc.CODEX_TOKEN_URL
        body = parse_qs(request.content.decode())
        assert body["grant_type"] == ["refresh_token"]
        assert body["client_id"] == [cc.CODEX_CLIENT_ID]
        assert body["refresh_token"] == ["rt-old"]
        return httpx.Response(
            200,
            json={
                "access_token": new_access,
                "refresh_token": "rt-new",
                "id_token": "id-new",
                "expires_in": 7200,
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(refresh_handler))
    creds = cc.resolve_codex_credentials(client=client)
    assert creds is not None
    assert creds.access_token == new_access
    assert creds.refresh_token == "rt-new"

    written = json.loads((codex_home / "auth.json").read_text())
    assert written["tokens"]["access_token"] == new_access
    assert written["tokens"]["refresh_token"] == "rt-new"
    assert written["auth_mode"] == "chatgpt"  # 结构保留
    assert written["last_refresh"] != "2026-06-01T00:00:00Z"  # 时间戳更新

    # ── 3. 刷新错误分类(429 / invalid_grant / refresh_token_reused) ──────
    for status, body, expected_code, relogin in _REFRESH_ERROR_CASES:
        err_client = httpx.Client(
            transport=httpx.MockTransport(
                lambda r, s=status, b=body: httpx.Response(s, json=b)
            )
        )
        with pytest.raises(cc.CodexAuthError) as ei:
            cc.refresh_codex_auth("rt-1", client=err_client)
        assert ei.value.code == expected_code
        assert ei.value.relogin_required is relogin

    # ── 4. account_id 提取 ────────────────────────────────────────────────
    tok = _make_access_token(exp=int(time.time()) + 60, account_id="acct-xyz")
    assert cc._extract_account_id(tok) == "acct-xyz"
    assert cc._extract_account_id("not-a-jwt") is None


def test_resolve_force_refreshes_even_when_not_expiring(codex_home: Path) -> None:
    """``force=True`` bypasses the临期检查,对仍然有效的 token 也强制刷新写回 ——
    401 兜底路径靠它:服务端已拒的 token 本地 exp 可能仍显示有效(时钟偏移/吊销)。"""
    _write_auth(
        codex_home,
        access=_make_access_token(exp=int(time.time()) + 3600),  # 远未过期
        refresh="rt-live",
    )
    new_access = _make_access_token(exp=int(time.time()) + 7200)

    def refresh_handler(request: httpx.Request) -> httpx.Response:
        assert parse_qs(request.content.decode())["refresh_token"] == ["rt-live"]
        return httpx.Response(200, json={"access_token": new_access, "refresh_token": "rt-forced"})

    client = httpx.Client(transport=httpx.MockTransport(refresh_handler))
    creds = cc.resolve_codex_credentials(client=client, force=True)

    assert creds is not None
    assert creds.access_token == new_access          # 强制刷新生效
    assert creds.refresh_token == "rt-forced"
    written = json.loads((codex_home / "auth.json").read_text())
    assert written["tokens"]["access_token"] == new_access   # 已原子写回


def test_refresh_errors_follow_the_active_backend_locale() -> None:
    """Codex credential failures keep their codes but localize display text."""
    with use_locale("en"):
        with pytest.raises(cc.CodexAuthError, match="refresh token") as exc_info:
            cc.refresh_codex_auth("")

    assert exc_info.value.code == "codex_auth_missing_refresh_token"
    assert str(exc_info.value) == "Codex sign-in details are missing a refresh token. Please sign in again."
