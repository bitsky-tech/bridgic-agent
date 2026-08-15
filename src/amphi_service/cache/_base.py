import asyncio
from typing import Callable, Dict, Generic, List, Optional, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class Registry(Generic[K, V]):
    """A concurrency-safe in-memory map of live runtime objects."""

    def __init__(self) -> None:
        self._items: Dict[K, V] = {}
        self._lock = asyncio.Lock()

    async def get(self, key: K) -> Optional[V]:
        """Return the value for ``key``, or ``None`` if absent."""
        async with self._lock:
            return self._items.get(key)

    async def set(self, key: K, value: V) -> None:
        """Insert or replace ``key``'s value."""
        async with self._lock:
            self._items[key] = value

    async def drop(self, key: K) -> bool:
        """Remove ``key``; return ``True`` iff it was present."""
        async with self._lock:
            return self._items.pop(key, None) is not None

    async def pop(self, key: K) -> Optional[V]:
        """Remove ``key`` and return its value, or ``None`` if absent."""
        async with self._lock:
            return self._items.pop(key, None)

    async def get_or_create(self, key: K, factory: Callable[[], V]) -> V:
        """Return the existing value, else build-store-return one under the lock.

        ``factory`` is a zero-arg **synchronous** callable invoked only on
        a miss, while the lock is held, so concurrent misses serialise and
        share the single built value.
        """
        async with self._lock:
            cached = self._items.get(key)
            if cached is not None:
                return cached
            value = factory()
            self._items[key] = value
            return value

    async def drop_where(self, pred: Callable[[K, V], bool]) -> int:
        """Drop every entry for which ``pred(key, value)`` is true; return the count."""
        async with self._lock:
            doomed = [k for k, v in self._items.items() if pred(k, v)]
            for k in doomed:
                self._items.pop(k, None)
            return len(doomed)

    async def list(self) -> List[V]:
        """Snapshot of all values (locked)."""
        async with self._lock:
            return list(self._items.values())

    # Lock-free reads — synchronous, no ``await`` (a single dict op is
    # atomic from the event loop's POV; a value racing a concurrent writer
    # is never torn). For cheap probes; use the locked variants when a
    # multi-step read must be consistent.
    def peek(self, key: K) -> Optional[V]:
        """Lock-free read of ``key``, or ``None`` if absent."""
        return self._items.get(key)

    def size(self) -> int:
        """Lock-free count of live entries."""
        return len(self._items)

    def snapshot(self) -> Dict[K, V]:
        """Lock-free shallow copy of the backing map."""
        return dict(self._items)


__all__ = ["Registry"]
