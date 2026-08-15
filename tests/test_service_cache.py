"""Unit tests for Service-owned, process-local caches."""

from __future__ import annotations

import pytest

from src.amphi_store import User
from src.amphi_service.cache import ClientRegistry, LlmCache, Registry


async def test_registry_atoms_and_lockfree_reads() -> None:
    """Exercise the locked registry atoms and lock-free snapshot reads."""
    registry: Registry[str, int] = Registry()
    assert await registry.get("a") is None
    await registry.set("a", 1)
    assert await registry.get("a") == 1
    assert await registry.drop("a") is True
    assert await registry.drop("a") is False

    await registry.set("b", 7)
    assert await registry.pop("b") == 7
    assert await registry.pop("b") is None

    calls = 0

    def factory() -> int:
        nonlocal calls
        calls += 1
        return 41

    assert await registry.get_or_create("c", factory) == 41
    assert await registry.get_or_create("c", factory) == 41
    assert calls == 1

    for key, value in {"x": 1, "y": 2, "z": 3, "w": 4}.items():
        await registry.set(key, value)
    assert await registry.drop_where(lambda _key, value: value % 2 == 0) == 2
    assert sorted(await registry.list()) == [1, 3, 41]

    assert registry.peek("x") == 1
    assert registry.peek("missing") is None
    assert registry.size() == 3
    snapshot = registry.snapshot()
    assert snapshot == {"x": 1, "z": 3, "c": 41}
    snapshot["new"] = 99
    assert registry.size() == 3


async def test_client_registry_merge_order_expiry_and_unregister(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 10.0
    monkeypatch.setattr(
        "src.amphi_service.cache._clients.time.time",
        lambda: now,
    )
    clients = ClientRegistry()

    await clients.touch(
        client_id="desktop",
        client_type="gui",
        user_agent="Amphi/1",
    )
    now = 20.0
    await clients.touch(client_id="tray", client_type="tray")
    now = 30.0
    await clients.touch(
        client_id="desktop",
        client_type="cli",
        user_agent="Amphi/2",
    )

    rows = await clients.list()
    assert [row.client_id for row in rows] == ["desktop", "tray"]
    assert rows[0].client_type == "gui"
    assert rows[0].connected_at == 10.0
    assert rows[0].last_seen == 30.0
    assert rows[0].user_agent == "Amphi/2"

    await clients.unregister("tray")
    assert [row.client_id for row in await clients.list()] == ["desktop"]

    monkeypatch.setattr(ClientRegistry, "CLIENT_TTL_SECONDS", 5.0)
    now = 40.0
    assert await clients.count() == 0


async def test_llm_cache_builds_once_per_owner_model_and_invalidates_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds: list[tuple[str, str, object]] = []

    def build(user: User, model: str) -> object:
        client = object()
        builds.append((user.id, model, client))
        return client

    monkeypatch.setattr("src.amphi_service.cache._llms.build_llm", build)
    cache = LlmCache()
    first_user = User(id="u1", current_model="m1")
    second_user = User(id="u2", current_model="m1")

    first = await cache.resolve(first_user, "m1")
    assert await cache.resolve(first_user, "m1") is first
    assert await cache.resolve(first_user, "m2") is not first
    second = await cache.resolve(second_user, "m1")
    assert len(builds) == 3

    await cache.invalidate_user(first_user.id)

    assert await cache.resolve(first_user, "m1") is not first
    assert await cache.resolve(second_user, "m1") is second
    assert len(builds) == 4
