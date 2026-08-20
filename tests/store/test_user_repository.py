from src.amphi_store import UserRepository


USER_ID = "local"


async def test_seeded(initialized_store: None) -> None:
    """Final database state:

    {
      "user": {
        "id": "local",
        "current_model": "preserved-model",
        "execution_mode": "auto",
        "protocol": "openai",
        "api_key": null,
        "base_url": null
      }
    }

    Checks:
    1. Store initialization makes the local User immediately loadable.
    2. The local User starts with safe model, execution, and credential defaults.
    3. Seeding again preserves the existing User instead of replacing it.
    """
    repository = UserRepository()

    # Check 1: Store initialization makes the local User immediately loadable.
    user = await repository.load(USER_ID)
    assert user is not None
    assert user.id == USER_ID

    # Check 2: The local User starts with safe model, execution, and credential defaults.
    assert user.current_model == ""
    assert user.default_max_rounds == 50
    assert user.default_temperature == 0.0
    assert user.execution_mode == "auto"
    assert user.protocol == "openai"
    assert user.api_key is None
    assert user.base_url is None

    await repository.set_model(USER_ID, "preserved-model")

    # Check 3: Seeding again preserves the existing User instead of replacing it.
    await repository.ensure_seeded(USER_ID)
    preserved = await repository.load(USER_ID)
    assert preserved is not None
    assert preserved.current_model == "preserved-model"


async def test_preferences(initialized_store: None) -> None:
    """Final database state:

    {
      "user": {
        "id": "local",
        "current_model": "gpt-test",
        "execution_mode": "request"
      }
    }

    Checks:
    1. Changing the model updates the value loaded by later requests.
    2. Changing execution mode updates the global tool-permission preference.
    """
    repository = UserRepository()

    # Check 1: Changing the model updates the value loaded by later requests.
    model_user = await repository.set_model(USER_ID, "gpt-test")
    loaded_model = await repository.load(USER_ID)
    assert model_user is not None
    assert model_user.current_model == "gpt-test"
    assert loaded_model is not None
    assert loaded_model.current_model == "gpt-test"

    # Check 2: Changing execution mode updates the global tool-permission preference.
    mode_user = await repository.set_execution_mode(USER_ID, "request")
    loaded_mode = await repository.load(USER_ID)
    assert mode_user is not None
    assert mode_user.execution_mode == "request"
    assert loaded_mode is not None
    assert loaded_mode.execution_mode == "request"
    assert loaded_mode.current_model == "gpt-test"


async def test_patch_credentials(initialized_store: None) -> None:
    """Final database state:

    {
      "user": {
        "id": "local",
        "api_key": "rotated-key",
        "base_url": "https://api.example.test/v1"
      }
    }

    Checks:
    1. Supplying both credential values stores both of them.
    2. Rotating only the API key preserves the existing base URL.
    3. Empty credential inputs do not erase previously stored values.
    """
    repository = UserRepository()

    # Check 1: Supplying both credential values stores both of them.
    configured = await repository.set_credentials(
        USER_ID,
        api_key="initial-key",
        base_url="https://api.example.test/v1",
    )
    assert configured is not None
    assert configured.api_key == "initial-key"
    assert configured.base_url == "https://api.example.test/v1"

    # Check 2: Rotating only the API key preserves the existing base URL.
    rotated = await repository.set_credentials(
        USER_ID,
        api_key="rotated-key",
        base_url=None,
    )
    assert rotated is not None
    assert rotated.api_key == "rotated-key"
    assert rotated.base_url == "https://api.example.test/v1"

    # Check 3: Empty credential inputs do not erase previously stored values.
    unchanged = await repository.set_credentials(
        USER_ID,
        api_key="",
        base_url="",
    )
    loaded = await repository.load(USER_ID)
    assert unchanged is not None
    assert unchanged.api_key == "rotated-key"
    assert unchanged.base_url == "https://api.example.test/v1"
    assert loaded is not None
    assert loaded.api_key == "rotated-key"
    assert loaded.base_url == "https://api.example.test/v1"


async def test_active_provider(initialized_store: None) -> None:
    """Final database state:

    {
      "user": {
        "id": "local",
        "api_key": null,
        "base_url": null,
        "protocol": "openai",
        "current_model": "claude-test"
      }
    }

    Checks:
    1. Activating a provider replaces the complete chat credential snapshot.
    2. Clearing the active provider removes credentials and resets its protocol.
    3. Clearing without a model leaves the last selected model unchanged.
    """
    repository = UserRepository()

    # Check 1: Activating a provider replaces the complete chat credential snapshot.
    activated = await repository.set_active_provider(
        USER_ID,
        api_key="anthropic-key",
        base_url="https://anthropic.example.test",
        protocol="anthropic",
        model="claude-test",
    )
    assert activated is not None
    assert activated.api_key == "anthropic-key"
    assert activated.base_url == "https://anthropic.example.test"
    assert activated.protocol == "anthropic"
    assert activated.current_model == "claude-test"

    # Check 2: Clearing the active provider removes credentials and resets its protocol.
    cleared = await repository.set_active_provider(
        USER_ID,
        api_key=None,
        base_url=None,
        protocol="openai",
    )
    loaded = await repository.load(USER_ID)
    assert cleared is not None
    assert cleared.api_key is None
    assert cleared.base_url is None
    assert cleared.protocol == "openai"
    assert loaded is not None
    assert loaded.api_key is None
    assert loaded.base_url is None
    assert loaded.protocol == "openai"

    # Check 3: Clearing without a model leaves the last selected model unchanged.
    assert cleared.current_model == "claude-test"
    assert loaded.current_model == "claude-test"
