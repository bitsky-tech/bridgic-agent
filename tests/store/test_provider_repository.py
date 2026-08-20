from src.amphi_store import ProviderCredential, ProviderRepository


USER_ID = "local"


async def _create_provider(
    repository: ProviderRepository,
    provider_id: str,
    *,
    auth_mode: str = "api_key",
    api_key: str | None = "test-key",
    base_url: str | None = None,
    protocol: str | None = "openai",
    display_name: str | None = None,
    models: list[str] | None = None,
) -> ProviderCredential:
    """Persist one local provider through the public repository API."""
    return await repository.upsert(
        USER_ID,
        provider_id,
        auth_mode=auth_mode,
        api_key=api_key,
        base_url=base_url,
        protocol=protocol,
        display_name=display_name,
        models=models,
    )


async def test_upsert(initialized_store: None) -> None:
    """Final database state:

    {
      "providers": [
        {
          "id": "custom",
          "auth_mode": "api_key",
          "api_key": "",
          "base_url": "",
          "protocol": "openai",
          "display_name": "",
          "enabled_models": [],
          "is_active": true
        }
      ]
    }

    Checks:
    1. The first upsert creates a complete provider configuration.
    2. Updating only auth mode preserves optional fields and active state.
    3. Explicit empty values clear nullable text and model-list settings.
    4. Repeated upserts keep one row for the provider id.
    """
    repository = ProviderRepository()

    # Check 1: The first upsert creates a complete provider configuration.
    created = await _create_provider(
        repository,
        "custom",
        api_key="initial-key",
        base_url="https://api.example.test/v1",
        protocol="anthropic",
        display_name="Custom Channel",
        models=["model-a", "model-b"],
    )
    assert created.id is not None
    assert created.provider_id == "custom"
    assert created.auth_mode == "api_key"
    assert created.api_key == "initial-key"
    assert created.base_url == "https://api.example.test/v1"
    assert created.protocol == "anthropic"
    assert created.display_name == "Custom Channel"
    assert created.enabled_models == ["model-a", "model-b"]
    assert created.is_enabled is True
    assert created.is_active is False

    await repository.set_active(USER_ID, "custom")

    # Check 2: Updating only auth mode preserves optional fields and active state.
    updated = await repository.upsert(
        USER_ID,
        "custom",
        auth_mode="oauth",
        api_key=None,
        base_url=None,
        protocol=None,
        display_name=None,
        models=None,
    )
    assert updated.id == created.id
    assert updated.auth_mode == "oauth"
    assert updated.api_key == "initial-key"
    assert updated.base_url == "https://api.example.test/v1"
    assert updated.protocol == "anthropic"
    assert updated.display_name == "Custom Channel"
    assert updated.enabled_models == ["model-a", "model-b"]
    assert updated.is_active is True

    # Check 3: Explicit empty values clear nullable text and model-list settings.
    cleared = await repository.upsert(
        USER_ID,
        "custom",
        auth_mode="api_key",
        api_key="",
        base_url="",
        protocol="openai",
        display_name="",
        models=[],
    )
    assert cleared.api_key == ""
    assert cleared.base_url == ""
    assert cleared.protocol == "openai"
    assert cleared.display_name == ""
    assert cleared.enabled_models == []
    assert cleared.is_active is True

    # Check 4: Repeated upserts keep one row for the provider id.
    providers = await repository.list_for_user(USER_ID)
    assert [provider.provider_id for provider in providers] == ["custom"]


async def test_order(initialized_store: None) -> None:
    """Returned provider list:

    {
      "providers": ["first", "second", "third"]
    }

    Checks:
    1. Listing providers returns every configured channel oldest first.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "first")
    await _create_provider(repository, "second")
    await _create_provider(repository, "third")

    # Check 1: Listing providers returns every configured channel oldest first.
    providers = await repository.list_for_user(USER_ID)
    assert [provider.provider_id for provider in providers] == [
        "first",
        "second",
        "third",
    ]


async def test_switch_active(initialized_store: None) -> None:
    """Final database state:

    {
      "providers": [
        {"id": "first", "is_active": false},
        {"id": "second", "is_active": true}
      ]
    }

    Checks:
    1. Activating the first provider makes it the only active channel.
    2. Activating the second provider clears the first provider's active flag.
    3. Activating an unknown provider changes nothing and reports no result.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "first")
    await _create_provider(repository, "second")

    # Check 1: Activating the first provider makes it the only active channel.
    first = await repository.set_active(USER_ID, "first")
    after_first = await repository.list_for_user(USER_ID)
    assert first is not None
    assert first.is_active is True
    assert [(provider.provider_id, provider.is_active) for provider in after_first] == [
        ("first", True),
        ("second", False),
    ]

    # Check 2: Activating the second provider clears the first provider's active flag.
    second = await repository.set_active(USER_ID, "second")
    after_second = await repository.list_for_user(USER_ID)
    assert second is not None
    assert second.is_active is True
    assert [(provider.provider_id, provider.is_active) for provider in after_second] == [
        ("first", False),
        ("second", True),
    ]

    # Check 3: Activating an unknown provider changes nothing and reports no result.
    assert await repository.set_active(USER_ID, "missing") is None
    unchanged = await repository.list_for_user(USER_ID)
    assert [(provider.provider_id, provider.is_active) for provider in unchanged] == [
        ("first", False),
        ("second", True),
    ]


