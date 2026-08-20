import base64
import hashlib
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

from src.amphi_service.protocol.llms import _codex_credentials as credentials
from src.amphi_service.protocol.llms import _codex_oauth as oauth


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _access_token(*, exp: int, account_id: str = "account-id") -> str:
    claims = {"exp": exp, credentials.JWT_AUTH_CLAIM: {"chatgpt_account_id": account_id}}
    return f"{_b64url(b'{}')}.{_b64url(json.dumps(claims).encode())}.sig"


def _write_auth(codex_home: Path, access_token: str, refresh_token: str) -> Path:
    codex_home.mkdir(parents=True, exist_ok=True)
    path = codex_home / "auth.json"
    path.write_text(json.dumps({
        "auth_mode": "chatgpt",
        "tokens": {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "id_token": "old-id",
        },
    }), encoding="utf-8")
    return path


def test_codex_credentials_refresh_and_persist(tmp_path: Path) -> None:
    """An expiring local login refreshes once and atomically persists rotated tokens."""
    codex_home = tmp_path / ".codex"
    auth_path = _write_auth(
        codex_home,
        _access_token(exp=int(time.time()) - 1),
        "old-refresh",
    )
    fresh_access = _access_token(exp=int(time.time()) + 3600, account_id="fresh-account")

    def handler(request: httpx.Request) -> httpx.Response:
        form = parse_qs(request.content.decode())
        assert form == {
            "grant_type": ["refresh_token"],
            "refresh_token": ["old-refresh"],
            "client_id": [credentials.CODEX_CLIENT_ID],
        }
        return httpx.Response(200, json={
            "access_token": fresh_access,
            "refresh_token": "fresh-refresh",
            "id_token": "fresh-id",
        })

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        resolved = credentials.resolve_codex_credentials(client=client)

    assert resolved is not None
    assert (resolved.access_token, resolved.refresh_token, resolved.account_id) == (
        fresh_access,
        "fresh-refresh",
        "fresh-account",
    )
    persisted = json.loads(auth_path.read_text(encoding="utf-8"))
    assert persisted["tokens"] == {
        "access_token": fresh_access,
        "refresh_token": "fresh-refresh",
        "id_token": "fresh-id",
    }
    assert persisted["last_refresh"].endswith("Z")


def test_codex_oauth_contract_and_persistence(tmp_path: Path) -> None:
    """PKCE, callback validation, token exchange, and local persistence form one auth boundary."""
    verifier, challenge = oauth.generate_pkce()
    expected = _b64url(hashlib.sha256(verifier.encode()).digest())
    assert challenge == expected

    authorize = urlsplit(oauth.build_authorize_url(challenge=challenge, state="state-1"))
    query = parse_qs(authorize.query)
    assert (authorize.scheme, authorize.netloc) == ("https", "auth.openai.com")
    assert query["code_challenge"] == [challenge]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == ["state-1"]
    assert oauth.parse_callback("/auth/callback?code=code-1&state=state-1", "state-1") == ("code-1", None)
    assert oauth.parse_callback("/auth/callback?code=code-1&state=wrong", "state-1") == (None, "state_mismatch")

    access = _access_token(exp=int(time.time()) + 3600, account_id="oauth-account")

    def handler(request: httpx.Request) -> httpx.Response:
        form = parse_qs(request.content.decode())
        assert form["grant_type"] == ["authorization_code"]
        assert form["code"] == ["code-1"]
        assert form["code_verifier"] == [verifier]
        return httpx.Response(200, json={
            "access_token": access,
            "refresh_token": "oauth-refresh",
            "id_token": "oauth-id",
        })

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        tokens = oauth.exchange_code("code-1", verifier, client=client)
    assert oauth.persist_codex_tokens(tokens) == "oauth-account"
    persisted = json.loads((tmp_path / ".codex" / "auth.json").read_text(encoding="utf-8"))
    assert persisted["tokens"]["account_id"] == "oauth-account"
    assert persisted["tokens"]["refresh_token"] == "oauth-refresh"
