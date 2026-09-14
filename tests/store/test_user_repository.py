import pytest
from sqlmodel import SQLModel

from src.amphi_store import Repository, SessionRecord, SessionTurnRecord, TurnStatus, UserInput, UserRepository
from tests._support.sandbox import IsolatedPaths


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
    async with repository._engine.connect() as connection:
        columns = (await connection.exec_driver_sql("PRAGMA table_info(users)")).all()
    assert "default_max_rounds" not in {column[1] for column in columns}

    # Check 2: The local User starts with safe model, execution, and credential defaults.
    assert user.current_model == ""
    assert "default_max_rounds" not in user.model_dump()
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


@pytest.mark.parametrize("existing_user", [False, True], ids=["empty-legacy-table", "existing-legacy-user"])
async def test_legacy_round_limit_column(test_sandbox: IsolatedPaths, existing_user: bool) -> None:
    """Upgrading the old users table preserves preferences and permits new user seeding."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    repository = UserRepository()
    try:
        async with repository._engine.begin() as connection:
            # SQLModel's old Python default did not create a SQLite DEFAULT clause.
            await connection.exec_driver_sql("""
                CREATE TABLE users (
                    id VARCHAR NOT NULL PRIMARY KEY,
                    display_name VARCHAR,
                    api_key VARCHAR,
                    base_url VARCHAR,
                    current_model VARCHAR NOT NULL,
                    default_max_rounds INTEGER NOT NULL,
                    default_temperature FLOAT NOT NULL,
                    protocol VARCHAR NOT NULL,
                    execution_mode VARCHAR NOT NULL,
                    created_at DATETIME NOT NULL
                )
            """)
            if existing_user:
                await connection.exec_driver_sql("""
                    INSERT INTO users (
                        id, display_name, api_key, base_url, current_model,
                        default_max_rounds, default_temperature, protocol,
                        execution_mode, created_at
                    ) VALUES (
                        'local', 'Existing user', 'retained-key', 'https://models.example.test/v1',
                        'saved-model', 91, 0.7, 'openai', 'request', '2026-09-01 12:00:00'
                    )
                """)
            await connection.run_sync(SQLModel.metadata.create_all)

        if existing_user:
            # The retired column must not participate in normal ORM reads or updates.
            user = await repository.load(USER_ID)
            assert user is not None
            assert "default_max_rounds" not in user.model_dump()
            assert user.current_model == "saved-model"
            await repository.set_model(USER_ID, "updated-model")
            await repository.set_execution_mode(USER_ID, "full")
            async with repository._session() as session:
                session.add(SessionRecord(
                    id="legacy-session", user_id=USER_ID,
                    workspace_root=str(test_sandbox.sessions / "legacy-session"),
                    title="Preserved session",
                ))
                session.add(SessionTurnRecord(
                    id="legacy-turn", user_id=USER_ID, session_id="legacy-session",
                    session_ordinal=0, user_input=UserInput(text="Preserved request"),
                    status=TurnStatus.COMPLETED, final_answer="Preserved answer", max_rounds=50,
                ))
                await session.commit()

        await Repository.init_schema()
        await Repository.init_schema()
        async with repository._engine.connect() as connection:
            columns = (await connection.exec_driver_sql("PRAGMA table_info(users)")).all()
        assert "default_max_rounds" not in {column[1] for column in columns}
        await repository.ensure_seeded(USER_ID)
        user = await repository.load(USER_ID)
        assert user is not None
        assert "default_max_rounds" not in user.model_dump()
        if existing_user:
            assert user.display_name == "Existing user"
            assert user.current_model == "updated-model"
            assert user.default_temperature == 0.7
            assert user.execution_mode == "full"
            assert user.api_key == "retained-key"
            assert user.base_url == "https://models.example.test/v1"
            async with repository._session() as session:
                stored_session = await session.get(SessionRecord, "legacy-session")
                stored_turn = await session.get(SessionTurnRecord, "legacy-turn")
            assert stored_session is not None
            assert stored_session.user_id == USER_ID
            assert stored_session.title == "Preserved session"
            assert stored_turn is not None
            assert stored_turn.session_id == stored_session.id
            assert stored_turn.user_input.text == "Preserved request"
            assert stored_turn.final_answer == "Preserved answer"
            assert stored_turn.max_rounds == 50
        else:
            assert user.current_model == ""
            assert user.default_temperature == 0.0
            assert user.execution_mode == "auto"

        await repository.ensure_seeded("new-user")
        new_user = await repository.load("new-user")
        assert new_user is not None
        assert new_user.current_model == ""
        assert "default_max_rounds" not in new_user.model_dump()
    finally:
        await Repository.close()


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
