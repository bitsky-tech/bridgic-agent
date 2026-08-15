"""``/skills`` — capability-unit registry.

GET list / GET detail / DELETE — POST is intentionally absent (skills are
imported via zip/git, not created by metadata). Seed data goes in directly
via SkillRepository.
"""

from __future__ import annotations

import httpx
import pytest

from src.amphi_agent import SkillLibrary
from src.amphi_store import SkillRepository

USER_ID = "local"
BUILTIN_NAMES = set(SkillLibrary.builtin_names())


@pytest.fixture
async def seeded_skills(temp_db_path) -> list[int]:
    """Insert two skill rows and return their skill_ids."""
    _ = temp_db_path  # ensures BRIDGIC_AGENT_STATE_DB points at the test DB
    repo = SkillRepository()
    s1 = await repo.create(
        USER_ID,
        name="lark-doc",
        description="Create and edit Feishu docs.",
        skill_dir="/skills/lark-doc",
        group="imported",
        source="github",
        source_uri="https://github.com/example/lark-doc",
    )
    s2 = await repo.create(
        USER_ID,
        name="github-pr",
        description="Open and review GitHub pull requests.",
        skill_dir="/skills/github-pr",
        group="imported",
        source="github",
        source_uri="https://github.com/example/github-pr",
    )
    return [s1.id, s2.id]


async def test_list_empty(client: httpx.AsyncClient) -> None:
    rows = (await client.get("/skills")).json()
    assert {row["name"] for row in rows} == BUILTIN_NAMES
    assert all(row["group"] == "builtin" for row in rows)


async def test_list(client: httpx.AsyncClient, seeded_skills: list[int]) -> None:
    rows = (await client.get("/skills")).json()
    assert len(rows) == len(BUILTIN_NAMES) + len(seeded_skills)
    ids = {r["skill_id"] for r in rows}
    assert set(seeded_skills).issubset(ids)


async def test_detail(client: httpx.AsyncClient, seeded_skills: list[int]) -> None:
    skill_id = seeded_skills[0]
    detail = (await client.get(f"/skill/{skill_id}")).json()
    assert detail["skill_id"] == skill_id
    assert detail["name"] == "lark-doc"
    assert detail["description"] == "Create and edit Feishu docs."
    assert detail["skill_dir"] == "/skills/lark-doc"
    assert detail["group"] == "imported"
    assert detail["source"] == "github"
    assert detail["source_uri"] == "https://github.com/example/lark-doc"
    assert detail["updated_at"] is not None


async def test_get_unknown_returns_404(client: httpx.AsyncClient) -> None:
    assert (await client.get("/skill/99999")).status_code == 404


async def test_delete(client: httpx.AsyncClient, seeded_skills: list[int]) -> None:
    skill_id = seeded_skills[0]
    assert (await client.delete(f"/skill/{skill_id}")).status_code == 204
    assert (await client.get(f"/skill/{skill_id}")).status_code == 404
    rows = (await client.get("/skills")).json()
    assert {row["name"] for row in rows} == BUILTIN_NAMES | {"github-pr"}
    assert any(row["skill_id"] == seeded_skills[1] for row in rows)


async def test_delete_unknown_returns_404(client: httpx.AsyncClient) -> None:
    assert (await client.delete("/skill/99999")).status_code == 404


async def test_post_not_allowed(client: httpx.AsyncClient) -> None:
    assert (await client.post("/skills", json={})).status_code == 405


async def test_enabled_defaults_true(
    client: httpx.AsyncClient, seeded_skills: list[int]
) -> None:
    detail = (await client.get(f"/skill/{seeded_skills[0]}")).json()
    assert detail["enabled"] is True


async def test_toggle_disable_then_enable(
    client: httpx.AsyncClient, seeded_skills: list[int]
) -> None:
    skill_id = seeded_skills[0]

    off = await client.post(f"/skill/{skill_id}/toggle", json={"enabled": False})
    assert off.status_code == 200
    assert off.json()["enabled"] is False

    # Persisted: a fresh GET still reports disabled.
    assert (await client.get(f"/skill/{skill_id}")).json()["enabled"] is False

    on = await client.post(f"/skill/{skill_id}/toggle", json={"enabled": True})
    assert on.status_code == 200
    assert on.json()["enabled"] is True


async def test_toggle_does_not_hide_from_list(
    client: httpx.AsyncClient, seeded_skills: list[int]
) -> None:
    await client.post(f"/skill/{seeded_skills[0]}/toggle", json={"enabled": False})
    rows = (await client.get("/skills")).json()
    assert len(rows) == len(BUILTIN_NAMES) + len(seeded_skills)


async def test_toggle_unknown_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post("/skill/99999/toggle", json={"enabled": False})
    assert resp.status_code == 404


async def test_builtin_can_be_toggled_but_not_deleted(client: httpx.AsyncClient) -> None:
    rows = (await client.get("/skills")).json()
    builtin = next(row for row in rows if row["name"] == "how-to")

    off = await client.post(
        f"/skill/{builtin['skill_id']}/toggle", json={"enabled": False},
    )
    assert off.status_code == 200
    assert off.json()["enabled"] is False

    rejected = await client.delete(f"/skill/{builtin['skill_id']}")
    assert rejected.status_code == 409
    assert "cannot be deleted" in rejected.json()["detail"]
    assert (await client.get(f"/skill/{builtin['skill_id']}")).status_code == 200
