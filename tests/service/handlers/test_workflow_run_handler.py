import io
import zipfile

import httpx

from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import (
    UserInput,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)
from tests._support.sandbox import IsolatedPaths


async def test_run_lifecycle(service_client: httpx.AsyncClient, test_sandbox: IsolatedPaths) -> None:
    """Final service state:

    {
      "workflow_runs": [],
      "deleted_run": {
        "detail_status": 404,
        "managed_directory_exists": false
      },
      "published_files": [
        "result/report.md",
        "background/work/notes.txt"
      ]
    }

    Checks:
    1. A published Run appears in global list and detail projections.
    2. Text and raw file reads expose only files from the published directories.
    3. Archive export contains final results and intermediate work with portable paths.
    4. Path traversal is rejected without disclosing an outside file.
    5. Delete removes both the Run record and its managed result directory.
    """
    session_response = await service_client.post("/sessions", json={"model": "test-model"})
    assert session_response.status_code == 201
    session_id = session_response.json()["id"]
    repository = WorkflowRunRepository()
    workflow_id = "workflow-report"
    run_id = repository.new_id()
    run_root = test_sandbox.runs / workflow_id / run_id
    result_dir = run_root / "result"
    work_dir = run_root / "background" / "work"
    result_dir.mkdir(parents=True)
    work_dir.mkdir(parents=True)
    (result_dir / "report.md").write_text("# Complete report\n", encoding="utf-8")
    (work_dir / "notes.txt").write_text("Intermediate notes\n", encoding="utf-8")
    outside = test_sandbox.root / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    await repository.create_or_confirm_terminal(
        LOCAL_USER_ID,
        result_id=run_id,
        workflow_id=workflow_id,
        workflow_name="Weekly report",
        source_session_id=session_id,
        result_dir=str(run_root),
        workflow_input=UserInput(text="Prepare the report"),
        status=WorkflowRunStatus.COMPLETED,
        validation_status=WorkflowValidationStatus.PASSED,
    )

    # Check 1: A published Run appears in global list and detail projections.
    response = await service_client.get("/workflow-runs")
    assert response.status_code == 200
    runs = response.json()
    assert len(runs) == 1
    assert runs[0]["id"] == run_id
    assert runs[0]["workflow_id"] == workflow_id
    assert runs[0]["workflow_name"] == "Weekly report"
    assert runs[0]["source_session_id"] == session_id
    assert runs[0]["workflow_input"]["text"] == "Prepare the report"
    assert runs[0]["status"] == "completed"
    assert runs[0]["validation_status"] == "passed"

    response = await service_client.get(f"/workflow-runs/{run_id}")
    assert response.status_code == 200
    detail = response.json()
    assert detail["run_dir"] == str(run_root)
    assert [file["path"] for file in detail["files"]] == [
        "result/report.md",
        "background/work/notes.txt",
    ]

    # Check 2: Text and raw file reads expose files from the published directories.
    response = await service_client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "result/report.md"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "path": "result/report.md",
        "name": "report.md",
        "size": len(b"# Complete report\n"),
        "content": "# Complete report\n",
        "truncated": False,
    }

    response = await service_client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "background/work/notes.txt", "raw": True},
    )
    assert response.status_code == 200
    assert response.content == b"Intermediate notes\n"
    assert response.headers["content-disposition"] == 'attachment; filename="notes.txt"'

    # Check 3: Archive export contains results and intermediate work with portable paths.
    response = await service_client.get(f"/workflow-runs/{run_id}", params={"archive": True})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist() == ["report.md", "background/work/notes.txt"]
        assert archive.read("report.md") == b"# Complete report\n"
        assert archive.read("background/work/notes.txt") == b"Intermediate notes\n"

    # Check 4: Path traversal is rejected without disclosing an outside file.
    response = await service_client.get(
        f"/workflow-runs/{run_id}/file",
        params={"path": "../outside.txt"},
    )
    assert response.status_code == 400
    assert "private" not in response.text

    # Check 5: Delete removes both the Run record and its managed result directory.
    response = await service_client.delete(f"/workflow-runs/{run_id}")
    assert response.status_code == 204
    assert not run_root.exists()
    assert (await service_client.get("/workflow-runs")).json() == []
    assert (await service_client.get(f"/workflow-runs/{run_id}")).status_code == 404
