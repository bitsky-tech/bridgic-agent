"""Codex (ChatGPT subscription) credential resolution.

The single source of truth is ``~/.codex/auth.json`` (shared with the official
codex CLI). This module makes the daemon behave like *another* codex CLI
client: it reads the stored tokens, refreshes the access token when it is about
to expire, and writes the rotated pair back atomically under a file lock. The
app database never stores Codex tokens — only the ``~/.codex`` file does.

The access token is a JWT whose
``https://api.openai.com/auth.chatgpt_account_id`` claim supplies the
``chatgpt-account-id`` header the Codex Responses endpoint requires.
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import httpx
from filelock import FileLock

from ...i18n import backend_i18n

# Official Codex OAuth app — the only way to reuse a ChatGPT subscription.
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
# Custom claim namespace OpenAI embeds in the access/id token JWTs.
JWT_AUTH_CLAIM = "https://api.openai.com/auth"
# Refresh this many seconds before the JWT's own ``exp`` to avoid racing expiry.
REFRESH_SKEW_SECONDS = 120


class CodexAuthError(Exception):
    """A Codex auth failure carrying a stable ``code`` + relogin hint.

    ``relogin_required`` distinguishes "the user must authenticate again"
    (invalid/expired refresh token) from transient conditions like a 429
    quota cap, where the stored credentials are still valid.
    """

    def __init__(self, message: str, *, code: str, relogin_required: bool) -> None:
        super().__init__(message)
        self.code = code
        self.relogin_required = relogin_required


@dataclass(frozen=True)
class CodexCreds:
    """Resolved, ready-to-use Codex credentials for one request build."""

    access_token: str
    refresh_token: str
    account_id: Optional[str]
    id_token: Optional[str]


def _codex_home() -> Path:
    """``$CODEX_HOME`` if set, else ``~/.codex`` — matches the codex CLI."""
    configured = os.getenv("CODEX_HOME", "").strip()
    base = Path(configured) if configured else Path.home() / ".codex"
    return base.expanduser()


def _auth_path() -> Path:
    return _codex_home() / "auth.json"


def _decode_jwt_claims(token: str) -> Dict[str, Any]:
    """Decode a JWT's payload segment. Returns ``{}`` on any malformation."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # restore base64url padding
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        return decoded if isinstance(decoded, dict) else {}
    except Exception:  # noqa: BLE001 — any decode failure means "no claims"
        return {}


def _extract_account_id(access_token: str) -> Optional[str]:
    """The ``chatgpt_account_id`` from the access token's OpenAI auth claim."""
    auth = _decode_jwt_claims(access_token).get(JWT_AUTH_CLAIM)
    if isinstance(auth, dict):
        acct = auth.get("chatgpt_account_id")
        if isinstance(acct, str) and acct:
            return acct
    return None


def _access_token_is_expiring(access_token: str, skew: int = REFRESH_SKEW_SECONDS) -> bool:
    """True if the JWT's ``exp`` is within ``skew`` seconds of now.

    A token with no parseable ``exp`` is treated as *not* expiring — we let the
    server reject it with a 401 rather than refresh blindly.
    """
    exp = _decode_jwt_claims(access_token).get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= time.time() + max(0, skew)


