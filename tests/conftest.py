import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.amphi_agent.runtime._environment import (
    agent_cli_shim,
    app_command_environment,
    bundled_node_base_runtime,
    bundled_node_runtime,
    bundled_python_runtime,
    bundled_runtime_resources,
    bundled_uv_runtime,
)
from tests._support.sandbox import IsolatedPaths


HOST_RUNTIME_VARIABLES = (
    "AMPHI_BUNDLED_RESOURCES_DIR",
    "AMPHI_BUNDLED_BIN_DIR",
    "AMPHI_BUNDLED_UV_BIN_DIR",
    "AMPHI_BUNDLED_UV_RUNTIME_DIR",
    "AMPHI_BUNDLED_PYTHON_RUNTIME_DIR",
    "AMPHI_BUNDLED_PYTHON",
    "AMPHI_BUNDLED_NODE_RUNTIME_DIR",
    "UV_PYTHON",
)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Keep real-provider tests opt-in even when their local credentials exist."""
    if os.getenv("AMPHI_RUN_LIVE_TESTS") == "1":
        return
    skip_live = pytest.mark.skip(reason="Set AMPHI_RUN_LIVE_TESTS=1 to run live provider tests")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture(autouse=True)
def isolated_host_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """Keep packaged-runtime discovery and writes inside one test directory."""
    for variable in HOST_RUNTIME_VARIABLES:
        monkeypatch.delenv(variable, raising=False)

    data_home = tmp_path / "app-data"
    monkeypatch.setenv("AMPHI_POLICY_FILE", str(data_home / "policy.json"))
    monkeypatch.setattr(agent_cli_shim, "root", data_home / "command-shims")
    monkeypatch.setattr(bundled_runtime_resources, "_source_root", tmp_path)
    monkeypatch.setattr(bundled_uv_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_python_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_python_runtime, "root", data_home / "python" / "base")
    monkeypatch.setattr(bundled_node_base_runtime, "data_home", data_home)
    monkeypatch.setattr(bundled_node_base_runtime, "root", data_home / "node" / "base")
    monkeypatch.setattr(bundled_node_base_runtime, "cache", data_home / "node" / "cache")
    monkeypatch.setattr(app_command_environment, "strict", False)

    bundled_runtime_resources.reset_cache()
    bundled_uv_runtime.reset_cache()
    bundled_python_runtime.reset()
    bundled_node_runtime.reset_cache()
    bundled_node_base_runtime.reset()
    app_command_environment.reset()
    try:
        yield
    finally:
        app_command_environment.reset()
        bundled_uv_runtime.reset_cache()
        bundled_python_runtime.reset()
        bundled_node_runtime.reset_cache()
        bundled_node_base_runtime.reset()
        bundled_runtime_resources.reset_cache()


@pytest.fixture
def test_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> IsolatedPaths:
    """Create one filesystem sandbox without starting application services."""
    paths = IsolatedPaths.from_root(tmp_path)
    paths.home.mkdir(parents=True)
    monkeypatch.chdir(paths.root)
    for variable, value in paths.application_environment().items():
        monkeypatch.setenv(variable, value)
    return paths
