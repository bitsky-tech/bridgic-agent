"""``/workflows`` artifact CRUD, import/export, and package validation."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from src.amphi_agent import WorkflowLibrary
from src.amphi_agent._workflows import WorkflowPackage
from src.amphi_agent._workspace import Workspace
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_store import (
    Workflow,
    WorkflowRepository,
)


def _payload(**overrides) -> dict:
    body = {
        "name": "小红书内容爬虫",
        "description": "Scrape Xiaohongshu notes.",
        "domain": "browser",
        "task": "Crawl notes for a keyword.",
        "program": {
            "files": [
                {"path": "main.py", "language": "python", "content": "print('hi')"}
            ],
            "readme": "Run main.py",
        },
    }
    body.update(overrides)
    return body


async def _create(client: httpx.AsyncClient, **overrides) -> dict:
    body = _payload(**overrides)
    session_response = await client.post("/sessions", json={})
    assert session_response.status_code == 201, session_response.text
    session = session_response.json()
    workspace = Workspace(session["id"], session_root=Path(session["workspace_root"]))
    build = await workspace.prepare_build_space("create", stage="verify")
    (build.root / "task.md").write_text(body.get("task") or "Task", encoding="utf-8")
    (build.root / "explore.md").write_text(body.get("explore") or "Explore", encoding="utf-8")
    (build.root / "verify.md").write_text(body.get("verify") or "Verify", encoding="utf-8")
    (build.root / "workflow").mkdir()

    program = body.get("program") or {}
    written: set[str] = set()
    for file in program.get("files") or []:
        relative = file["path"].replace("\\", "/")
        destination = (build.root / "workflow").joinpath(*relative.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(file.get("content") or "", encoding="utf-8")
        written.add(relative)
    if WorkflowPackage.ENTRY_NAME not in written:
        ((build.root / "workflow") / WorkflowPackage.ENTRY_NAME).write_text(
            "---\nname: test-workflow\ndescription: Test Workflow.\n---\n\n"
            "# Execute\n\nProduce the requested result.\n",
            encoding="utf-8",
        )
    if WorkflowPackage.VALIDATION_NAME not in written:
        ((build.root / "workflow") / WorkflowPackage.VALIDATION_NAME).write_text(
            "---\nvalidation: none\n---\n",
            encoding="utf-8",
        )
    if program.get("readme") is not None:
        ((build.root / "workflow") / "README.md").write_text(program["readme"], encoding="utf-8")

    library = await WorkflowLibrary(LOCAL_USER_ID).load()
    saved = await library.materialize_workflow(
        build.root,
        workflow_id=build.workflow_id,
        source_session_id=session["id"],
        source_turn_id=f"test-{uuid4().hex}",
        name=body["name"],
        description=body.get("description"),
    )
    assert build.is_available
    return {
        "id": saved.workflow_id,
        "name": saved.name,
        "workflow_dir": str(saved.root),
    }


def _write_valid_build(build_dir: Path) -> None:
    (build_dir / "workflow" / "scripts" / "nested").mkdir(parents=True, exist_ok=True)
    (build_dir / "task.md").write_text("Task", encoding="utf-8")
    (build_dir / "explore.md").write_text("Explore", encoding="utf-8")
    (build_dir / "verify.md").write_text("Verify", encoding="utf-8")
    (build_dir / "workflow" / "WORKFLOW.md").write_text(
        "---\nname: x\ndescription: y\n---\n\n"
        "# 第 1 步：运行脚本\nRun `scripts/nested/run.py`.\n",
        encoding="utf-8",
    )
    (build_dir / "workflow" / "VALIDATE.md").write_text(
        "# V1：验证输出\n读取实际输出并按 task.md 的预期结果判断。\n",
        encoding="utf-8",
    )
    (build_dir / "workflow" / "scripts" / "nested" / "run.py").write_text(
        "print('ok')\n", encoding="utf-8",
    )


def _rewrite_workflow_archive(
    content: bytes,
    *,
    format_version: int | None = None,
    omitted: frozenset[str] = frozenset(),
    extras: dict[str, str] | None = None,
) -> bytes:
    """Rewrite selected archive metadata and entries for import tests."""
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(content), mode="r") as source,
        zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as target,
    ):
        for info in source.infolist():
            if info.filename in omitted:
                continue
            data = source.read(info)
            if info.filename == "manifest.json" and format_version is not None:
                manifest = json.loads(data)
                manifest["format_version"] = format_version
                data = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
            target.writestr(info.filename, data)
        for name, value in (extras or {}).items():
            target.writestr(name, value)
    return output.getvalue()


async def test_workflow_crud_lifecycle(client: httpx.AsyncClient) -> None:
    """List, inspect, and delete an Agent-created Workflow artifact."""
    assert (await client.get("/workflows")).json() == []
    assert (await client.post("/workflows", json=_payload())).status_code == 405

    created = await _create(client)
    wid = created["id"]
    assert wid.startswith("wf_")
    assert created["name"] == "小红书内容爬虫"
    workflow_dir = Path(created["workflow_dir"])
    assert workflow_dir.is_dir()
    assert (workflow_dir / "task.md").read_text(encoding="utf-8") == "Crawl notes for a keyword."
    assert (workflow_dir / "workflow" / "main.py").read_text(encoding="utf-8") == "print('hi')"
    assert (workflow_dir / "workflow" / "README.md").read_text(encoding="utf-8") == "Run main.py"
    assert "latest_version" not in Workflow.__table__.columns

    assert [path.name for path in workflow_dir.parent.iterdir()] == [workflow_dir.name]

    rows = (await client.get("/workflows")).json()
    assert [r["id"] for r in rows] == [wid]

    detail = (await client.get(f"/workflows/{wid}")).json()
    assert detail["info"]["workflow_dir"] == str(workflow_dir)
    assert detail["fields"]["task"]["value"] == "Crawl notes for a keyword."
    assert "main.py" in {
        file["path"] for file in detail["fields"]["program"]["files"]
    }
    assert detail["fields"]["program"]["readme"] == "Run main.py"

    assert (await client.post(f"/workflows/{wid}/run", json={})).status_code == 404
    assert (await client.get(f"/workflows/{wid}/runs")).status_code == 404

    assert (await client.get("/workflows/wf_nope")).status_code == 404
    assert (await client.delete("/workflows/wf_nope")).status_code == 404
    assert (await client.delete(f"/workflows/{wid}")).status_code == 204
    assert await WorkflowRepository().get(LOCAL_USER_ID, wid) is None
    assert not workflow_dir.exists()
    assert (await client.get(f"/workflows/{wid}")).status_code == 404

    assert list(workflow_dir.parent.iterdir()) == []


async def test_workflow_rename_updates_only_current_definition_name(client: httpx.AsyncClient) -> None:
    """Rename the current Workflow without changing its id, package, or name uniqueness."""
    first = await _create(client, name="旧名称")
    second = await _create(client, name="已占用名称")
    workflow_id = first["id"]
    workflow_dir = first["workflow_dir"]

    renamed = await client.patch(
        f"/workflows/{workflow_id}",
        json={"name": "  新名称  "},
    )

    assert renamed.status_code == 200, renamed.text
    renamed_body = renamed.json()
    assert renamed_body["id"] == workflow_id
    assert renamed_body["name"] == "新名称"
    assert renamed_body["workflow_dir"] == workflow_dir
    assert renamed_body["desc"] == "Scrape Xiaohongshu notes."
    assert (await client.get(f"/workflows/{workflow_id}")).json()["name"] == "新名称"
    assert next(
        row for row in (await client.get("/workflows")).json() if row["id"] == workflow_id
    )["name"] == "新名称"

    exported = await client.get(f"/workflows/{workflow_id}?archive=true")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert json.loads(archive.read("manifest.json"))["name"] == "新名称"

    conflict = await client.patch(
        f"/workflows/{workflow_id}",
        json={"name": second["name"]},
    )
    assert conflict.status_code == 409
    assert (await client.get(f"/workflows/{workflow_id}")).json()["name"] == "新名称"

    assert (
        await client.patch(f"/workflows/{workflow_id}", json={"name": "   "})
    ).status_code == 422
    assert (
        await client.patch(f"/workflows/{workflow_id}", json={"name": "x" * 201})
    ).status_code == 422
    assert (
        await client.patch("/workflows/wf_missing", json={"name": "不存在"})
    ).status_code == 404


async def test_workflow_export_and_import(client: httpx.AsyncClient) -> None:
    """Round-trip a source-only Workflow package."""
    created = await _create(
        client,
        name="目录统计",
        task="统计目录内容。",
        explore="已确认实现方式。",
        verify="已通过验证。",
        program={
            "files": [
                {
                    "path": "WORKFLOW.md",
                    "language": "markdown",
                    "content": (
                        "---\nname: directory-report\ndescription: Create a directory report.\n---\n\n"
                        "# 第 1 步：生成报告\n运行 `scripts/run.py` 并保存结果。\n"
                    ),
                },
                {
                    "path": "VALIDATE.md",
                    "language": "markdown",
                    "content": "# 检查报告\n确认结果文件存在且内容完整。\n",
                },
                {
                    "path": "scripts/run.py",
                    "language": "python",
                    "content": "print('ok')\n",
                },
            ],
        },
    )

    exported = await client.get(f"/workflows/{created['id']}?archive=true")
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith("application/vnd.bridgic.workflow+zip")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = set(archive.namelist())
        assert {
            "manifest.json",
            "task.md",
            "explore.md",
            "verify.md",
            "workflow/WORKFLOW.md",
            "workflow/VALIDATE.md",
            "workflow/scripts/run.py",
        } <= names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format_version"] == 2
        assert manifest["name"] == "目录统计"
        assert "id" not in manifest
        assert "source_session_id" not in manifest
        assert not any(
            name == ".runtime" or name.startswith(".runtime/")
            for name in names
        )

    files = {
        "file": (
            "directory-report.amphi-workflow",
            exported.content,
            "application/vnd.bridgic.workflow+zip",
        ),
    }
    duplicate = await client.put("/workflows", files=files)
    assert duplicate.status_code == 409, duplicate.text

    assert (await client.delete(f"/workflows/{created['id']}")).status_code == 204
    imported = await client.put("/workflows", files=files)
    assert imported.status_code == 201, imported.text
    imported_body = imported.json()
    assert imported_body["id"] != created["id"]
    assert imported_body["name"] == "目录统计"
    imported_dir = Path(imported_body["workflow_dir"])
    assert (imported_dir / "workflow" / "scripts" / "run.py").is_file()


async def test_workflow_import_error_uses_accept_language(
    client: httpx.AsyncClient,
) -> None:
    response = await client.put(
        "/workflows",
        headers={"Accept-Language": "en-US,en;q=0.9"},
        files={"file": ("not-a-workflow.zip", b"not a workflow archive")},
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "Select a .amphi-workflow Workflow file.",
    }


@pytest.mark.parametrize("include_legacy_runtime", [False, True])
async def test_workflow_import_accepts_v1_without_runtime_requirement(
    client: httpx.AsyncClient,
    include_legacy_runtime: bool,
) -> None:
    created = await _create(client, name="旧版工作流")
    exported = await client.get(f"/workflows/{created['id']}?archive=true")
    assert exported.status_code == 200, exported.text
    extras = None
    if include_legacy_runtime:
        extras = {
            ".runtime/pyproject.toml": "this is deliberately invalid TOML",
            ".runtime/uv.lock": "this is deliberately invalid lock data",
            ".runtime/.venv/pyvenv.cfg": "this legacy runtime is ignored",
        }
    legacy_archive = _rewrite_workflow_archive(
        exported.content,
        format_version=1,
        extras=extras,
    )

    assert (await client.delete(f"/workflows/{created['id']}")).status_code == 204
    imported = await client.put(
        "/workflows",
        files={"file": ("legacy.amphi-workflow", legacy_archive)},
    )

    assert imported.status_code == 201, imported.text
    imported_dir = Path(imported.json()["workflow_dir"])
    assert not (imported_dir / ".runtime").exists()
    assert all(
        (imported_dir / relative).is_file()
        for relative in (
            "task.md",
            "explore.md",
            "verify.md",
            "workflow/WORKFLOW.md",
            "workflow/VALIDATE.md",
        )
    )


async def test_workflow_import_rejects_unknown_archive_version(
    client: httpx.AsyncClient,
) -> None:
    created = await _create(client, name="未知版本工作流")
    exported = await client.get(f"/workflows/{created['id']}?archive=true")
    assert exported.status_code == 200, exported.text
    archive = _rewrite_workflow_archive(exported.content, format_version=3)

    imported = await client.put(
        "/workflows",
        files={"file": ("future.amphi-workflow", archive)},
    )

    assert imported.status_code == 400
    assert "format is not supported" in imported.json()["detail"]


@pytest.mark.parametrize(
    "missing",
    [
        "task.md",
        "explore.md",
        "verify.md",
        "workflow/WORKFLOW.md",
        "workflow/VALIDATE.md",
    ],
)
async def test_workflow_import_requires_current_package_structure(
    client: httpx.AsyncClient,
    missing: str,
) -> None:
    created = await _create(client, name="缺失结构工作流")
    exported = await client.get(f"/workflows/{created['id']}?archive=true")
    assert exported.status_code == 200, exported.text
    archive = _rewrite_workflow_archive(
        exported.content,
        omitted=frozenset({missing}),
    )

    imported = await client.put(
        "/workflows",
        files={"file": ("incomplete.amphi-workflow", archive)},
    )

    assert imported.status_code == 400
    assert missing.rsplit("/", maxsplit=1)[-1] in imported.json()["detail"]


async def test_session_workflow_associations_are_listed_per_session(client: httpx.AsyncClient) -> None:
    first_session = (await client.post("/sessions", json={})).json()
    second_session = (await client.post("/sessions", json={})).json()
    workflow = await _create(client)

    assert await WorkflowRepository().associate(
        LOCAL_USER_ID, first_session["id"], workflow["id"],
    )
    first = (await client.get(f"/workflows?session_id={first_session['id']}")).json()
    second = (await client.get(f"/workflows?session_id={second_session['id']}")).json()

    assert [row["id"] for row in first] == [workflow["id"]]
    assert second == []


def test_workflow_package_rejects_file_and_directory_links(
    tmp_path: Path,
) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    workflow_dir = build_dir / "workflow"

    package = WorkflowPackage(build_dir)
    assert package.validation_reason() is None

    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    leak = workflow_dir / "leak.txt"
    leak.symlink_to(outside)
    assert "symbolic link" in package.validation_reason()
    leak.unlink()

    outside_dir = tmp_path / "outside-dir"
    outside_dir.mkdir()
    linked_dir = workflow_dir / "linked-dir"
    linked_dir.symlink_to(outside_dir, target_is_directory=True)
    assert "symbolic link" in package.validation_reason()


@pytest.mark.parametrize("directory_name", [".venv", "node_modules"])
def test_workflow_package_rejects_local_dependency_environments(
    tmp_path: Path,
    directory_name: str,
) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    dependency_dir = build_dir / "workflow" / "scripts" / directory_name
    dependency_dir.mkdir()
    (dependency_dir / "package.txt").write_text("captured", encoding="utf-8")

    reason = WorkflowPackage(build_dir).validation_reason()

    assert reason and directory_name in reason
    assert "app-level shared runtime bases" in reason


def test_workflow_package_rejects_generic_execution_step_heading(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    entry_path = build_dir / "workflow" / "WORKFLOW.md"
    entry_path.write_text(
        "---\nname: x\ndescription: y\n---\n\n"
        "# Section 1\nRun `scripts/nested/run.py`.\n",
        encoding="utf-8",
    )

    reason = WorkflowPackage(build_dir).validation_reason()

    assert reason and "is generic" in reason


def test_workflow_step_parser_preserves_order_and_nested_sections(tmp_path: Path) -> None:
    package = WorkflowPackage(tmp_path)
    package.source_root.mkdir()
    package.entry_path.write_text(
        "---\nname: example\ndescription: Example workflow\n---\n\n"
        "# 获取输入\n询问用户目标目录。\n\n"
        "## 异常处理\n目录不存在时停止。\n\n"
        "# 生成报告\n运行统计脚本并返回报告。\n",
        encoding="utf-8",
    )
    steps = package.execution_steps

    assert [(step.index, step.title, step.instruction) for step in steps] == [
        (1, "获取输入", "询问用户目标目录。\n\n## 异常处理\n目录不存在时停止。"),
        (2, "生成报告", "运行统计脚本并返回报告。"),
    ]


def test_workflow_package_rejects_empty_or_fenced_execution_sections(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    entry_path = build_dir / "workflow" / "WORKFLOW.md"
    frontmatter = "---\nname: x\ndescription: y\n---\n\n"

    entry_path.write_text(
        frontmatter + "# 获取输入\n询问用户目标目录。\n\n# 返回结果\n",
        encoding="utf-8",
    )
    reason = WorkflowPackage(build_dir).validation_reason()
    assert reason and "execution step `# 返回结果` has no instructions" in reason

    entry_path.write_text(
        frontmatter + "```markdown\n# 这不是执行步骤\n仅为示例。\n```\n",
        encoding="utf-8",
    )
    reason = WorkflowPackage(build_dir).validation_reason()
    assert reason and "has no level-one execution-step heading" in reason


def test_workflow_package_requires_structured_validation_document(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    workflow_dir = build_dir / "workflow"
    validation_path = workflow_dir / "VALIDATE.md"

    validation_path.unlink()
    package = WorkflowPackage(build_dir)
    reason = package.validation_reason()
    assert reason and "VALIDATE.md is missing" in reason

    validation_path.write_text("# Section 1\nInspect the output.\n", encoding="utf-8")
    reason = package.validation_reason()
    assert reason and "VALIDATE.md heading" in reason and "is generic" in reason


def test_workflow_package_accepts_exact_execution_only_marker(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    validation_path = build_dir / "workflow" / "VALIDATE.md"
    validation_path.write_text("---\nvalidation: none\n---\n", encoding="utf-8")
    package = WorkflowPackage(build_dir)

    assert package.validation_reason() is None
    assert package.validation_disabled is True
    assert package.validation_steps == ()

    validation_path.write_text(
        "---\nvalidation: none\n---\n\n# Unexpected check\nInspect something else.\n",
        encoding="utf-8",
    )
    assert package.validation_disabled is False
    assert package.validation_reason() is not None


def test_workflow_package_closes_script_references_across_both_documents(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    workflow_dir = build_dir / "workflow"
    validation_path = workflow_dir / "VALIDATE.md"
    validation_script = workflow_dir / "scripts" / "validate.py"

    validation_script.write_text("print('PASS')\n", encoding="utf-8")
    validation_path.write_text(
        "# V1: Validate the output\nRun `scripts/validate.py`.\n",
        encoding="utf-8",
    )
    package = WorkflowPackage(build_dir)
    assert package.validation_reason() is None

    validation_path.write_text(
        "# V1: Validate the output\nInspect the output directly.\n",
        encoding="utf-8",
    )
    reason = package.validation_reason()
    assert reason and "scripts/validate.py" in reason and "WORKFLOW.md or VALIDATE.md" in reason


def test_workflow_package_reports_all_invalid_script_reference_lines(tmp_path: Path) -> None:
    build_dir = tmp_path / "build"
    _write_valid_build(build_dir)
    workflow_dir = build_dir / "workflow"
    entry_path = workflow_dir / "WORKFLOW.md"
    entry_path.write_text(
        "---\nname: x\ndescription: y\n---\n\n"
        "# Inspect the temporary path\nCheck `.build/workflow/scripts/nested/run.py`.\n\n"
        "# Run the workflow script\nRun `workflow/scripts/nested/run.py`.\n",
        encoding="utf-8",
    )

    reason = WorkflowPackage(build_dir).validation_reason()

    assert reason is not None
    assert reason.startswith("workflow/WORKFLOW.md contains 2 invalid script references:")
    assert "workflow/WORKFLOW.md line 7" in reason
    assert "replace it with `scripts/nested/run.py`" in reason
    assert "workflow/WORKFLOW.md line 10" in reason
    assert "Do not move or copy the on-disk script" in reason

    entry_path.write_text(
        "---\nname: x\ndescription: y\n---\n\n"
        "# Run the workflow script\nRun `scripts/nested/run.py`.\n",
        encoding="utf-8",
    )
    assert WorkflowPackage(build_dir).validation_reason() is None