async def test_toggle(initialized_store: None) -> None:
    """Final database state:

    {
      "providers": [
        {"id": "primary", "is_enabled": true, "is_active": false},
        {"id": "standby", "is_enabled": true, "is_active": true}
      ]
    }

    Checks:
    1. Disabling a provider hides it from activation without deleting credentials.
    2. A disabled provider cannot replace the currently active provider.
    3. Re-enabling a provider does not automatically promote it to active.
    4. Toggling an unknown provider reports no result.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "primary", api_key="primary-key")
    await _create_provider(repository, "standby", api_key="standby-key")
    await repository.set_active(USER_ID, "standby")

    # Check 1: Disabling a provider hides it from activation without deleting credentials.
    disabled = await repository.set_enabled(USER_ID, "primary", False)
    assert disabled is not None
    assert disabled.is_enabled is False
    assert disabled.api_key == "primary-key"

    # Check 2: A disabled provider cannot replace the currently active provider.
    assert await repository.set_active(USER_ID, "primary") is None
    unchanged = await repository.list_for_user(USER_ID)
    assert [(provider.provider_id, provider.is_active) for provider in unchanged] == [
        ("primary", False),
        ("standby", True),
    ]

    # Check 3: Re-enabling a provider does not automatically promote it to active.
    enabled = await repository.set_enabled(USER_ID, "primary", True)
    providers = await repository.list_for_user(USER_ID)
    assert enabled is not None
    assert enabled.is_enabled is True
    assert [(provider.provider_id, provider.is_active) for provider in providers] == [
        ("primary", False),
        ("standby", True),
    ]

    # Check 4: Toggling an unknown provider reports no result.
    assert await repository.set_enabled(USER_ID, "missing", False) is None


async def test_clear_active(initialized_store: None) -> None:
    """Final database state:

    {
      "providers": [
        {"id": "first", "is_active": false},
        {"id": "second", "is_active": false}
      ]
    }

    Checks:
    1. Clearing activation leaves every provider configured but inactive.
    2. Clearing again keeps the no-active-provider state unchanged.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "first")
    await _create_provider(repository, "second")
    await repository.set_active(USER_ID, "second")

    # Check 1: Clearing activation leaves every provider configured but inactive.
    await repository.clear_active(USER_ID)
    cleared = await repository.list_for_user(USER_ID)
    assert [(provider.provider_id, provider.is_active) for provider in cleared] == [
        ("first", False),
        ("second", False),
    ]

    # Check 2: Clearing again keeps the no-active-provider state unchanged.
    await repository.clear_active(USER_ID)
    unchanged = await repository.list_for_user(USER_ID)
    assert all(provider.is_active is False for provider in unchanged)


async def test_fallback(initialized_store: None) -> None:
    """Returned fallback sequence:

    {
      "first": "oauth-ready",
      "second": "api-ready",
      "third": null
    }

    Checks:
    1. Fallback skips the excluded, disabled, and unconfigured providers.
    2. An enabled OAuth provider is usable without a stored API key.
    3. The next oldest enabled API-key provider is used when OAuth is disabled.
    4. No fallback is returned after all usable alternatives are disabled.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "current", api_key="current-key")
    await _create_provider(repository, "no-key", api_key=None)
    await _create_provider(repository, "disabled", api_key="disabled-key")
    await repository.set_enabled(USER_ID, "disabled", False)
    await _create_provider(
        repository,
        "oauth-ready",
        auth_mode="oauth",
        api_key=None,
    )
    await _create_provider(repository, "api-ready", api_key="api-key")

    # Check 1: Fallback skips the excluded, disabled, and unconfigured providers.
    first = await repository.first_enabled_other(
        USER_ID,
        exclude_provider_id="current",
    )
    assert first is not None
    assert first.provider_id == "oauth-ready"

    # Check 2: An enabled OAuth provider is usable without a stored API key.
    assert first.auth_mode == "oauth"
    assert first.api_key is None
    assert first.is_enabled is True

    # Check 3: The next oldest enabled API-key provider is used when OAuth is disabled.
    await repository.set_enabled(USER_ID, "oauth-ready", False)
    second = await repository.first_enabled_other(
        USER_ID,
        exclude_provider_id="current",
    )
    assert second is not None
    assert second.provider_id == "api-ready"

    # Check 4: No fallback is returned after all usable alternatives are disabled.
    await repository.set_enabled(USER_ID, "api-ready", False)
    assert await repository.first_enabled_other(
        USER_ID,
        exclude_provider_id="current",
    ) is None


async def test_delete(initialized_store: None) -> None:
    """Final database state:

    {
      "providers": []
    }

    Checks:
    1. Deleting an inactive provider reports that no active credentials were removed.
    2. Deleting the active provider reports that its credentials need clearing.
    3. Every deleted provider disappears from later listings.
    4. Deleting an unknown provider reports that nothing matched.
    """
    repository = ProviderRepository()
    await _create_provider(repository, "active")
    await _create_provider(repository, "inactive")
    await repository.set_active(USER_ID, "active")

    # Check 1: Deleting an inactive provider reports that no active credentials were removed.
    assert await repository.delete(USER_ID, "inactive") is False

    # Check 2: Deleting the active provider reports that its credentials need clearing.
    assert await repository.delete(USER_ID, "active") is True

    # Check 3: Every deleted provider disappears from later listings.
    assert await repository.list_for_user(USER_ID) == []

    # Check 4: Deleting an unknown provider reports that nothing matched.
    assert await repository.delete(USER_ID, "missing") is None
