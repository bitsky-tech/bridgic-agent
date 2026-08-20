import httpx


async def test_profile(service_client: httpx.AsyncClient) -> None:
    """Returned user profile:

    {
      "id": "local",
      "current_model": "",
      "api_key_set": false,
      "protocol": "openai",
      "execution_mode": "auto"
    }

    Checks:
    1. The profile exposes the complete safe defaults for a new local user.
    2. The profile reports credential presence without exposing a secret field.
    """
    response = await service_client.get("/me")

    # Check 1: The profile exposes the complete safe defaults for a new local user.
    assert response.status_code == 200
    assert response.json() == {
        "id": "local",
        "display_name": None,
        "current_model": "",
        "base_url": None,
        "default_max_rounds": 50,
        "default_temperature": 0.0,
        "api_key_set": False,
        "protocol": "openai",
        "execution_mode": "auto",
    }

    # Check 2: The profile reports credential presence without exposing a secret field.
    assert "api_key" not in response.json()


async def test_credentials(service_client: httpx.AsyncClient) -> None:
    """Final credential state:

    {
      "api_key": "<stored but redacted>",
      "api_key_set": true,
      "base_url": "https://models.example.test/v1"
    }

    Checks:
    1. Saving credentials returns only the key-presence flag and base URL.
    2. Later credential reads preserve the values without leaking the API key.
    3. The user profile immediately reflects the same credential state.
    4. An empty update leaves the configured credentials unchanged.
    """
    secret = "service-test-secret"
    credentials = {
        "api_key": secret,
        "base_url": "https://models.example.test/v1",
    }

    # Check 1: Saving credentials returns only the key-presence flag and base URL.
    response = await service_client.post("/me/credentials", json=credentials)
    assert response.status_code == 200
    assert response.json() == {
        "api_key_set": True,
        "base_url": "https://models.example.test/v1",
    }
    assert secret not in response.text

    # Check 2: Later credential reads preserve the values without leaking the API key.
    response = await service_client.get("/me/credentials")
    assert response.status_code == 200
    assert response.json() == {
        "api_key_set": True,
        "base_url": "https://models.example.test/v1",
    }
    assert secret not in response.text

    # Check 3: The user profile immediately reflects the same credential state.
    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["api_key_set"] is True
    assert response.json()["base_url"] == "https://models.example.test/v1"
    assert secret not in response.text

    # Check 4: An empty update leaves the configured credentials unchanged.
    response = await service_client.post(
        "/me/credentials",
        json={"api_key": "", "base_url": ""},
    )
    assert response.status_code == 200
    assert response.json() == {
        "api_key_set": True,
        "base_url": "https://models.example.test/v1",
    }


async def test_model(service_client: httpx.AsyncClient) -> None:
    """Final model state:

    {
      "model": "offline-test-model",
      "profile": {"current_model": "offline-test-model"}
    }

    Checks:
    1. Selecting a model returns the newly stored model id.
    2. The model endpoint and user profile expose the same selection.
    """
    # Check 1: Selecting a model returns the newly stored model id.
    response = await service_client.post(
        "/me/model",
        json={"model": "offline-test-model"},
    )
    assert response.status_code == 200
    assert response.json() == {"model": "offline-test-model"}

    # Check 2: The model endpoint and user profile expose the same selection.
    response = await service_client.get("/me/model")
    assert response.status_code == 200
    assert response.json() == {"model": "offline-test-model"}

    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["current_model"] == "offline-test-model"


async def test_execution_mode(service_client: httpx.AsyncClient) -> None:
    """Final execution preference:

    {
      "mode": "request",
      "invalid_update_status": 422
    }

    Checks:
    1. Changing execution mode updates the global user preference.
    2. The mode endpoint and user profile expose the same preference.
    3. An unsupported mode is rejected and cannot change the stored preference.
    """
    # Check 1: Changing execution mode updates the global user preference.
    response = await service_client.post(
        "/me/execution-mode",
        json={"mode": "request"},
    )
    assert response.status_code == 200
    assert response.json() == {"mode": "request"}

    # Check 2: The mode endpoint and user profile expose the same preference.
    response = await service_client.get("/me/execution-mode")
    assert response.status_code == 200
    assert response.json() == {"mode": "request"}

    response = await service_client.get("/me")
    assert response.status_code == 200
    assert response.json()["execution_mode"] == "request"

    # Check 3: An unsupported mode is rejected and cannot change the stored preference.
    response = await service_client.post(
        "/me/execution-mode",
        json={"mode": "unrestricted"},
    )
    assert response.status_code == 422

    response = await service_client.get("/me/execution-mode")
    assert response.status_code == 200
    assert response.json() == {"mode": "request"}
