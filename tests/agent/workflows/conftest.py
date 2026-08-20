from collections.abc import AsyncIterator

import pytest

from src.amphi_store import Repository, UserRepository
from tests._support.sandbox import IsolatedPaths


@pytest.fixture
async def workflow_store(test_sandbox: IsolatedPaths) -> AsyncIterator[None]:
    """Keep one isolated Store open for the lifetime of a Workflow contract."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded("local")
        yield
    finally:
        await Repository.close()
