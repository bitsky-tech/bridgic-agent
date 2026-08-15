"""Authentication — current user + bearer token.

Two concerns live here, both stateless from the request layer's POV
but each holding a different kind of identity:

* :func:`get_current_user` — resolves the User row backing this
  request. Phase 1 stub returns the ``local`` user; future JWT /
  cookie / header parsing lands here.
* :class:`TokenAuth` + :func:`require_bearer_token` — Bearer-token
  gate for the ``/api/*`` surface. One token per daemon process,
  generated at startup, written into ``runtime.json``.

Two distinct identity layers: the token says *whose process can
talk to the daemon*, the user says *which row in the DB owns the
request's effects*. They don't overlap.
"""

from __future__ import annotations

from ._current_user import LOCAL_USER_ID, get_current_user
from ._seed import seed_local_user
from ._token import TokenAuth, require_bearer_token

__all__ = [
    "LOCAL_USER_ID",
    "get_current_user",
    "seed_local_user",
    "TokenAuth",
    "require_bearer_token",
]
