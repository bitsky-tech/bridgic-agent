"""Focused persistence tests for User and Provider repositories.

Driven directly against a temporary repository connection rather than
through HTTP — the wire paths are covered by test_me / test_memory /
test_persistence. These pin the repository semantics, notably the two
deliberately-distinct credential-update policies. The sibling
MemoryRepository's owner-scoped CRUD is covered by those same atoms
(see the note inside the test).
"""

from __future__ import annotations

from src.amphi_service.auth import seed_local_user
from src.amphi_store import ProviderRepository, Repository, UserRepository


async def test_user_repository_seed_load_and_credential_policies(temp_db_path) -> None:
    # Sibling MemoryRepository is NOT unit-tested here: its create/list/delete ride
    # the same owner-scoped atoms (_list_owned / _delete_owned) exercised through
    # SessionRepository in test_persistence (incl. the wrong-user → False gate), its
    # recall ranking is covered by test_memory, and its CRUD wire surface by test_me.
    Repository.connect()
    await Repository.init_schema()
    try:
        users = UserRepository()

        # ensure_seeded inserts an unconfigured user.
        await users.ensure_seeded("local")
        loaded = await users.load("local")
        assert loaded is not None and loaded.current_model == ""
        assert loaded.api_key is None

        # set_credentials patches only truthy values (the /me/credentials
        # policy): a truthy api_key sets, a falsy base_url leaves it alone.
        await users.set_credentials("local", api_key="sk-set", base_url=None)
        loaded = await users.load("local")
        assert loaded.api_key == "sk-set"
        assert loaded.base_url is None

        # Re-seeding never imports or changes model credentials.
        await users.ensure_seeded("local")
        loaded = await users.load("local")
        assert loaded.api_key == "sk-set"
        assert loaded.base_url is None
        assert loaded.current_model == ""

        # set_active_provider overwrites unconditionally (incl. clearing to
        # None) and optionally sets the model.
        await users.set_active_provider(
            "local", api_key=None, base_url=None, model="m9",
        )
        loaded = await users.load("local")
        assert loaded.api_key is None
        assert loaded.base_url is None
        assert loaded.current_model == "m9"

        await users.set_model("local", "m10")
        assert (await users.load("local")).current_model == "m10"

        # Missing user -> None on both read and mutate.
        assert await users.load("ghost") is None
        assert await users.set_model("ghost", "x") is None
    finally:
        await Repository.close()


async def test_startup_repairs_user_mirror_from_active_provider(temp_db_path) -> None:
    """A stale env-era mirror cannot redirect a Codex provider after restart."""
    Repository.connect()
    await Repository.init_schema()
    try:
        await seed_local_user()
        providers = ProviderRepository()
        await providers.upsert(
            "local",
            "openai",
            auth_mode="oauth",
            api_key=None,
            base_url=None,
            protocol="openai-codex",
            models=["gpt-5.5"],
        )
        await providers.set_active("local", "openai")

        users = UserRepository()
        await users.set_active_provider(
            "local",
            api_key="legacy-env-key",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            protocol="openai-codex",
            model="gpt-5.5",
        )

        await seed_local_user()
        loaded = await users.load("local")
        assert loaded is not None
        assert loaded.api_key is None
        assert loaded.base_url is None
        assert loaded.protocol == "openai-codex"
        assert loaded.current_model == "gpt-5.5"
    finally:
        await Repository.close()
