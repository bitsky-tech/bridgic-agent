from typing import Any

import httpx
import pytest

from src.amphi_service.handler import _providers_handler as providers_handler
from src.amphi_service.protocol.llms import openai_llm as openai_module


async def test_catalog(service_client: httpx.AsyncClient) -> None:
    """Returned provider catalog:

    {
      "providers": [
        {
          "id": "<unique id>",
          "protocol": "<wire protocol>",
          "models": [{"id": "<model id>", "vision": true}]
        }
      ]
    }

    Checks:
    1. The catalog returns unique visible providers with a complete wire shape.
    2. Every provider has a valid default auth mode and model projection.
    3. Hidden vendors stay absent while core public channels remain available.
    """
    response = await service_client.get("/providers")

    # Check 1: The catalog returns unique visible providers with a complete wire shape.
    assert response.status_code == 200
    providers = response.json()
    assert providers
    assert len({provider["id"] for provider in providers}) == len(providers)
    for provider in providers:
        assert set(provider) == {
            "id",
            "display_name",
            "protocol",
            "default_base_url",
            "auth_modes",
            "default_auth_mode",
            "models",
        }

    # Check 2: Every provider has a valid default auth mode and model projection.
    for provider in providers:
        assert provider["default_auth_mode"] in provider["auth_modes"]
        assert provider["models"]
        assert all(set(model) == {"id", "vision"} for model in provider["models"])

    # Check 3: Hidden vendors stay absent while core public channels remain available.
    provider_ids = {provider["id"] for provider in providers}
    assert "anthropic" not in provider_ids
    assert {"openai", "google"} <= provider_ids


async def test_add_provider(service_client: httpx.AsyncClient) -> None:
    """Final provider state:

    {
      "providers": [
        {
          "id": "company-gateway",
          "api_key_set": true,
          "is_active": true,
          "protocol": "anthropic",
          "available_models": ["company-model"]
        }
      ],
      "user": {
        "api_key_set": true,
        "protocol": "anthropic"
      }
    }

    Checks:
    1. Saving a custom provider returns its complete redacted HTTP projection.
    2. The first provider carrying a key becomes active without exposing it in the user profile.
    3. Provider lists never expose the stored API key.
    4. Only the explicit key-reveal endpoint returns the stored secret.
    """
    secret = "company-provider-secret"
    payload = {
        "provider_id": "company-gateway",
        "auth_mode": "api_key",
        "api_key": secret,
        "base_url": "https://gateway.example.test/v1",
        "protocol": "anthropic",
        "display_name": "Company Gateway",
        "models": ["company-model"],
    }

    # Check 1: Saving a custom provider returns its complete redacted HTTP projection.
    response = await service_client.post("/me/providers", json=payload)
    assert response.status_code == 201
    provider = {
        "id": "company-gateway",
        "auth_mode": "api_key",
        "api_key_set": True,
        "base_url": "https://gateway.example.test/v1",
        "is_active": True,
        "is_enabled": True,
        "protocol": "anthropic",
        "display_name": "Company Gateway",
        "available_models": ["company-model"],
    }
    assert response.json() == provider
    assert secret not in response.text

    # Check 2: The first keyed provider becomes active while the user profile remains redacted.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["api_key_set"] is True
    assert response.json()["base_url"] == "https://gateway.example.test/v1"
    assert response.json()["protocol"] == "anthropic"
    assert secret not in response.text

    # Check 3: Provider lists never expose the stored API key.
    response = await service_client.get("/me/providers")
    assert response.status_code == 200
    assert response.json() == [provider]
    assert secret not in response.text

    # Check 4: Only the explicit key-reveal endpoint returns the stored secret.
    response = await service_client.get("/me/providers/company-gateway/api-key")
    assert response.status_code == 200
    assert response.json() == {"api_key": secret}


async def test_builtin_protocol(service_client: httpx.AsyncClient) -> None:
    """Final Google provider state:

    {
      "provider": {"id": "google", "protocol": "google"},
      "user": {"protocol": "google"}
    }

    Checks:
    1. A built-in provider uses its catalog protocol instead of a client fallback.
    2. Auto-activation mirrors the resolved protocol onto the user profile.
    """
    # Check 1: A built-in provider uses its catalog protocol instead of a client fallback.
    response = await service_client.post(
        "/me/providers",
        json={
            "provider_id": "google",
            "auth_mode": "api_key",
            "api_key": "offline-google-key",
            "base_url": "https://generativelanguage.example.test",
            "protocol": "openai",
            "models": ["gemini-test"],
        },
    )
    assert response.status_code == 201
    assert response.json()["protocol"] == "google"
    assert response.json()["is_active"] is True

    # Check 2: Auto-activation mirrors the resolved protocol onto the user profile.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["protocol"] == "google"
    assert response.json()["api_key_set"] is True


