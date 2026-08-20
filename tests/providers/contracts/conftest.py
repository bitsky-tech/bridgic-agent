from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from src.amphi_service.protocol.llms import anthropic_llm, openai_llm
from src.amphi_store import User


@pytest.fixture(autouse=True)
def isolated_provider_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep provider caches and local credentials inside one test sandbox."""
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))
    caches = (openai_llm._REJECTED_PARAMS, anthropic_llm._REJECTED_PARAMS)
    for cache in caches:
        cache.clear()
    yield
    for cache in caches:
        cache.clear()


@pytest.fixture
def provider_user() -> Callable[..., User]:
    def build(protocol: str, api_key: str | None = "test-key", base_url: str | None = None, model: str = "test-model") -> User:
        return User(
            id="local",
            current_model=model,
            protocol=protocol,
            api_key=api_key,
            base_url=base_url,
        )

    return build
