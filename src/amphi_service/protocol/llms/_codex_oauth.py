"""Codex OAuth — Authorization Code + PKCE over a temporary localhost:1455 server.

Reuses the official Codex OAuth app (``client_id`` from ``_codex_credentials``),
whose ``redirect_uri`` is locked by OpenAI to ``http://localhost:1455/auth/callback``
(any other port/scheme → ``redirect_uri mismatch``). The callback server is started
only for the duration of one sign-in and torn down as soon as the code arrives.

Tokens are persisted to ``~/.codex/auth.json`` (shared with the codex CLI), same
as the local-reuse path — the app is just another codex client.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from ...i18n import Locale, backend_i18n, locale_from_accept_language
from ._codex_credentials import (
    CODEX_CLIENT_ID,
    CODEX_TOKEN_URL,
    CodexAuthError,
)

logger = logging.getLogger(__name__)

AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
REDIRECT_URI = "http://localhost:1455/auth/callback"
CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 1455
CALLBACK_PATH = "/auth/callback"
SCOPE = "openid profile email offline_access"
DEFAULT_ORIGINATOR = "codex_cli_rs"

# Custom scheme the success page tries to launch — pulls focus back to the
# desktop app. MUST match the Electron setAsDefaultProtocolClient scheme.
APP_SCHEME = "amphi"
_APP_DEEPLINK = f"{APP_SCHEME}://oauth/callback"

# Desktop product display name shown on the success page. Mirrors
# desktop/apps/electron/src/shared/app-meta.ts :: APP_PRODUCT_NAME.
APP_PRODUCT_NAME = "Bridgic Agent"

# Branded sign-in success page (dark, mirrors the official Codex page). Auto-
# attempts the app scheme on load; the button is the manual fallback.
def render_success_page(locale: Locale) -> str:
    """Render the OAuth completion page in the browser's preferred locale."""
    return f"""<!doctype html>
<html lang="{locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{APP_PRODUCT_NAME}</title>
<style>
  html,body{{margin:0;height:100%}}
  body{{display:flex;flex-direction:column;align-items:center;justify-content:center;
       background:#0a0a0a;color:#ededed;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
  .brand{{font-size:22px;font-weight:700;letter-spacing:.3px;opacity:.92}}
  .tick{{margin-top:40px;font-size:15px;color:#9aa0a6}}
  .hint{{margin-top:6px;font-size:13px;color:#6b7177}}
  .btn{{margin-top:28px;display:inline-flex;align-items:center;gap:8px;
       padding:10px 22px;border-radius:999px;background:#161616;
       border:1px solid #2a2a2a;color:#ededed;font-size:14px;
       text-decoration:none;cursor:pointer;transition:background .15s}}
  .btn:hover{{background:#1f1f1f}}
</style>
</head>
<body>
  <div class="brand">{APP_PRODUCT_NAME}</div>
  <div class="tick">✓ {backend_i18n.text("codex.oauth_success", locale=locale)}</div>
  <div class="hint">{backend_i18n.text("codex.oauth_launching_app", locale=locale, product=APP_PRODUCT_NAME)}</div>
  <a class="btn" href="{_APP_DEEPLINK}">{backend_i18n.text("codex.oauth_open_app", locale=locale, product=APP_PRODUCT_NAME)}</a>
  <script>
    // Try to launch the desktop app automatically (the browser will ask "Open {APP_PRODUCT_NAME}?").
    setTimeout(function(){{ window.location.href = "{_APP_DEEPLINK}"; }}, 400);
  </script>
</body>
</html>"""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_pkce() -> Tuple[str, str]:
    """Return ``(verifier, challenge)`` — 32-byte verifier, SHA-256 (S256)."""
    verifier = _b64url(os.urandom(32))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def build_authorize_url(
    *,
    challenge: str,
    state: str,
    redirect_uri: str = REDIRECT_URI,
    originator: str = DEFAULT_ORIGINATOR,
) -> str:
    """Build the ``auth.openai.com/oauth/authorize`` URL (params per pi-ai)."""
    params = {
        "response_type": "code",
        "client_id": CODEX_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": originator,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def parse_callback(path: str, expected_state: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse a callback request path → ``(code, error)``.

    ``(code, None)`` on success; ``(None, reason)`` for a wrong route, a
    state mismatch, a provider error, or a missing code. Pure — unit-tested
    independently of the HTTP server.
    """
    parts = urlsplit(path)
    if parts.path != CALLBACK_PATH:
        return None, "not_found"
    query = parse_qs(parts.query)
    if query.get("state", [None])[0] != expected_state:
        return None, "state_mismatch"
    code = query.get("code", [None])[0]
    if not code:
        return None, query.get("error", ["missing_authorization_code"])[0]
    return code, None


def exchange_code(
    code: str,
    verifier: str,
    *,
    redirect_uri: str = REDIRECT_URI,
    client: Optional[httpx.Client] = None,
    locale: Locale | None = None,
) -> Dict[str, str]:
    """Exchange an authorization code for tokens. Raises CodexAuthError on failure."""
    owns = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(20.0))
    try:
        resp = client.post(
            CODEX_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": CODEX_CLIENT_ID,
                "code_verifier": verifier,
            },
        )
    finally:
        if owns:
            client.close()
    if resp.status_code != 200:
        try:
            body = resp.text[:800]
        except Exception:
            body = "<unreadable>"
        # Surface the real reason (server.log + the AuthError message → GUI),
        # instead of a generic "please retry".
        logger.error(
            "[codex-oauth] code->token exchange failed: HTTP %s body=%s",
            resp.status_code,
            body,
        )
        raise CodexAuthError(
            backend_i18n.text(
                "codex.exchange_failed",
                locale=locale,
                status=resp.status_code,
                body=body[:300],
            ),
            code="codex_token_exchange_failed",
            relogin_required=True,
        )
    payload = resp.json()
    access = payload.get("access_token")
    if not isinstance(access, str) or not access:
        raise CodexAuthError(
            backend_i18n.text("codex.exchange_missing_access_token", locale=locale),
            code="codex_exchange_missing_access_token",
            relogin_required=True,
        )
    return {
        "access_token": access,
        "refresh_token": payload.get("refresh_token", "") or "",
        "id_token": payload.get("id_token", "") or "",
    }


def persist_codex_tokens(tokens: Dict[str, str]) -> Optional[str]:
    """Write exchanged tokens to ``~/.codex/auth.json``; return the account_id.

    Builds the codex-CLI auth.json shape (extracting ``account_id`` from the
    access token JWT) and writes atomically via the credentials module.
    """
    from ._codex_credentials import _extract_account_id, _write_codex_auth

    account_id = _extract_account_id(tokens["access_token"]) or ""
    full = {
        "id_token": tokens.get("id_token", ""),
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "account_id": account_id,
    }
    _write_codex_auth({"OPENAI_API_KEY": None, "auth_mode": "chatgpt"}, full)
    return account_id


class CodexCallbackServer:
    """Process-wide singleton ``127.0.0.1:1455`` OAuth callback server.

    ONE server for the whole daemon lifetime — NOT one-per-sign-in. Each
    sign-in :meth:`register`s its ``state``; an inbound callback is matched by
    the ``state`` IN THE REQUEST against the routing table (:attr:`_pending`),
    not against a per-server ``expected_state``. So when a browser reuses a
    stale keep-alive connection (the success page's) to deliver the NEXT
    sign-in's callback, that callback still lands its code in the right session
    — fixing the per-session-server race where a just-finished sign-in's
    still-connected server stole the next sign-in's callback (state_mismatch →
    HTTP 404). A single server also can't leak the port or wedge shutdown,
    since it never opens/closes per sign-in.

    Concurrency: :attr:`_pending` is shared between the server's per-connection
    request threads and the async handlers / TTL-reaper threads; every access
    takes :attr:`_lock`.
    """

    _lock: ClassVar[threading.Lock] = threading.Lock()
    _server: ClassVar[Optional[ThreadingHTTPServer]] = None
    _thread: ClassVar[Optional[threading.Thread]] = None
    #: state -> {"code": str | None, "error": str | None}
    _pending: ClassVar[Dict[str, Dict[str, Optional[str]]]] = {}

    @classmethod
    def register(cls, state: str) -> bool:
        """Track ``state`` and ensure the singleton server is running.

        Returns ``False`` only if 1455 can't be bound on first start (an
        external process / codex CLI holds it). Once the server is up, later
        registers just add to the table and always succeed.
        """
        with cls._lock:
            if cls._server is None and not cls._start_locked():
                return False
            cls._pending[state] = {"code": None, "error": None}
        return True

    @classmethod
    def unregister(cls, state: str) -> None:
        """Stop tracking ``state`` (sign-in finalized / cancelled / reaped).

        The server itself stays up for the daemon's lifetime — there is nothing
        to tear down per sign-in anymore.
        """
        with cls._lock:
            cls._pending.pop(state, None)

    @classmethod
    def code_for(cls, state: str) -> Optional[str]:
        """The authorization code captured for ``state``, or ``None``."""
        with cls._lock:
            slot = cls._pending.get(state)
            return slot["code"] if slot else None

    @classmethod
    def error_for(cls, state: str) -> Optional[str]:
        """The callback error captured for ``state``, or ``None``."""
        with cls._lock:
            slot = cls._pending.get(state)
            return slot["error"] if slot else None

    @classmethod
    def _start_locked(cls) -> bool:
        # Caller holds _lock. Bind 1455 + serve_forever on a daemon thread.
        try:
            cls._server = ThreadingHTTPServer(
                (CALLBACK_HOST, CALLBACK_PORT), cls._build_handler()
            )
        except OSError:
            return False
        cls._thread = threading.Thread(target=cls._server.serve_forever, daemon=True)
        cls._thread.start()
        return True

    @classmethod
    def _build_handler(cls) -> type:
        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:  # silence stderr
                pass

            def do_GET(self) -> None:  # noqa: N802 — http.server API
                browser_locale = locale_from_accept_language(self.headers.get("Accept-Language"))
                parts = urlsplit(self.path)
                query = parse_qs(parts.query)
                recv_state = query.get("state", [None])[0]
                code = query.get("code", [None])[0]
                # Match state + stamp code/error atomically under the lock (so it
                # can't race a concurrent unregister). Route by the REQUEST's
                # state — that's what makes a reused-connection callback land in
                # the right session.
                outcome = "ignore"  # ignore | code | error
                err_text = ""
                if parts.path == CALLBACK_PATH and recv_state:
                    with cls._lock:
                        slot = cls._pending.get(recv_state)
                        if slot is not None:
                            if code:
                                slot["code"] = code
                                outcome = "code"
                            else:
                                err_text = query.get(
                                    "error", ["missing_authorization_code"]
                                )[0]
                                slot["error"] = err_text
                                outcome = "error"
                if outcome == "code":
                    # Branded success page + auto-attempt to launch the desktop app.
                    self._send_html(200, render_success_page(browser_locale))
                elif outcome == "error":
                    self._send_html(
                        400,
                        "<html><body style='font-family:sans-serif'>"
                        f"{backend_i18n.text('codex.oauth_login_failed', locale=browser_locale, error=err_text)}"
                        "</body></html>",
                    )
                else:
                    # Not an ACTIVE sign-in's state: a stale callback delivered
                    # over a reused connection after its session was finalized,
                    # or /favicon.ico, or foreign. Ignore — never poison a live
                    # session. An active sign-in's genuine callback always matches.
                    self.send_response(404)
                    self.end_headers()

            def _send_html(self, status_code: int, html: str) -> None:
                self.send_response(status_code)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html.encode())

        return _Handler


__all__ = [
    "AUTHORIZE_URL",
    "REDIRECT_URI",
    "CALLBACK_PORT",
    "SCOPE",
    "generate_pkce",
    "build_authorize_url",
    "parse_callback",
    "exchange_code",
    "persist_codex_tokens",
    "CodexCallbackServer",
]
