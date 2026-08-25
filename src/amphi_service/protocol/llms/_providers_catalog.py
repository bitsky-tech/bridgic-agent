"""Read the bundled models.dev snapshot and apply Amphi product policy."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from ._provider_policies import PROVIDER_POLICIES, PROVIDER_POLICIES_BY_ID


_RAW_CATALOG_PATH = Path(__file__).with_name("_models_dev_catalog.json")


def _load_raw_catalog() -> Dict[str, dict]:
    try:
        payload = json.loads(_RAW_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Packaged model catalog is unavailable: {_RAW_CATALOG_PATH}"
        ) from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Packaged model catalog must be a provider map")
    return payload


_RAW_PROVIDERS = _load_raw_catalog()


def _positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def _source_provider_id(provider_id: str) -> str:
    if provider_id == "openai-codex":
        return "openai"
    policy = PROVIDER_POLICIES_BY_ID.get(provider_id)
    if policy is not None:
        return policy["source_provider_id"]
    return provider_id


def _source_model(provider_id: str, model_id: str) -> tuple[str, Optional[dict]]:
    source_provider_id = _source_provider_id(provider_id)
    provider = _RAW_PROVIDERS.get(source_provider_id)
    if not isinstance(provider, dict):
        return model_id, None
    models = provider.get("models")
    if not isinstance(models, dict):
        return model_id, None

    model = models.get(model_id)
    if isinstance(model, dict):
        return model_id, model
    if source_provider_id == "openrouter" and model_id.endswith(":free"):
        base_model_id = model_id[: -len(":free")]
        model = models.get(base_model_id)
        if isinstance(model, dict):
            return base_model_id, model
    return model_id, None


def catalog_model(provider_id: str, model_id: str) -> Optional[dict]:
    """Normalize one provider/model pair from the bundled raw snapshot."""
    source_model_id, raw = _source_model(provider_id, model_id)
    if raw is None:
        return None
    raw_limits = raw.get("limit")
    raw_limits = raw_limits if isinstance(raw_limits, dict) else {}
    limits = {
        key: value
        for key in ("context", "input", "output")
        if (value := _positive_int(raw_limits.get(key))) is not None
    }
    modalities = raw.get("modalities")
    modalities = modalities if isinstance(modalities, dict) else {}
    input_modalities = modalities.get("input")
    input_modalities = input_modalities if isinstance(input_modalities, list) else []
    name = raw.get("name")
    return {
        "id": model_id,
        "name": name if isinstance(name, str) and name else model_id,
        "vision": "image" in input_modalities,
        "tool_call": raw.get("tool_call") is True,
        "reasoning": raw.get("reasoning") is True,
        "limits": limits,
        "limits_source": "models_dev",
        "source_provider_id": _source_provider_id(provider_id),
        "source_model_id": source_model_id,
    }


def catalog_model_limits(provider_id: str, model_id: str) -> Optional[dict]:
    """Return token ceilings from the bundled snapshot for database storage."""
    model = catalog_model(provider_id, model_id)
    if model is None or not model["limits"]:
        return None
    return {
        **model["limits"],
        "source": "models_dev",
        "source_provider_id": model["source_provider_id"],
        "source_model_id": model["source_model_id"],
    }


def resolve_model_limits(provider_id: str, model_id: str, submitted: Optional[dict] = None) -> Optional[dict]:
    """Resolve provider, packaged, then manual limits for one selected model."""
    packaged = catalog_model_limits(provider_id, model_id)
    incoming = submitted if isinstance(submitted, dict) else {}
    source = incoming.get("source")

    incoming_limits = {
        key: value
        for key in ("context", "input", "output")
        if (value := _positive_int(incoming.get(key))) is not None
    }
    if source == "provider" and incoming_limits:
        base = packaged or {}
        return {
            **base,
            **incoming_limits,
            "source": "provider",
            "source_provider_id": incoming.get("source_provider_id") or _source_provider_id(provider_id),
            "source_model_id": incoming.get("source_model_id") or model_id,
        }
    if packaged is not None:
        return packaged
    if incoming_limits:
        resolved = {
            **incoming_limits,
            "source": source if source in {"provider", "models_dev", "manual"} else "manual",
        }
        if incoming.get("source_provider_id"):
            resolved["source_provider_id"] = incoming["source_provider_id"]
        if incoming.get("source_model_id"):
            resolved["source_model_id"] = incoming["source_model_id"]
        return resolved
    return None


def _provider_entry(policy: dict) -> dict:
    models = []
    for model_id in policy["default_model_ids"]:
        model = catalog_model(policy["id"], model_id)
        if model is None:
            raise RuntimeError(
                f"Default model {policy['id']}/{model_id} is absent from the packaged catalog"
            )
        models.append({
            "id": model["id"],
            "name": model["name"],
            "vision": model["vision"],
            "tool_call": model["tool_call"],
            "reasoning": model["reasoning"],
            "limits": model["limits"],
        })
    return {
        "id": policy["id"],
        "display_name": policy["display_name"],
        "protocol": policy["protocol"],
        "default_base_url": policy["default_base_url"],
        "auth_modes": list(policy["auth_modes"]),
        "default_auth_mode": policy["default_auth_mode"],
        "models": models,
    }


PROVIDER_CATALOG: List[dict] = [_provider_entry(policy) for policy in PROVIDER_POLICIES]
PROVIDER_CATALOG_BY_ID: Dict[str, dict] = {
    entry["id"]: entry for entry in PROVIDER_CATALOG
}
HIDDEN_PROVIDER_IDS: frozenset[str] = frozenset(
    policy["id"] for policy in PROVIDER_POLICIES if policy.get("hidden") is True
)


def visible_catalog() -> List[dict]:
    """Return product-visible provider presets backed by the raw snapshot."""
    return [entry for entry in PROVIDER_CATALOG if entry["id"] not in HIDDEN_PROVIDER_IDS]


__all__ = [
    "HIDDEN_PROVIDER_IDS",
    "PROVIDER_CATALOG",
    "PROVIDER_CATALOG_BY_ID",
    "catalog_model",
    "catalog_model_limits",
    "resolve_model_limits",
    "visible_catalog",
]