async def test_active_model(service_client: httpx.AsyncClient) -> None:
    """Final active selection:

    {
      "providers": [
        {"id": "primary", "is_active": false},
        {"id": "standby", "is_active": true}
      ],
      "user": {
        "current_model": "standby-model",
        "protocol": "anthropic"
      }
    }

    Checks:
    1. Adding another keyed provider does not replace the current active channel.
    2. Selecting a provider and model switches the single active channel.
    3. The user profile receives the selected model and provider credentials.
    """
    # Check 1: Adding another keyed provider does not replace the current active channel.
    response = await service_client.post(
        "/me/providers",
        json={
            "provider_id": "primary",
            "api_key": "primary-key",
            "base_url": "https://primary.example.test/v1",
            "models": ["primary-model"],
        },
    )
    assert response.status_code == 201
    assert response.json()["is_active"] is True

    response = await service_client.post(
        "/me/providers",
        json={
            "provider_id": "standby",
            "api_key": "standby-key",
            "base_url": "https://standby.example.test",
            "protocol": "anthropic",
            "models": ["standby-model"],
        },
    )
    assert response.status_code == 201
    assert response.json()["is_active"] is False

    # Check 2: Selecting a provider and model switches the single active channel.
    response = await service_client.post(
        "/me/active-model",
        json={"provider_id": "standby", "model": "standby-model"},
    )
    assert response.status_code == 200
    assert response.json()["current_model"] == "standby-model"

    response = await service_client.get("/me/providers")
    assert response.status_code == 200
    assert [(row["id"], row["is_active"]) for row in response.json()] == [
        ("primary", False),
        ("standby", True),
    ]

    # Check 3: The user profile receives the selected model and provider credentials.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["current_model"] == "standby-model"
    assert response.json()["base_url"] == "https://standby.example.test"
    assert response.json()["protocol"] == "anthropic"
    assert response.json()["api_key_set"] is True


async def test_disable_active(service_client: httpx.AsyncClient) -> None:
    """Final failover state:

    {
      "providers": [
        {"id": "primary", "is_enabled": false, "is_active": false},
        {"id": "standby", "is_enabled": true, "is_active": true}
      ],
      "user": {
        "current_model": "standby-first",
        "base_url": "https://standby.example.test/v1"
      }
    }

    Checks:
    1. Disabling the active provider preserves it but marks it unavailable.
    2. The next enabled keyed provider is automatically promoted.
    3. Failover mirrors the replacement credentials and first available model.
    4. Re-enabling the old provider does not take activity back from the replacement.
    """
    await service_client.post(
        "/me/providers",
        json={
            "provider_id": "primary",
            "api_key": "primary-key",
            "base_url": "https://primary.example.test/v1",
            "models": ["primary-model"],
        },
    )
    await service_client.post(
        "/me/providers",
        json={
            "provider_id": "standby",
            "api_key": "standby-key",
            "base_url": "https://standby.example.test/v1",
            "models": ["standby-first", "standby-second"],
        },
    )

    # Check 1: Disabling the active provider preserves it but marks it unavailable.
    response = await service_client.post(
        "/me/providers/primary/toggle",
        json={"enabled": False},
    )
    assert response.status_code == 200
    assert response.json()["id"] == "primary"
    assert response.json()["is_enabled"] is False

    # Check 2: The next enabled keyed provider is automatically promoted.
    response = await service_client.get("/me/providers")
    assert response.status_code == 200
    assert [
        (row["id"], row["is_enabled"], row["is_active"])
        for row in response.json()
    ] == [
        ("primary", False, False),
        ("standby", True, True),
    ]

    # Check 3: Failover mirrors the replacement credentials and first available model.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["current_model"] == "standby-first"
    assert response.json()["base_url"] == "https://standby.example.test/v1"
    assert response.json()["api_key_set"] is True

    # Check 4: Re-enabling the old provider does not take activity back from the replacement.
    response = await service_client.post(
        "/me/providers/primary/toggle",
        json={"enabled": True},
    )
    assert response.status_code == 200

    response = await service_client.get("/me/providers")
    assert [(row["id"], row["is_active"]) for row in response.json()] == [
        ("primary", False),
        ("standby", True),
    ]


async def test_delete_active(service_client: httpx.AsyncClient) -> None:
    """Final state after removing the only provider:

    {
      "providers": [],
      "user": {
        "api_key_set": false,
        "base_url": null,
        "protocol": "openai"
      }
    }

    Checks:
    1. Deleting the only active provider returns an empty success response.
    2. The deleted provider disappears from later provider lists.
    3. The user profile clears credentials and resets the wire protocol.
    """
    await service_client.post(
        "/me/providers",
        json={
            "provider_id": "temporary",
            "api_key": "temporary-key",
            "base_url": "https://temporary.example.test",
            "protocol": "anthropic",
            "models": ["temporary-model"],
        },
    )

    # Check 1: Deleting the only active provider returns an empty success response.
    response = await service_client.delete("/me/providers/temporary")
    assert response.status_code == 204
    assert response.content == b""

    # Check 2: The deleted provider disappears from later provider lists.
    response = await service_client.get("/me/providers")
    assert response.status_code == 200
    assert response.json() == []

    # Check 3: The user profile clears credentials and resets the wire protocol.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["api_key_set"] is False
    assert response.json()["base_url"] is None
    assert response.json()["protocol"] == "openai"


