import io
import json
import zipfile
from datetime import datetime

import httpx


def _workflow_archive(name: str) -> bytes:
    """Build one valid portable Workflow archive for HTTP import."""
    manifest = {
        "kind": "amphi-workflow",
        "format_version": 2,
        "name": name,
        "description": "Build a deterministic report",
        "domain": "reporting",
    }
    workflow = """---
name: report-workflow
description: Build a deterministic report
---
# Produce the report
Write the requested report.
"""
    validation = """---
validation: none
---
"""
    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("task.md", "Prepare the weekly report.")
        archive.writestr("explore.md", "No external context is required.")
        archive.writestr("verify.md", "Confirm the report is complete.")
        archive.writestr("workflow/WORKFLOW.md", workflow)
        archive.writestr("workflow/VALIDATE.md", validation)
    return output.getvalue()


async def _import_workflow(service_client: httpx.AsyncClient, name: str) -> dict:
    """Import one Workflow through the public HTTP boundary."""
    response = await service_client.put(
        "/workflows",
        files={
            "file": (
                "report.amphi-workflow",
                _workflow_archive(name),
                "application/vnd.bridgic.workflow+zip",
            ),
        },
    )
    assert response.status_code == 201
    return response.json()


async def test_import(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "workflows": [
        {
          "id": "<generated wf_* id>",
          "name": "Weekly report",
          "desc": "Build a deterministic report",
          "domain": "reporting",
          "documents": ["task.md", "explore.md", "verify.md"],
          "program": ["VALIDATE.md", "WORKFLOW.md"]
        }
      ],
      "export": {
        "format_version": 2,
        "portable": true
      }
    }

    Checks:
    1. Importing a valid archive creates one library Workflow.
    2. List and detail reads expose its metadata, documents, and executable source.
    3. Export returns a portable source-only Workflow archive.
    """
    # Check 1: Importing a valid archive creates one library Workflow.
    created = await _import_workflow(service_client, "Weekly report")
    workflow_id = created["id"]
    workflow_dir = created["workflow_dir"]
    assert workflow_id.startswith("wf_")
    assert created == {
        "id": workflow_id,
        "name": "Weekly report",
        "workflow_dir": workflow_dir,
        "desc": "Build a deterministic report",
        "source_session_id": None,
    }

    # Check 2: List and detail reads expose the imported Workflow contents.
    response = await service_client.get("/workflows")
    assert response.status_code == 200
    assert response.json() == [created]

    response = await service_client.get(f"/workflows/{workflow_id}")
    assert response.status_code == 200
    detail = response.json()
    assert detail["id"] == workflow_id
    assert detail["name"] == "Weekly report"
    assert detail["info"] == {
        "desc": "Build a deterministic report",
        "domain": "reporting",
        "workflow_dir": workflow_dir,
        "created_at": detail["info"]["created_at"],
        "owner": "local",
        "source_session_id": None,
    }
    assert datetime.fromisoformat(detail["info"]["created_at"])
    assert detail["fields"]["task"] == {
        "value": "Prepare the weekly report.",
        "editable": True,
    }
    assert detail["fields"]["explore"] == {
        "value": "No external context is required.",
        "editable": False,
    }
    assert detail["fields"]["verify"] == {
        "value": "Confirm the report is complete.",
        "editable": False,
    }
    program = detail["fields"]["program"]
    assert [file["path"] for file in program["files"]] == ["VALIDATE.md", "WORKFLOW.md"]
    assert all(file["language"] == "markdown" for file in program["files"])
    assert program["readme"] is None

    # Check 3: Export returns a portable source-only Workflow archive.
    response = await service_client.get(f"/workflows/{workflow_id}", params={"archive": True})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.bridgic.workflow+zip"
    assert response.headers["content-disposition"] == (
        f'attachment; filename="{workflow_id}.amphi-workflow"'
    )
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert set(archive.namelist()) == {
            "manifest.json",
            "task.md",
            "explore.md",
            "verify.md",
            "workflow/VALIDATE.md",
            "workflow/WORKFLOW.md",
        }
        exported_manifest = json.loads(archive.read("manifest.json"))
        assert exported_manifest == {
            "kind": "amphi-workflow",
            "format_version": 2,
            "name": "Weekly report",
            "description": "Build a deterministic report",
            "domain": "reporting",
        }


async def test_rename_delete(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "workflows": [
        {
          "id": "<second wf_* id>",
          "name": "Existing workflow"
        }
      ],
      "deleted_workflow": "not found"
    }

    Checks:
    1. Rename trims the submitted name and preserves Workflow identity.
    2. A duplicate name is rejected without changing either Workflow.
    3. Delete removes the selected Workflow from item and library reads.
    4. Reading or deleting the removed Workflow reports not found.
    """
    first = await _import_workflow(service_client, "Original workflow")
    second = await _import_workflow(service_client, "Existing workflow")

    # Check 1: Rename trims the user-visible name and preserves Workflow identity.
    response = await service_client.patch(
        f"/workflows/{first['id']}",
        json={"name": "  Renamed workflow  "},
    )
    assert response.status_code == 200
    assert response.json() == {**first, "name": "Renamed workflow"}

    # Check 2: A duplicate name is rejected without changing either Workflow.
    response = await service_client.patch(
        f"/workflows/{second['id']}",
        json={"name": "Renamed workflow"},
    )
    assert response.status_code == 409
    response = await service_client.get("/workflows")
    assert response.status_code == 200
    assert response.json() == [
        second,
        {**first, "name": "Renamed workflow"},
    ]

    # Check 3: Delete removes the selected Workflow from item and library reads.
    response = await service_client.delete(f"/workflows/{first['id']}")
    assert response.status_code == 204
    assert response.content == b""
    response = await service_client.get("/workflows")
    assert response.status_code == 200
    assert response.json() == [second]

    # Check 4: The removed Workflow consistently reports not found.
    response = await service_client.get(f"/workflows/{first['id']}")
    assert response.status_code == 404
    response = await service_client.delete(f"/workflows/{first['id']}")
    assert response.status_code == 404


async def test_reject_archive(service_client: httpx.AsyncClient) -> None:
    """Final service state:

    {
      "workflows": [],
      "rejected_files": ["wrong-extension.zip", "broken.amphi-workflow"]
    }

    Checks:
    1. A file without the Workflow archive suffix is rejected.
    2. Invalid archive bytes with the correct suffix are rejected.
    3. Rejected imports leave the Workflow library empty.
    """
    # Check 1: A file without the Workflow archive suffix is rejected.
    response = await service_client.put(
        "/workflows",
        files={"file": ("wrong-extension.zip", _workflow_archive("Rejected"))},
    )
    assert response.status_code == 400

    # Check 2: Invalid archive bytes with the correct suffix are rejected.
    response = await service_client.put(
        "/workflows",
        files={"file": ("broken.amphi-workflow", b"not a zip archive")},
    )
    assert response.status_code == 400

    # Check 3: Rejected imports leave the Workflow library empty.
    response = await service_client.get("/workflows")
    assert response.status_code == 200
    assert response.json() == []
