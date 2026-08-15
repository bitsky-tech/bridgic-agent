"""``/sessions/{id}/mounts`` — per-session mounted local paths (registry CRUD).

A mount pins a real local path to a session. External mounts are pointers whose
source survives unmounting; uploaded attachments are Session-owned and removed
with their mount or Session. These drive the REST surface used by the desktop
"AI 资产" panel and ``@`` popover.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest

from src.amphi_store import (
    SessionMountRepository,
    SessionRecord,
    SessionRepository,
    SubAgentMode,
    UserRepository,
)
from src.amphi_service.runtime import SessionAttachmentStore, SessionService


async def _create_session(client: httpx.AsyncClient) -> str:
    return (await client.post("/sessions", json={})).json()["id"]


async def test_mount_crud_lifecycle(client: httpx.AsyncClient, tmp_path) -> None:
    """Full registry CRUD plus daemon-side path validation: mount an existing
    folder (201 + stat'd summary), list, delete by query id (204), unknown id
    (404); a relative path is
    rejected 400 and an absolute-but-missing path 404 — never crashes."""
    sid = await _create_session(client)
    folder = tmp_path / "proj"
    folder.mkdir()
    (folder / "f.txt").write_text("x")

    # Mount an existing folder → 201 with a stat'd summary.
    created = await client.post(f"/sessions/{sid}/mounts", json={"path": str(folder)})
    assert created.status_code == 201
    mount = created.json()
    assert mount["kind"] == "folder"
    assert mount["name"] == "proj"
    assert mount["path"] == str(folder)
    assert mount["exists"] is True
    # Folders are never read — see `test_folder_mounts_are_never_scanned`.
    assert mount["item_count"] is None
    mid = mount["id"]

    # The explicit folder and the read-only system Workspace are both visible.
    listing = (await client.get(f"/sessions/{sid}/mounts")).json()
    assert [m["name"] for m in listing] == ["proj", ".work"]
    assert listing[0]["id"] == mid
    assert listing[0]["removable"] is True
    work_mount = listing[1]
    assert work_mount["path"].endswith(f"/{sid}/.work")
    assert work_mount["removable"] is False

    # Daemon-side validation: relative → 400; absolute-but-missing → 404.
    assert (
        await client.post(f"/sessions/{sid}/mounts", json={"path": "relative/x"})
    ).status_code == 400
    missing = str(tmp_path / "does-not-exist")
    assert (
        await client.post(f"/sessions/{sid}/mounts", json={"path": missing})
    ).status_code == 404

    # Delete the explicit mount; the system Workspace remains.
    assert (
        await client.delete(f"/sessions/{sid}/mounts?id={mid}")
    ).status_code == 204
    remaining = (await client.get(f"/sessions/{sid}/mounts")).json()
    assert [row["name"] for row in remaining] == [".work"]
    assert (
        await client.delete(f"/sessions/{sid}/mounts?id={work_mount['id']}")
    ).status_code == 409
    # Unknown mount id → 404.
    assert (
        await client.delete(f"/sessions/{sid}/mounts?id=mnt_nope")
    ).status_code == 404

    # Deleting the session cascades: its mount rows are swept (registry pointers
    # only — the real folder survives). Re-mount first so a row exists to sweep.
    await client.post(f"/sessions/{sid}/mounts", json={"path": str(folder)})
    assert (await client.delete(f"/sessions/{sid}")).status_code == 204
    rows = await SessionMountRepository().list_for_session(sid, "local")
    assert rows == []
    assert folder.exists()


async def test_mount_list_localizes_untitled_session_from_accept_language(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    """The aggregate asset view keeps its shape while localizing its fallback title."""
    sid = await _create_session(client)
    source = tmp_path / "notes.txt"
    source.write_text("notes")
    assert (
        await client.post(f"/sessions/{sid}/mounts", json={"path": str(source)})
    ).status_code == 201

    response = await client.get("/mounts", headers={"Accept-Language": "en-US,en;q=0.9"})

    assert response.status_code == 200
    assert response.json()[0]["session_title"] == "New conversation"


async def test_upload_creates_managed_mount_and_cleans_its_file(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    created = (await client.post("/sessions", json={})).json()
    sid = created["id"]

    response = await client.post(
        f"/sessions/{sid}/mounts/upload",
        files={"file": ("../../notes.txt", b"hello attachment", "text/plain")},
    )

    assert response.status_code == 201
    mount = response.json()
    assert mount["name"] == "notes.txt"
    assert mount["kind"] == "file"
    path = Path(mount["path"])
    assert path.parent == (tmp_path / "attachments" / sid).resolve()
    assert (Path(created["workspace_root"]) / ".work").is_dir()
    assert not (Path(created["workspace_root"]) / ".git").exists()
    assert path.read_bytes() == b"hello attachment"

    duplicate = (
        await client.post(
            f"/sessions/{sid}/mounts/upload",
            files={"file": ("notes.txt", b"second", "text/plain")},
        )
    ).json()
    duplicate_path = Path(duplicate["path"])
    assert duplicate_path != path
    assert duplicate_path.read_bytes() == b"second"

    assert (
        await client.delete(f"/sessions/{sid}/mounts?id={mount['id']}")
    ).status_code == 204
    assert not path.exists()
    assert duplicate_path.exists()

    assert (await client.delete(f"/sessions/{sid}")).status_code == 204
    assert not duplicate_path.exists()


async def test_mount_upload_requires_an_owned_session(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/sessions/session_missing/mounts/upload",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )

    assert response.status_code == 404


async def test_mount_upload_rejects_oversized_content_before_writing(
    client: httpx.AsyncClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = (await client.post("/sessions", json={})).json()
    monkeypatch.setattr("src.amphi_service.handler._mounts_handler._MAX_ATTACHMENT_BYTES", 4)

    response = await client.post(
        f"/sessions/{created['id']}/mounts/upload",
        files={"file": ("large.bin", b"12345", "application/octet-stream")},
    )

    assert response.status_code == 413
    attachment_dir = (
        tmp_path
        / "attachments"
        / created["id"]
    )
    assert not attachment_dir.exists()


async def test_reset_preserves_root_session_uploads(client: httpx.AsyncClient) -> None:
    created = (await client.post("/sessions", json={})).json()
    sid = created["id"]
    mount = (
        await client.post(
            f"/sessions/{sid}/mounts/upload",
            files={"file": ("notes.txt", b"keep me", "text/plain")},
        )
    ).json()
    path = Path(mount["path"])

    assert (await client.post(f"/sessions/{sid}/reset")).status_code == 204
    assert path.read_bytes() == b"keep me"
    assert mount["id"] in {
        row["id"] for row in (await client.get(f"/sessions/{sid}/mounts")).json()
    }

    child = await SessionRepository().create_child(
        "local",
        parent_session_id=sid,
        parent_call_id="call-child",
        subagent_mode=SubAgentMode.BACKGROUND,
    )
    child_mount = (
        await client.post(
            f"/sessions/{child.id}/mounts/upload",
            files={"file": ("child.txt", b"remove me", "text/plain")},
        )
    ).json()
    child_path = Path(child_mount["path"])

    assert (await client.post(f"/sessions/{sid}/reset")).status_code == 204
    assert path.read_bytes() == b"keep me"
    assert not child_path.exists()
    assert await SessionRepository().load(child.id, "local") is None


async def test_failed_mount_registration_compensates_written_attachment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "session"
    attachment_root = tmp_path / "attachments"
    service = SessionService(
        attachment_store=SessionAttachmentStore(attachment_root),
    )
    record = SessionRecord(id="session_test", user_id="local", workspace_root=str(root))

    async def fail_create(*args, **kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(service._mounts, "create", fail_create)

    with pytest.raises(RuntimeError, match="database unavailable"):
        await service.upload_mount(record, filename="notes.txt", data=b"transient")

    assert list((attachment_root / record.id).iterdir()) == []


async def test_mount_index_associates_sessions_and_excludes_system_work(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    first = (await client.post("/sessions", json={})).json()
    second = (await client.post("/sessions", json={})).json()
    await client.patch(f"/sessions/{first['id']}", json={"title": "资料会话 A"})
    await client.patch(f"/sessions/{second['id']}", json={"title": "资料会话 B"})

    shared = tmp_path / "shared.txt"
    shared.write_text("shared-data")
    folder = tmp_path / "folder"
    folder.mkdir()
    (folder / "child.txt").write_text("child")
    picked_work = tmp_path / "picked" / ".work"
    picked_work.mkdir(parents=True)

    first_shared = (
        await client.post(f"/sessions/{first['id']}/mounts", json={"path": str(shared)})
    ).json()
    second_shared = (
        await client.post(f"/sessions/{second['id']}/mounts", json={"path": str(shared)})
    ).json()
    folder_mount = (
        await client.post(f"/sessions/{second['id']}/mounts", json={"path": str(folder)})
    ).json()
    picked_work_mount = (
        await client.post(
            f"/sessions/{first['id']}/mounts",
            json={"path": str(picked_work)},
        )
    ).json()
    visible = (await client.get(f"/sessions/{first['id']}/mounts")).json()
    system_work = next(
        row
        for row in visible
        if row["path"] == str(Path(first["workspace_root"]) / ".work")
    )
    assert system_work["removable"] is False

    response = await client.get("/mounts")
    assert response.status_code == 200
    rows = response.json()
    assert {row["id"] for row in rows} == {
        first_shared["id"],
        second_shared["id"],
        folder_mount["id"],
        picked_work_mount["id"],
    }
    assert [row["created_at"] for row in rows] == sorted(
        (row["created_at"] for row in rows),
        reverse=True,
    )

    shared_rows = [row for row in rows if row["path"] == str(shared)]
    assert len(shared_rows) == 2
    assert {row["session_id"] for row in shared_rows} == {first["id"], second["id"]}
    assert {row["session_title"] for row in shared_rows} == {"资料会话 A", "资料会话 B"}
    assert all(row["size_bytes"] == len("shared-data") for row in shared_rows)
    assert next(row for row in rows if row["path"] == str(folder))["item_count"] is None
    assert any(row["path"] == str(picked_work) for row in rows)

    system_work_paths = {
        str((tmp_path / "sessions" / first["id"] / ".work").resolve()),
        str((tmp_path / "sessions" / second["id"] / ".work").resolve()),
    }
    assert system_work_paths.isdisjoint({row["path"] for row in rows})


async def test_mount_index_is_ownership_scoped(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    local = (await client.post("/sessions", json={})).json()
    local_file = tmp_path / "local.txt"
    local_file.write_text("local")
    await client.post(f"/sessions/{local['id']}/mounts", json={"path": str(local_file)})

    await UserRepository().ensure_seeded("other")
    foreign_root = tmp_path / "foreign-session"
    foreign_root.mkdir()
    await SessionRepository().save(
        SessionRecord(
            id="session_foreign",
            user_id="other",
            workspace_root=str(foreign_root),
            title="Foreign session",
        )
    )
    foreign_file = tmp_path / "foreign.txt"
    foreign_file.write_text("foreign")
    await SessionMountRepository().create(
        "session_foreign",
        "other",
        name=foreign_file.name,
        abs_path=str(foreign_file),
        kind="file",
    )

    rows = (await client.get("/mounts")).json()
    assert [row["path"] for row in rows] == [str(local_file)]
    assert all(row["session_id"] == local["id"] for row in rows)


async def test_folder_mounts_are_never_scanned(
    client: httpx.AsyncClient,
    tmp_path,
    monkeypatch,
) -> None:
    """Summarising a folder mount must not read the directory's contents.

    Reading a mounted directory is what trips macOS TCC: rendering the asset
    list alone raised a ``"python3.13" wants to access files in Downloads``
    prompt for anyone who had mounted ``~/Downloads``. The count that scan
    produced was only a collapsed-state placeholder — the renderer re-reads
    the real tree over ``fs.listDir`` the moment the row is expanded — so the
    scan bought nothing and cost a permission prompt plus a full walk of the
    directory on every page load.
    """
    sid = await _create_session(client)
    folder = tmp_path / "watched"
    folder.mkdir()
    (folder / "f.txt").write_text("x")

    scanned: list[str] = []
    real_scandir = os.scandir

    def recording_scandir(path=".", *args, **kwargs):
        scanned.append(str(path))
        return real_scandir(path, *args, **kwargs)

    monkeypatch.setattr(os, "scandir", recording_scandir)

    created = (
        await client.post(f"/sessions/{sid}/mounts", json={"path": str(folder)})
    ).json()
    assert created["kind"] == "folder"
    assert created["exists"] is True
    assert created["item_count"] is None

    listing = (await client.get("/mounts")).json()
    assert [row["item_count"] for row in listing if row["kind"] == "folder"] == [None]

    assert created["path"] not in scanned
