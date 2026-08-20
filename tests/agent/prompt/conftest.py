from collections.abc import AsyncIterator

import pytest

from src.amphi_store import Repository, UserRepository
from tests._support.sandbox import IsolatedPaths


USER_ID = "local"


@pytest.fixture
async def prompt_store(test_sandbox: IsolatedPaths) -> AsyncIterator[None]:
    """Initialize the isolated catalogues rendered by Prompt Context tests."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded(USER_ID)
        yield
    finally:
        await Repository.close()