def read_codex_auth() -> Optional[Dict[str, Any]]:
    """Read ``~/.codex/auth.json`` raw. Returns ``None`` if absent or invalid.

    Validity here means: a dict with a ``tokens`` object carrying non-empty
    ``access_token`` and ``refresh_token`` strings.
    """
    try:
        data = json.loads(_auth_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = data.get("tokens")
    if not isinstance(tokens, dict):
        return None
    access, refresh = tokens.get("access_token"), tokens.get("refresh_token")
    if not isinstance(access, str) or not access:
        return None
    if not isinstance(refresh, str) or not refresh:
        return None
    return data


def _write_codex_auth(data: Dict[str, Any], tokens: Dict[str, Any]) -> None:
    """Atomically write rotated ``tokens`` back into ``auth.json``.

    Preserves the surrounding ``auth_mode`` / ``OPENAI_API_KEY`` shape, refreshes
    ``last_refresh``, and writes via temp-file + ``os.replace`` under a file lock
    so a concurrent codex CLI write can't tear the file.
    """
    path = _auth_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    new_data = dict(data)
    new_data["tokens"] = tokens
    new_data["last_refresh"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    new_data.setdefault("auth_mode", "chatgpt")
    new_data.setdefault("OPENAI_API_KEY", None)
    with FileLock(str(path) + ".lock"):
        tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
        tmp.write_text(json.dumps(new_data, indent=2))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)


def _classify_refresh_error(resp: httpx.Response) -> Tuple[str, bool]:
    """Map a non-200 refresh response to ``(code, relogin_required)``.

    Mirrors Hermes' classification: ``invalid_grant`` / ``invalid_token`` /
    ``invalid_request`` / ``refresh_token_reused`` and any 401/403 mean the
    refresh token is dead → relogin; everything else is a soft failure.
    """
    code = "codex_refresh_failed"
    try:
        err = resp.json().get("error")
        if isinstance(err, dict):
            err = err.get("code") or err.get("type")
        if isinstance(err, str) and err:
            code = err
    except Exception:  # noqa: BLE001 — error body is best-effort
        pass
    relogin = code in {
        "invalid_grant",
        "invalid_token",
        "invalid_request",
        "refresh_token_reused",
    } or resp.status_code in {401, 403}
    return code, relogin


def refresh_codex_auth(
    refresh_token: str, *, client: Optional[httpx.Client] = None
) -> Dict[str, str]:
    """Exchange a refresh token for a fresh access token (no disk write).

    Returns ``{access_token, refresh_token[, id_token]}``. Raises
    :class:`CodexAuthError` with a classified code on any failure. A 429 is
    surfaced distinctly (``relogin_required=False``) because the stored
    credentials remain valid — re-auth cannot lift a quota cap.
    """
    if not refresh_token:
        raise CodexAuthError(
            backend_i18n.text("codex.auth_missing_refresh_token"),
            code="codex_auth_missing_refresh_token",
            relogin_required=True,
        )
    owns = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(20.0))
    try:
        resp = client.post(
            CODEX_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CODEX_CLIENT_ID,
            },
        )
    finally:
        if owns:
            client.close()

    if resp.status_code == 429:
        raise CodexAuthError(
            backend_i18n.text("codex.rate_limited"),
            code="codex_rate_limited",
            relogin_required=False,
        )
    if resp.status_code != 200:
        code, relogin = _classify_refresh_error(resp)
        raise CodexAuthError(
            backend_i18n.text("codex.refresh_failed", status=resp.status_code),
            code=code,
            relogin_required=relogin,
        )
    try:
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise CodexAuthError(
            backend_i18n.text("codex.refresh_invalid_json"),
            code="codex_refresh_invalid_json",
            relogin_required=True,
        ) from exc

    access = payload.get("access_token")
    if not isinstance(access, str) or not access:
        raise CodexAuthError(
            backend_i18n.text("codex.refresh_missing_access_token"),
            code="codex_refresh_missing_access_token",
            relogin_required=True,
        )
    out: Dict[str, str] = {"access_token": access, "refresh_token": refresh_token}
    nxt = payload.get("refresh_token")
    if isinstance(nxt, str) and nxt:
        out["refresh_token"] = nxt
    idt = payload.get("id_token")
    if isinstance(idt, str) and idt:
        out["id_token"] = idt
    return out


def resolve_codex_credentials(
    *, client: Optional[httpx.Client] = None, force: bool = False
) -> Optional[CodexCreds]:
    """Resolve usable Codex credentials from ``~/.codex/auth.json``.

    Returns ``None`` when no local Codex login exists (the caller then triggers
    the OAuth flow). When the stored access token is expiring, refreshes it and
    writes the rotated pair back to ``~/.codex/auth.json`` before returning.

    ``force=True`` refreshes unconditionally, even for a token whose local
    ``exp`` still looks valid — the 401-retry path uses it, since a server that
    just rejected the token (clock skew, server-side revocation) is the ground
    truth the local ``exp`` check can't see.
    """
    data = read_codex_auth()
    if data is None:
        return None
    tokens = dict(data["tokens"])
    if force or _access_token_is_expiring(tokens["access_token"]):
        refreshed = refresh_codex_auth(tokens["refresh_token"], client=client)
        tokens["access_token"] = refreshed["access_token"]
        tokens["refresh_token"] = refreshed["refresh_token"]
        if "id_token" in refreshed:
            tokens["id_token"] = refreshed["id_token"]
        _write_codex_auth(data, tokens)
    access = tokens["access_token"]
    return CodexCreds(
        access_token=access,
        refresh_token=tokens["refresh_token"],
        account_id=_extract_account_id(access),
        id_token=tokens.get("id_token") if isinstance(tokens.get("id_token"), str) else None,
    )


def peek_codex_local() -> Optional[Dict[str, Any]]:
    """Read-only check for an existing local Codex login.

    Returns ``{"account_id": ...}`` when ``~/.codex/auth.json`` has usable
    tokens, else ``None``. Unlike :func:`resolve_codex_credentials` this does
    NOT refresh or write — it's the cheap "is there a local login?" probe the
    GUI uses to offer one-click reuse before falling back to OAuth.
    """
    data = read_codex_auth()
    if data is None:
        return None
    return {"account_id": _extract_account_id(data["tokens"]["access_token"])}


__all__ = [
    "CodexAuthError",
    "CodexCreds",
    "CODEX_CLIENT_ID",
    "CODEX_TOKEN_URL",
    "JWT_AUTH_CLAIM",
    "read_codex_auth",
    "refresh_codex_auth",
    "resolve_codex_credentials",
    "peek_codex_local",
]