async def test_missing_provider(service_client: httpx.AsyncClient) -> None:
    """Unknown provider responses:

    {
      "delete": 404,
      "toggle": 404,
      "activate": 404,
      "reveal_key": 404
    }

    Checks:
    1. Deleting an unknown provider returns not found.
    2. Toggling an unknown provider returns not found.
    3. Activating an unknown provider returns not found.
    4. Revealing a key for an unknown provider returns not found.
    """
    # Check 1: Deleting an unknown provider returns not found.
    response = await service_client.delete("/me/providers/missing")
    assert response.status_code == 404

    # Check 2: Toggling an unknown provider returns not found.
    response = await service_client.post(
        "/me/providers/missing/toggle",
        json={"enabled": False},
    )
    assert response.status_code == 404

    # Check 3: Activating an unknown provider returns not found.
    response = await service_client.post(
        "/me/active-model",
        json={"provider_id": "missing", "model": "missing-model"},
    )
    assert response.status_code == 404

    # Check 4: Revealing a key for an unknown provider returns not found.
    response = await service_client.get("/me/providers/missing/api-key")
    assert response.status_code == 404


async def test_provider_validation(service_client: httpx.AsyncClient) -> None:
    """Rejected provider requests:

    {
      "test_without_key": {"ok": false},
      "fetch_without_key": {"ok": false},
      "providers": []
    }

    Checks:
    1. Connection testing without a key returns a client-readable failure envelope.
    2. Model fetching without a key returns the same offline failure contract.
    3. Rejected requests leave the configured provider list empty.
    """
    # Check 1: Connection testing without a key returns a client-readable failure envelope.
    response = await service_client.post(
        "/me/providers/test",
        json={
            "provider_id": "offline",
            "protocol": "openai",
            "api_key": "   ",
            "base_url": "https://must-not-be-contacted.invalid/v1",
            "model": "offline-model",
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["error"]

    # Check 2: Model fetching without a key returns the same offline failure contract.
    response = await service_client.post(
        "/me/providers/fetch-models",
        json={
            "provider_id": "offline",
            "protocol": "openai",
            "api_key": "   ",
            "base_url": "https://must-not-be-contacted.invalid/v1",
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["error"]

    # Check 3: Rejected requests leave the configured provider list empty.
    response = await service_client.get("/me/providers")
    assert response.status_code == 200
    assert response.json() == []


async def test_provider_network_contract(service_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Provider probing and discovery preserve routing, parsing, and secret boundaries.

    Checks:
    1. Connection testing routes the submitted model through the selected adapter.
    2. Google model discovery builds native authentication and filters non-chat models.
    3. Provider errors cannot echo the submitted API key back to the client.
    """
    probe: dict[str, Any] = {}

    class ProbeLlm:
        def __init__(self, **kwargs) -> None:
            probe.update(kwargs)

        async def achat(self, messages: list[Any]) -> object:
            probe["messages"] = messages
            return object()

    monkeypatch.setattr(openai_module, "OpenAICompatLlm", ProbeLlm)
    response = await service_client.post(
        "/me/providers/test",
        json={
            "provider_id": "company-gateway",
            "protocol": "openai",
            "api_key": "probe-secret",
            "base_url": "https://gateway.example.test/v1",
            "model": "company-model",
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert probe["api_key"] == "probe-secret"
    assert probe["api_base"] == "https://gateway.example.test/v1"
    assert probe["configuration"].model == "company-model"
    assert len(probe["messages"]) == 1

    real_async_client = httpx.AsyncClient
    requests: list[httpx.Request] = []
    reflected_secret = "reflected-provider-secret"

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "generativelanguage.example.test":
            return httpx.Response(200, json={
                "models": [
                    {
                        "name": "models/gemini-chat",
                        "displayName": "Gemini Chat",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/text-embedding",
                        "displayName": "Embedding",
                        "supportedGenerationMethods": ["embedContent"],
                    },
                ],
            })
        return httpx.Response(500, text=f"upstream echoed {reflected_secret}")

    def client_factory(*_args, **_kwargs) -> httpx.AsyncClient:
        return real_async_client(transport=httpx.MockTransport(respond))

    monkeypatch.setattr(providers_handler.httpx, "AsyncClient", client_factory)

    response = await service_client.post(
        "/me/providers/fetch-models",
        json={
            "provider_id": "google",
            "protocol": "openai",
            "api_key": "google-secret",
            "base_url": "https://generativelanguage.example.test",
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "models": [{"id": "gemini-chat", "name": "Gemini Chat"}],
    }
    assert str(requests[-1].url) == (
        "https://generativelanguage.example.test/v1beta/models?key=google-secret"
    )
    assert "authorization" not in requests[-1].headers

    response = await service_client.post(
        "/me/providers/fetch-models",
        json={
            "provider_id": "company-gateway",
            "protocol": "openai",
            "api_key": reflected_secret,
            "base_url": "https://error.example.test/v1",
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert reflected_secret not in response.text
    assert "***" in response.json()["error"]
