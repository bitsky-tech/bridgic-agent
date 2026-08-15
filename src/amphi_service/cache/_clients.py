import time
from dataclasses import dataclass
from typing import ClassVar, List, Optional

from ._base import Registry


# Logical type alias used by callers. Current clients emit ``gui`` /
# ``cli`` / ``tray`` / ``unknown``; legacy and custom values remain accepted.
ClientType = str


@dataclass(frozen=True)
class ClientInfo:
    """One online-client's record. Timestamps are unix epoch seconds."""

    client_id: str
    client_type: ClientType
    connected_at: float
    last_seen: float
    user_agent: Optional[str] = None


class ClientRegistry(Registry[str, ClientInfo]):
    """In-memory client registry — a :class:`Registry` of
    :class:`ClientInfo` keyed by client id.

    Owned by :class:`ServiceApp` and exposed via
    :attr:`ServiceState.clients` for handlers / dependencies. Storage and
    locking come from the base; this subclass specialises the TTL purge
    and the merge-on-touch semantics.
    """

    CLIENT_TTL_SECONDS: ClassVar[float] = 300.0  # 5 minutes

    async def touch(
        self,
        *,
        client_id: str,
        client_type: ClientType = "unknown",
        user_agent: Optional[str] = None,
    ) -> None:
        """Record activity from ``client_id``. Idempotent + cheap.

        First touch creates the entry; subsequent touches refresh
        ``last_seen`` but preserve ``connected_at`` and
        ``client_type`` — a client doesn't get to change its type
        mid-session, that would mask a buggy caller.
        """
        now = time.time()
        # Read-modify-write merge: keep an explicit locked section (the
        # atoms can't express "merge fields of the existing value").
        async with self._lock:
            existing = self._items.get(client_id)
            if existing is None:
                self._items[client_id] = ClientInfo(
                    client_id=client_id,
                    client_type=client_type,
                    connected_at=now,
                    last_seen=now,
                    user_agent=user_agent,
                )
            else:
                self._items[client_id] = ClientInfo(
                    client_id=existing.client_id,
                    client_type=existing.client_type,
                    connected_at=existing.connected_at,
                    last_seen=now,
                    user_agent=user_agent or existing.user_agent,
                )

    async def unregister(self, client_id: str) -> None:
        """Explicit disconnect (e.g. WS close). No-op if unknown."""
        await self.pop(client_id)

    async def list(self) -> List[ClientInfo]:
        """Return currently-online clients, sorted by ``connected_at``.

        Lazily purges expired entries first. Overrides the base's unordered
        :meth:`Registry.list` with a connected-at ordering.
        """
        await self._purge_expired()
        return sorted(self.snapshot().values(), key=lambda c: c.connected_at)

    async def count(self) -> int:
        """Return the number of currently-online clients (post-purge)."""
        await self._purge_expired()
        return self.size()

    async def _purge_expired(self) -> None:
        """Drop entries whose ``last_seen`` is older than the TTL."""
        cutoff = time.time() - self.CLIENT_TTL_SECONDS
        await self.drop_where(lambda _cid, info: info.last_seen < cutoff)


__all__ = ["ClientInfo", "ClientRegistry", "ClientType"]
