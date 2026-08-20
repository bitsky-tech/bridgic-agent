from collections.abc import AsyncIterator

import pytest

from src.amphi_store import Repository, UserRepository
from tests._support.sandbox import IsolatedPaths


@pytest.fixture
def agent_model() -> str:
    """Use one explicit model identity across isolated Invocation contracts."""
    return "invocation-model"


@pytest.fixture
async def agent_store(test_sandbox: IsolatedPaths, agent_model: str) -> AsyncIterator[None]:
    """Initialize one Store for an isolated Invocation contract."""
    await Repository.close()
    Repository.connect(test_sandbox.state_db)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded("local")
        await UserRepository().set_model("local", agent_model)
        yield
    finally:
        await Repository.close()
