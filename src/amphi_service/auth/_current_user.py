from ...amphi_store import User, UserRepository

# The single hard-coded identity for Phase 1 single-user deployments.
# Kept here (not in :mod:`src.amphi_store._user`) because it is an
# authentication concern, not a data-model concern.
LOCAL_USER_ID: str = "local"


async def get_current_user() -> User:
    """Return the :class:`User` row for the current request.

    Phase 1: always returns the ``local`` user. The row is seeded at
    daemon startup (see :func:`seed_local_user`) — if it's missing
    here, something has gone wrong with startup ordering.

    Phase N: signature will grow to accept a ``Request`` (or a
    decoded principal) and dispatch to the right row.

    .. note::
       The returned ``User`` is **detached** — the ``AsyncSession``
       used to load it is already closed by the time we return.
       Attribute reads work (``expire_on_commit=False``), but any
       attempt to lazy-load relationships or to mutate-and-flush will
       fail. Handlers that need to mutate the user go through the
       :class:`UserRepository` setters, which re-load + commit the row in
       their own session.

    Raises
    ------
    RuntimeError
        When the local user row is missing — indicates daemon startup
        did not seed correctly.
    """
    user = await UserRepository().load(LOCAL_USER_ID)
    if user is None:
        raise RuntimeError(
            f"User row {LOCAL_USER_ID!r} is missing — the daemon's "
            "startup seed step did not run. Check the lifespan "
            "hook in ServiceApp."
        )
    return user


__all__ = ["LOCAL_USER_ID", "get_current_user"]
