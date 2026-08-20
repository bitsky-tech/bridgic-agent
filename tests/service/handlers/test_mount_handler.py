from pathlib import Path

import httpx

from tests._support.sandbox import IsolatedPaths


async def create_session(service_client: httpx.AsyncClient) -> dict:
    response = await service_client.post("/sessions", json={"model": "test-model"})
    assert response.status_code == 201
    return response.json()


async def test_external_mount_lifecycle(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """An external file can be mounted and unmounted without deleting the real file.

    Final HTTP and filesystem state:
    {
      "mounts": [{"name": ".work", "removable": false}],
      "external.txt": {"exists": true, "content": "outside"},
      "removed_mount": {"status": 404}
    }

    Checks:
    1. Every Session starts with its visible, non-removable system work mount.
    2. Mounting an existing absolute file returns its live metadata.
    3. Unmounting removes only the API entry and preserves the external file.
    4. Repeating the unmount reports that the mount no longer exists.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    workspace = Path(created["workspace_root"])

    # Check 1: The initial mount list contains the protected system work directory.
    initial_response = await service_client.get(f"/sessions/{session_id}/mounts")
    assert initial_response.status_code == 200
    initial = initial_response.json()
    assert len(initial) == 1
    assert initial[0]["name"] == ".work"
    assert initial[0]["path"] == str(workspace / ".work")
    assert initial[0]["kind"] == "folder"
    assert initial[0]["exists"] is True
    assert initial[0]["removable"] is False

    external = test_sandbox.root / "external.txt"
    external.write_text("outside", encoding="utf-8")

    # Check 2: An existing absolute file becomes a removable Session mount.
    create_response = await service_client.post(
        f"/sessions/{session_id}/mounts",
        json={"path": str(external)},
    )
    assert create_response.status_code == 201
    mounted = create_response.json()
    assert mounted["id"].startswith("mnt_")
    assert mounted["name"] == "external.txt"
    assert mounted["path"] == str(external)
    assert mounted["kind"] == "file"
    assert mounted["size_bytes"] == len(b"outside")
    assert mounted["exists"] is True
    assert mounted["removable"] is True

    # Check 3: Unmounting removes the API entry without deleting the external target.
    delete_response = await service_client.delete(
        f"/sessions/{session_id}/mounts",
        params={"id": mounted["id"]},
    )
    assert delete_response.status_code == 204
    assert external.read_text(encoding="utf-8") == "outside"
    remaining_response = await service_client.get(f"/sessions/{session_id}/mounts")
    assert remaining_response.status_code == 200
    assert [item["id"] for item in remaining_response.json()] == [initial[0]["id"]]

    # Check 4: The removed ID is reported as missing on a repeated request.
    missing_response = await service_client.delete(
        f"/sessions/{session_id}/mounts",
        params={"id": mounted["id"]},
    )
    assert missing_response.status_code == 404
    assert missing_response.json() == {
        "detail": f"No such mount: '{mounted['id']}'."
    }


async def test_mount_boundaries(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Mount mutations reject ambiguous paths and protect the Session work directory.

    Final HTTP results:
    {
      "relative.txt": 400,
      "<absolute-missing-path>": 404,
      ".work delete": 409
    }

    Checks:
    1. A relative client path is rejected because the daemon cannot resolve it safely.
    2. An absolute path that does not exist on the daemon is reported as missing.
    3. The system work mount cannot be removed from its Session.
    """
    created = await create_session(service_client)
    session_id = created["id"]

    # Check 1: Relative paths fail before any mount is created.
    relative_response = await service_client.post(
        f"/sessions/{session_id}/mounts",
        json={"path": "relative.txt"},
    )
    assert relative_response.status_code == 400
    assert relative_response.json() == {
        "detail": "Mount path must be absolute: 'relative.txt'."
    }

    # Check 2: Missing absolute paths produce a not-found response.
    missing = test_sandbox.root / "missing.txt"
    missing_response = await service_client.post(
        f"/sessions/{session_id}/mounts",
        json={"path": str(missing)},
    )
    assert missing_response.status_code == 404
    assert missing_response.json() == {
        "detail": f"No such path on the agent host: {str(missing)!r}."
    }

    # Check 3: The system work mount remains protected from deletion.
    mounts_response = await service_client.get(f"/sessions/{session_id}/mounts")
    work_mount = mounts_response.json()[0]
    protected_response = await service_client.delete(
        f"/sessions/{session_id}/mounts",
        params={"id": work_mount["id"]},
    )
    assert protected_response.status_code == 409
    assert protected_response.json() == {
        "detail": "The Session workspace mount cannot be removed."
    }


async def test_upload_lifecycle(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Uploaded filenames are sanitized and their managed files disappear on unmount.

    Final HTTP and filesystem state:
    {
      "upload": {"name": "report.txt", "inside_attachment_root": true},
      "global_mounts": [{"name": "report.txt", "session_title": "Uploads"}],
      "after_delete": {"mount_present": false, "file_exists": false}
    }

    Checks:
    1. Upload strips directory traversal from the client filename and stores the bytes privately.
    2. The global mount list exposes the upload but excludes the system work mount.
    3. Deleting an uploaded mount removes both its API entry and managed file.
    """
    created = await create_session(service_client)
    session_id = created["id"]
    rename_response = await service_client.patch(
        f"/sessions/{session_id}",
        json={"title": "Uploads"},
    )
    assert rename_response.status_code == 200

    # Check 1: A traversal-style filename is reduced to a safe basename.
    upload_response = await service_client.post(
        f"/sessions/{session_id}/mounts/upload",
        files={"file": ("../../report.txt", b"uploaded data", "text/plain")},
    )
    assert upload_response.status_code == 201
    uploaded = upload_response.json()
    uploaded_path = Path(uploaded["path"])
    assert uploaded["name"] == "report.txt"
    assert uploaded["kind"] == "file"
    assert uploaded["size_bytes"] == len(b"uploaded data")
    assert uploaded_path.parent == test_sandbox.attachments / session_id
    assert uploaded_path.name.endswith("-report.txt")
    assert uploaded_path.read_bytes() == b"uploaded data"

    # Check 2: The global list contains the user mount, not the hidden system mount.
    global_response = await service_client.get("/mounts")
    assert global_response.status_code == 200
    global_mounts = global_response.json()
    assert len(global_mounts) == 1
    assert global_mounts[0]["id"] == uploaded["id"]
    assert global_mounts[0]["session_id"] == session_id
    assert global_mounts[0]["session_title"] == "Uploads"
    assert all(item["name"] != ".work" for item in global_mounts)

    # Check 3: Unmounting an upload also removes its application-owned file.
    delete_response = await service_client.delete(
        f"/sessions/{session_id}/mounts",
        params={"id": uploaded["id"]},
    )
    assert delete_response.status_code == 204
    assert not uploaded_path.exists()
    assert (await service_client.get("/mounts")).json() == []


async def test_mount_pagination(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Global mount pagination counts user mounts without consuming slots for system mounts.

    Final HTTP pages:
    {
      "all": ["<first-visible-mount>", "<second-visible-mount>"],
      "limit_1_offset_1": ["<second-visible-mount>"]
    }

    Checks:
    1. Two Sessions contribute two user mounts while both system mounts stay hidden.
    2. Limit and offset select the matching slice from the filtered global list.
    """
    for index in range(2):
        created = await create_session(service_client)
        session_id = created["id"]
        await service_client.patch(
            f"/sessions/{session_id}",
            json={"title": f"Session {index}"},
        )
        external = test_sandbox.root / f"external-{index}.txt"
        external.write_text(str(index), encoding="utf-8")
        mount_response = await service_client.post(
            f"/sessions/{session_id}/mounts",
            json={"path": str(external)},
        )
        assert mount_response.status_code == 201

    # Check 1: The aggregate endpoint filters both system mounts before returning data.
    full_response = await service_client.get("/mounts")
    assert full_response.status_code == 200
    full = full_response.json()
    assert len(full) == 2
    assert {item["session_title"] for item in full} == {"Session 0", "Session 1"}
    assert all(item["name"] != ".work" for item in full)

    # Check 2: Pagination slices the already filtered user-mount order.
    page_response = await service_client.get("/mounts", params={"limit": 1, "offset": 1})
    assert page_response.status_code == 200
    assert page_response.json() == full[1:2]
