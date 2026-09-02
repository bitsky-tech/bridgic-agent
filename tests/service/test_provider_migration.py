from src.amphi_service.auth import seed_local_user
from src.amphi_service.protocol.llms import catalog_model_limits
from src.amphi_store import ProviderRepository, Repository, UserRepository
from tests._support.sandbox import IsolatedPaths


async def test_legacy_provider_models_receive_packaged_limits(test_sandbox: IsolatedPaths) -> None:
    """Legacy providers gain packaged limits without losing stored metadata."""
    model_id = "gpt-5.5"
    unknown_model_id = "unknown-model"
    expected = catalog_model_limits("openai", model_id)
    assert expected is not None

    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded("local")
        repository = ProviderRepository()
        await repository.upsert(
            "local",
            "openai",
            auth_mode="api_key",
            api_key="legacy-key",
            base_url=None,
            models=[model_id, unknown_model_id],
        )
        await repository.set_active("local", "openai")

        engine = Repository._engine
        assert engine is not None
        async with engine.begin() as connection:
            await connection.exec_driver_sql(
                "ALTER TABLE provider_credentials DROP COLUMN model_limits"
            )

        await Repository.init_schema()
        before = (await repository.list_for_user("local"))[0]
        assert before.model_limits == {}

        await seed_local_user()

        after = (await repository.list_for_user("local"))[0]
        assert after.enabled_models == [model_id, unknown_model_id]
        assert after.model_limits == {model_id: expected}

        await seed_local_user()
        repeated = (await repository.list_for_user("local"))[0]
        assert repeated.model_limits == after.model_limits

        stored_context = expected["context"] + 1
        await repository.upsert(
            "local",
            "openai",
            auth_mode="api_key",
            api_key="provider-key",
            base_url=None,
            models=[model_id],
            model_limits={
                model_id: {
                    "context": stored_context,
                    "source": "provider",
                },
            },
        )

        await seed_local_user()

        provider = (await repository.list_for_user("local"))[0]
        assert provider.model_limits[model_id] == {
            **expected,
            "context": stored_context,
            "source": "provider",
        }
    finally:
        await Repository.close()
