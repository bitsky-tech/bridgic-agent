from typing import Any, Dict

from ...amphi_store import ProviderCredential, ProviderRepository, UserRepository
from ..protocol.llms._providers_catalog import catalog_model_limits
from ._current_user import LOCAL_USER_ID


async def seed_local_user() -> None:
    """Ensure the local user exists and reconcile its product providers."""
    def migrated_model_limits(provider: ProviderCredential) -> Dict[str, Dict[str, Any]]:
        """Fill legacy model metadata without replacing stored ceilings."""
        models = (
            provider.enabled_models
            if isinstance(provider.enabled_models, list)
            else []
        )
        stored = (
            provider.model_limits
            if isinstance(provider.model_limits, dict)
            else {}
        )
        migrated = dict(stored)
        for model_id in models:
            packaged = catalog_model_limits(provider.provider_id, model_id)
            existing = stored.get(model_id)
            existing = existing if isinstance(existing, dict) else {}
            if packaged is not None:
                migrated[model_id] = {**packaged, **existing}
        return migrated

    users = UserRepository()
    await users.ensure_seeded(LOCAL_USER_ID)

    repository = ProviderRepository()
    providers = await repository.list_for_user(LOCAL_USER_ID)
    migrated = False
    for provider in providers:
        model_limits = migrated_model_limits(provider)
        if model_limits == provider.model_limits:
            continue
        await repository.upsert(
            LOCAL_USER_ID,
            provider.provider_id,
            auth_mode=provider.auth_mode,
            api_key=None,
            base_url=None,
            model_limits=model_limits,
        )
        migrated = True
    if migrated:
        providers = await repository.list_for_user(LOCAL_USER_ID)

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
