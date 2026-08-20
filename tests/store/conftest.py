from collections.abc import AsyncIterator

import pytest

from src.amphi_store import Repository, UserRepository
from tests._support.sandbox import IsolatedPaths


OWNER_ID = "local"


@pytest.fixture
async def initialized_store(test_sandbox: IsolatedPaths) -> AsyncIterator[None]:
    """Initialize one isolated Store database for a single local owner."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded(OWNER_ID)
        yield
    finally:
        await Repository.close()
