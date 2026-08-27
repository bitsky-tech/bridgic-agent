import json
import runpy
import sys
from pathlib import Path
from typing import Any


def test_catalog_builder_writes_the_complete_response_unchanged(tmp_path, monkeypatch) -> None:
    """The packaging step validates but does not project or rewrite api.json."""
    root = Path(__file__).resolve().parents[2]
    script = root / "build" / "generate-providers-catalog.py"
    snapshot = (
        root
        / "src"
        / "amphi_service"
        / "protocol"
        / "llms"
        / "_models_dev_catalog.json"
    )
    body = snapshot.read_bytes()

    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *args: Any) -> None:
            return None

        def read(self, _: int) -> bytes:
            return body

    namespace = runpy.run_path(str(script))
    output = tmp_path / "catalog.json"
    monkeypatch.setattr(namespace["urllib"].request, "urlopen", lambda *args, **kwargs: Response())
    monkeypatch.setattr(sys, "argv", [str(script), "--output", str(output)])

    assert namespace["main"]() == 0
    assert output.read_bytes() == body
    payload = json.loads(body)
    assert len(payload) > 100
    assert sum(len(provider.get("models", {})) for provider in payload.values()) > 1_000
