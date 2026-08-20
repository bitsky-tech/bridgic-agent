from __future__ import annotations

from pathlib import Path

import httpx

from tests._support.sandbox import IsolatedPaths
from tests.service.flows._scripted_llm import FLOW_MODEL, ScriptedLlm


async def test_duplicate_reset(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm) -> None:
    """Final Session state:

    {
      "source": {"turns": 1, "file": "durable note", "status": "completed"},
      "copy": {"turns": 0, "file": "durable note", "status": "finish", "tokens": 0}
    }

    Checks:
    1. A real Agent Tool creates a completed transcript and Workspace artifact.
    2. Duplicate creates a new Session with copied history and filesystem but fresh identities.
    3. Reset clears only the copied conversation while preserving its Session and Workspace.
    4. The original Session remains unchanged after operations on the copy.
    """
    scripted_llm.enqueue_tool(
        "write_file",
        {"file_path": "note.txt", "content": "durable note"},
        call_id="call_write",
    )
    scripted_llm.enqueue_text("The note is saved.", input_tokens=8, output_tokens=4)
    created = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert created.status_code == 201
    source = created.json()
    source_id = source["id"]

    # Check 1: The source state is produced through the actual Agent path.
    run = await flow_client.post(
        f"/api/agent/sessions/{source_id}/run",
        json={"input": "Save a durable note."},
    )
    assert run.status_code == 200
    assert run.json()["answer"] == "The note is saved."
    source_messages = (await flow_client.get(f"/sessions/{source_id}/messages")).json()["messages"]
    source_file = await flow_client.get(
        f"/sessions/{source_id}/files",
        params={"path": ".work/note.txt"},
    )
    assert source_file.json() == {"path": ".work/note.txt", "content": "durable note"}

    # Check 2: The copy has fresh Session and Turn identities with equivalent durable content.
    response = await flow_client.post(f"/sessions/{source_id}/duplicate")
    assert response.status_code == 201
    duplicate = response.json()
    duplicate_id = duplicate["id"]
    assert duplicate_id != source_id
    assert duplicate["workspace_root"] != source["workspace_root"]
    copied_messages = (await flow_client.get(f"/sessions/{duplicate_id}/messages")).json()["messages"]
    assert [(message["role"], message["text"]) for message in copied_messages] == [
        (message["role"], message["text"]) for message in source_messages
    ]
    assert copied_messages[-1]["turnId"] != source_messages[-1]["turnId"]
    copied_file = await flow_client.get(
        f"/sessions/{duplicate_id}/files",
        params={"path": ".work/note.txt"},
    )
    assert copied_file.json() == {"path": ".work/note.txt", "content": "durable note"}

    # Check 3: Reset leaves a clean copy shell and does not delete its copied file.
    response = await flow_client.post(f"/sessions/{duplicate_id}/reset")
    assert response.status_code == 204
    assert (await flow_client.get(f"/sessions/{duplicate_id}/messages")).json()["messages"] == []
    assert (await flow_client.get(f"/sessions/{duplicate_id}/tokens")).json() == {"tokens": 0}
    detail = (await flow_client.get(f"/sessions/{duplicate_id}")).json()
    assert detail["status"] == "finish"
    assert (await flow_client.get(
        f"/sessions/{duplicate_id}/files",
        params={"path": ".work/note.txt"},
    )).json()["content"] == "durable note"

    # Check 4: Copy reset cannot mutate the source transcript, usage, or file.
    reloaded = (await flow_client.get(f"/sessions/{source_id}/messages")).json()["messages"]
    assert [(message["role"], message["text"]) for message in reloaded] == [
        (message["role"], message["text"]) for message in source_messages
    ]
    assert (await flow_client.get(f"/sessions/{source_id}/tokens")).json() == {"tokens": 12}
    assert (await flow_client.get(
        f"/sessions/{source_id}/files",
        params={"path": ".work/note.txt"},
    )).json()["content"] == "durable note"


async def test_duplicate_owns_an_independent_uploaded_attachment(flow_client: httpx.AsyncClient, scripted_llm: ScriptedLlm, test_sandbox: IsolatedPaths) -> None:
    """Duplicating and deleting Sessions preserves attachment ownership boundaries.

    Checks:
    1. Duplicate copies a managed upload into its own attachment directory.
    2. Deleting the source removes only the source upload.
    3. Deleting the duplicate removes the remaining copied upload.
    """
    created = await flow_client.post("/sessions", json={"model": FLOW_MODEL})
    assert created.status_code == 201
    source_id = created.json()["id"]
    upload = await flow_client.post(
        f"/sessions/{source_id}/mounts/upload",
        files={"file": ("report.txt", b"independent attachment", "text/plain")},
    )
    assert upload.status_code == 201
    source_path = Path(upload.json()["path"])

    scripted_llm.enqueue_text("The attachment is ready.")
    run = await flow_client.post(
        f"/api/agent/sessions/{source_id}/run",
        json={"input": "Finish this Session."},
    )
    assert run.status_code == 200

    duplicate = await flow_client.post(f"/sessions/{source_id}/duplicate")
    assert duplicate.status_code == 201
    duplicate_id = duplicate.json()["id"]
    mounts = (await flow_client.get(f"/sessions/{duplicate_id}/mounts")).json()
    copied_mount = next(mount for mount in mounts if mount["name"] == "report.txt")
    copied_path = Path(copied_mount["path"])

    # Check 1: The copy has the same bytes under a distinct Session-owned path.
    assert source_path.parent == test_sandbox.attachments / source_id
    assert copied_path.parent == test_sandbox.attachments / duplicate_id
    assert copied_path != source_path
    assert copied_path.read_bytes() == source_path.read_bytes() == b"independent attachment"

    # Check 2: Removing the source cannot remove the duplicate's file.
    delete_source = await flow_client.delete(f"/sessions/{source_id}")
    assert delete_source.status_code == 204
    assert not source_path.exists()
    assert copied_path.read_bytes() == b"independent attachment"

    # Check 3: The final owner removes its attachment with the Session.
    delete_duplicate = await flow_client.delete(f"/sessions/{duplicate_id}")
    assert delete_duplicate.status_code == 204
    assert not copied_path.exists()
