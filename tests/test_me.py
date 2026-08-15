"""``/me`` — user-scoped surface (profile, model, memories).

Consolidated: profile (+ no-key-leak), credentials (set + no-echo), model
read/write, and memories CRUD. (Credential truthy-merge semantics are covered
at the repository layer in ``test_repository_base.py``.)
"""

from __future__ import annotations

import httpx


async def test_me_profile_model_and_no_key_leak(client: httpx.AsyncClient) -> None:
    """Profile reflects the seeded baseline; api_key never leaks; setting
    credentials flips api_key_set but the key still never echoes; the model
    reads the seed and a POST updates it across both /me/model and /me."""
    body = (await client.get("/me")).json()
    assert body["id"] == "local"
    assert body["current_model"] == "mock-model"
    assert body["api_key_set"] is False
    assert body["base_url"] is None
    assert "api_key" not in body
    assert "sk-" not in (await client.get("/me")).text

    # Model read/write across both surfaces.
    assert (await client.get("/me/model")).json() == {"model": "mock-model"}
    updated = await client.post("/me/model", json={"model": "next-model"})
    assert updated.json() == {"model": "next-model"}
    assert (await client.get("/me/model")).json() == {"model": "next-model"}
    assert (await client.get("/me")).json()["current_model"] == "next-model"

    # Credentials flip api_key_set; the key never echoes anywhere.
    await client.post(
        "/me/credentials", json={"api_key": "sk-x", "base_url": "https://e.example/v1"}
    )
    body = (await client.get("/me")).json()
    assert body["api_key_set"] is True
    assert body["base_url"] == "https://e.example/v1"
    assert "sk-x" not in (await client.get("/me")).text


async def test_memories_crud(client: httpx.AsyncClient) -> None:
    """empty → create (201, int id, default source) → list → delete → 404."""
    assert (await client.get("/me/memories")).json() == []

    created = (await client.post("/me/memories", json={"content": "prefers TS"})).json()
    assert created["content"] == "prefers TS"
    assert created["source"] == "manual"  # defaulted when omitted
    assert isinstance(created["id"], int)
    assert created["created_at"]

    await client.post("/me/memories", json={"content": "memo two", "source": "manual"})
    rows = (await client.get("/me/memories")).json()
    assert {r["content"] for r in rows} == {"prefers TS", "memo two"}

    assert (await client.delete(f"/me/memories/{created['id']}")).status_code == 204
    assert all(r["id"] != created["id"] for r in (await client.get("/me/memories")).json())
    assert (await client.delete("/me/memories/99999")).status_code == 404


async def test_execution_mode_read_write_and_validation(client: httpx.AsyncClient) -> None:
    """默认 auto;POST 在 /me/execution-mode 与 /me 两处生效;非法值 422 且不改动状态。"""
    assert (await client.get("/me/execution-mode")).json() == {"mode": "auto"}
    assert (await client.get("/me")).json()["execution_mode"] == "auto"

    updated = await client.post("/me/execution-mode", json={"mode": "request"})
    assert updated.json() == {"mode": "request"}
    assert (await client.get("/me/execution-mode")).json() == {"mode": "request"}
    assert (await client.get("/me")).json()["execution_mode"] == "request"

    # 非法值 -> 422(Literal 校验),且模式保持不变。
    assert (await client.post("/me/execution-mode", json={"mode": "bogus"})).status_code == 422
    assert (await client.get("/me/execution-mode")).json() == {"mode": "request"}
