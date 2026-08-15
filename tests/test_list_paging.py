"""Offset pagination on /sessions, /mounts, /schedules.

Bare calls keep full-list semantics; `limit` pages (roots for /sessions,
rows elsewhere) with the 200 clamp handled in the store layer.
"""
import httpx


async def test_sessions_pages_by_root(client: httpx.AsyncClient) -> None:
    ids = []
    for _ in range(5):
        ids.append((await client.post("/sessions", json={})).json()["id"])
    full = (await client.get("/sessions")).json()
    assert len(full) == 5
    page = (await client.get("/sessions", params={"limit": 2, "offset": 0})).json()
    assert [r["id"] for r in page] == [r["id"] for r in full[:2]]
    page2 = (await client.get("/sessions", params={"limit": 2, "offset": 4})).json()
    assert len(page2) == 1


async def test_mounts_page_walk(client: httpx.AsyncClient, tmp_path) -> None:
    sid = (await client.post("/sessions", json={})).json()["id"]
    for index in range(5):
        target = tmp_path / f"f{index}.txt"
        target.write_text("x")
        resp = await client.post(f"/sessions/{sid}/mounts", json={"path": str(target)})
        assert resp.status_code in (200, 201), resp.text
    full = (await client.get("/mounts")).json()
    page = (await client.get("/mounts", params={"limit": 2, "offset": 2})).json()
    assert [r["id"] for r in page] == [r["id"] for r in full[2:4]]


async def test_schedules_page_walk(client: httpx.AsyncClient) -> None:
    for index in range(4):
        resp = await client.post("/schedules", json={
            "name": f"s{index}", "desc": "定时任务", "cron": "0 0 9 * * *",
        })
        assert resp.status_code in (200, 201), resp.text
    full = (await client.get("/schedules")).json()
    assert len(full) == 4
    page = (await client.get("/schedules", params={"limit": 3, "offset": 3})).json()
    assert len(page) == 1
