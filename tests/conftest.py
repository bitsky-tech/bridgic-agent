from pathlib import Path

import pytest

from tests._support.sandbox import IsolatedPaths


@pytest.fixture
def test_sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> IsolatedPaths:
    """Create one filesystem sandbox without starting application services."""
    paths = IsolatedPaths.from_root(tmp_path)
    paths.home.mkdir(parents=True)
    monkeypatch.chdir(paths.root)
    for variable, value in paths.application_environment().items():
        monkeypatch.setenv(variable, value)
    return paths
