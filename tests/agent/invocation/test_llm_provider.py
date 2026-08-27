import pytest

from src.amphi_agent import LlmProvider
from src.amphi_store import ProviderRepository


USER_ID = "local"


async def test_loads_selected_model_limits_from_the_active_provider(agent_store: None, agent_model: str) -> None:
    """The Agent-facing provider owns active-row selection and limit extraction."""
    repository = ProviderRepository()
    await repository.upsert(
        USER_ID,
        "inactive-provider",
        auth_mode="api_key",
        api_key="inactive-key",
        base_url=None,
        models=[agent_model],
        model_limits={agent_model: {"input": 1}},
    )
    active = await repository.upsert(
        USER_ID,
        "active-provider",
        auth_mode="api_key",
        api_key="active-key",
        base_url=None,
        models=[agent_model],
        model_limits={agent_model: {"context": 100, "output": 20, "source": "manual"}},
    )
    await repository.set_active(USER_ID, active.provider_id)

    provider = await LlmProvider(USER_ID, agent_model).load()

    assert provider.model_id == agent_model
    assert provider.model_limits == {"context": 100, "output": 20, "source": "manual"}
    assert provider.input_capacity() == 80


@pytest.mark.parametrize(
    ("limits", "expected"),
    [
        ({"input": 64, "context": 100, "output": 20}, 64),
        ({"context": 100, "output": 20}, 80),
        ({"context": 100}, 100),
        ({"context": 20, "output": 20}, None),
        ({"input": "invalid", "context": 100, "output": 10}, 90),
        ({}, None),
    ],
)
def test_calculates_the_usable_input_capacity(limits: dict[str, object], expected: int | None) -> None:
    """Capacity normalization belongs to the provider domain object."""
    provider = LlmProvider(model_id="test-model", model_limits=limits)

    assert provider.input_capacity() == expected
