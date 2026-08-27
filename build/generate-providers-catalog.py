#!/usr/bin/env python3
"""Download the complete models.dev catalog for application packaging."""

from __future__ import annotations

import argparse
import json
import os
import runpy
import urllib.request
from pathlib import Path
from typing import Any, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[1]
POLICIES_PATH = (
    PROJECT_ROOT
    / "src"
    / "amphi_service"
    / "protocol"
    / "llms"
    / "_provider_policies.py"
)
DEFAULT_OUTPUT = POLICIES_PATH.with_name("_models_dev_catalog.json")
MODELS_DEV_URL = "https://models.dev/api.json"
MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024


def _provider_policies() -> Tuple[dict, ...]:
    namespace = runpy.run_path(str(POLICIES_PATH))
    values = namespace.get("PROVIDER_POLICIES")
    if not isinstance(values, tuple) or not all(isinstance(item, dict) for item in values):
        raise ValueError("provider policy did not expose PROVIDER_POLICIES")
    return values


def validate_catalog(payload: Any, policies: Tuple[dict, ...]) -> None:
    """Validate product-policy references without changing downloaded data."""
    if not isinstance(payload, dict):
        raise ValueError("models.dev response must be a JSON object")
    for policy in policies:
        source_provider_id = policy["source_provider_id"]
        provider = payload.get(source_provider_id)
        if not isinstance(provider, dict):
            raise ValueError(f"models.dev provider {source_provider_id!r} is missing")
        models = provider.get("models")
        if not isinstance(models, dict):
            raise ValueError(f"models.dev provider {source_provider_id!r} has no model map")
        for configured_model_id in policy["default_model_ids"]:
            source_model_id = configured_model_id
            if source_provider_id == "openrouter" and source_model_id.endswith(":free"):
                source_model_id = source_model_id[: -len(":free")]
            if source_model_id not in models:
                raise ValueError(
                    f"default model {policy['id']}/{configured_model_id} is missing "
                    f"from models.dev provider {source_provider_id!r}"
                )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--url", default=MODELS_DEV_URL)
    args = parser.parse_args()

    request = urllib.request.Request(
        args.url,
        headers={"User-Agent": "Bridgic-Agent catalog builder"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(body) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"models.dev response exceeds {MAX_DOWNLOAD_BYTES} bytes")

    payload = json.loads(body)
    validate_catalog(payload, _provider_policies())

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_bytes(body)
    os.replace(temporary, output)
    model_count = sum(
        len(provider.get("models", {}))
        for provider in payload.values()
        if isinstance(provider, dict) and isinstance(provider.get("models"), dict)
    )
    print(
        f"[providers-catalog] wrote raw snapshot {output} "
        f"({len(payload)} providers, {model_count} models, {len(body)} bytes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
