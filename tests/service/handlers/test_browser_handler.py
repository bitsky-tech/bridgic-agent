import httpx


async def test_controller_lifecycle(service_client: httpx.AsyncClient) -> None:
    """Final browser-controller state:

    {
      "available": false,
      "removed_controller": "desktop-browser",
      "exposed_control_token": false
    }

    Checks:
    1. No embedded-browser controller is available initially.
    2. Registering a loopback controller exposes only its public identity.
    3. Removing a different controller id leaves the registration intact.
    4. Removing the registered controller returns the service to unavailable.
    """
    # Check 1: No embedded-browser controller is available initially.
    response = await service_client.get("/api/browser/controller")
    assert response.status_code == 200
    assert response.json() == {"available": False}

    payload = {
        "controller_id": "desktop-browser",
        "generation": "generation-1",
        "control_url": "http://127.0.0.1:43100",
        "control_token": "secret-token-1234567890",
        "cdp_endpoint": "http://127.0.0.1:43101",
        "owner_pid": 1234,
    }

    # Check 2: Registering a loopback controller exposes only its public identity.
    response = await service_client.put("/api/browser/controller", json=payload)
    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "controller_id": "desktop-browser",
        "generation": "generation-1",
        "owner_pid": 1234,
    }

    # Check 3: Removing a different controller id leaves the registration intact.
    response = await service_client.request(
        "DELETE",
        "/api/browser/controller",
        json={"controller_id": "replacement-browser"},
    )
    assert response.status_code == 200
    assert response.json() == {"removed": False}
    current = await service_client.get("/api/browser/controller")
    assert current.json()["controller_id"] == "desktop-browser"

    # Check 4: Removing the registered controller returns the service to unavailable.
    response = await service_client.request(
        "DELETE",
        "/api/browser/controller",
        json={"controller_id": "desktop-browser"},
    )
    assert response.status_code == 200
    assert response.json() == {"removed": True}
    current = await service_client.get("/api/browser/controller")
    assert current.json() == {"available": False}


async def test_controller_validation(service_client: httpx.AsyncClient) -> None:
    """Final browser-controller state:

    {
      "available": false,
      "rejected": ["public endpoint", "loopback endpoint with a path"]
    }

    Checks:
    1. Public controller endpoints are rejected before registration.
    2. Loopback endpoints containing a path are also rejected.
    3. Rejected requests do not publish a controller.
    """
    payload = {
        "controller_id": "desktop-browser",
        "generation": "generation-1",
        "control_url": "http://203.0.113.10:43100",
        "control_token": "secret-token-1234567890",
        "cdp_endpoint": "http://127.0.0.1:43101",
        "owner_pid": 1234,
    }

    # Check 1: Public controller endpoints are rejected before registration.
    response = await service_client.put("/api/browser/controller", json=payload)
    assert response.status_code == 422

    # Check 2: Loopback endpoints containing a path are also rejected.
    payload["control_url"] = "http://127.0.0.1:43100/controller"
    response = await service_client.put("/api/browser/controller", json=payload)
    assert response.status_code == 422

    # Check 3: Rejected requests do not publish a controller.
    response = await service_client.get("/api/browser/controller")
    assert response.status_code == 200
    assert response.json() == {"available": False}
