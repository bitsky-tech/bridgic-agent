from ...amphi_store import ProviderRepository, UserRepository
from ._current_user import LOCAL_USER_ID


async def seed_local_user() -> None:
    """Ensure the local user exists and mirror its active product provider."""
    users = UserRepository()
    await users.ensure_seeded(LOCAL_USER_ID)

    providers = await ProviderRepository().list_for_user(LOCAL_USER_ID)
    active = next((row for row in providers if row.is_active and row.is_enabled), None)
    if active is None:
        await users.set_active_provider(
            LOCAL_USER_ID, api_key=None, base_url=None, protocol="openai", model="",
        )
        return

    user = await users.load(LOCAL_USER_ID)
    models = active.enabled_models if isinstance(active.enabled_models, list) else []
    current_model = user.current_model if user and user.current_model in models else ""
    if not current_model and models:
        current_model = models[0]
    await users.set_active_provider(
        LOCAL_USER_ID,
        api_key=active.api_key,
        base_url=active.base_url,
        protocol=active.protocol,
        model=current_model,
    )


__all__ = ["seed_local_user"]
