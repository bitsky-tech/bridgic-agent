import secrets
from typing import ClassVar, Optional

from fastapi import HTTPException, status
from starlette.requests import HTTPConnection


class TokenAuth:
    """Mutable holder for the current bearer token.

    Stored as ``ServiceState.auth`` so handlers (and the
    :func:`require_bearer_token` dependency via ``request.app.state``)
    can reach the active token without dependency-injection plumbing.
    The token is set at daemon startup; rotation is a follow-up.
    """

    TOKEN_BYTES: ClassVar[int] = 32  # 256-bit entropy

    def __init__(self, *, token: Optional[str] = None) -> None:
        self._token: Optional[str] = token

    @property
    def current_token(self) -> Optional[str]:
        return self._token

    def set_token(self, token: str) -> None:
        if not token:
            raise ValueError("Token must be a non-empty string.")
        self._token = token

    @classmethod
    def generate(cls) -> str:
        """Return a cryptographically random URL-safe token."""
        return secrets.token_urlsafe(cls.TOKEN_BYTES)


def require_bearer_token(conn: HTTPConnection) -> None:
    """FastAPI dependency: ``401`` if the Bearer header is missing or wrong.

    Looks up the active :class:`TokenAuth` via ``conn.app.state.auth``
    (populated by :class:`ServiceApp`). Returns ``503 Service Unavailable``
    when the server has no token configured — that's a server-side
    misconfiguration, fail closed.

    The parameter is annotated :class:`~starlette.requests.HTTPConnection`,
    the common base of ``Request`` and ``WebSocket``, **not** ``Request``.
    This dependency is attached at router level, so it also runs for the
    ``/ws`` route — and FastAPI cannot supply a ``Request`` on a WebSocket
    scope, so a ``Request`` annotation raises ``TypeError: missing 1
    required positional argument`` on every chat connection instead of
    returning 401. ``HTTPConnection`` resolves on both scopes and exposes
    the only two attributes needed here (``app`` and ``headers``).

    Constant-time compare via :func:`secrets.compare_digest` defends
    against timing oracles; cheap insurance even on local-only.
    """
    auth: Optional[TokenAuth] = getattr(conn.app.state, "auth", None)
    expected = auth.current_token if auth is not None else None
    if expected is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured on the server.",
        )

    header = conn.headers.get("Authorization")
    if not header or not header.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    presented = header[len("bearer "):].strip()
    if not secrets.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


__all__ = ["TokenAuth", "require_bearer_token"]
