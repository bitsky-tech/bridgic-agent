"""Package-boundary and schema-registration tests for ``amphi_store``."""

from __future__ import annotations

import ast
import importlib.util
import subprocess
import sys
from pathlib import Path

from src.amphi_store import Repository

PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = PROJECT_ROOT / "src" / "amphi_store"

EXPECTED_TABLES = {
    "memories",
    "provider_credentials",
    "schedules",
    "session_mounts",
    "session_turns",
    "session_workflows",
    "session_workflow_runs",
    "sessions",
    "skills",
    "users",
    "workflow_runs",
    "workflows",
}


def test_amphi_store_import_does_not_load_service_or_agent() -> None:
    script = """
import sys
import src.amphi_store as store

assert store.Repository
assert store.SessionRecord
assert not hasattr(store, "assets_root")
assert not hasattr(store, "LlmCache")
assert not any(
    name == "src.amphi_service" or name.startswith("src.amphi_service.")
    for name in sys.modules
)
assert not any(
    name == "src.amphi_agent" or name.startswith("src.amphi_agent.")
    for name in sys.modules
)
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_amphi_store_source_has_no_service_or_agent_imports() -> None:
    forbidden = ("src.amphi_service", "src.amphi_agent")
    violations: list[str] = []

    for path in sorted(PACKAGE_ROOT.rglob("*.py")):
        relative = path.relative_to(PROJECT_ROOT).with_suffix("")
        parts = relative.parts
        package = ".".join(parts[:-1])

        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            targets: list[str] = []
            if isinstance(node, ast.Import):
                targets.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    target = importlib.util.resolve_name(
                        "." * node.level + (node.module or ""),
                        package,
                    )
                else:
                    target = node.module or ""
                targets.append(target)

            for target in targets:
                if target.startswith(forbidden):
                    violations.append(
                        f"{path.relative_to(PROJECT_ROOT)}:{node.lineno}: {target}"
                    )

    assert violations == []


async def test_init_schema_registers_every_durable_table(temp_db_path: Path) -> None:
    Repository.connect(temp_db_path)
    try:
        await Repository.init_schema()
        assert Repository._engine is not None
        async with Repository._engine.connect() as connection:
            result = await connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
            tables = {str(row[0]) for row in result}
    finally:
        await Repository.close()

    assert EXPECTED_TABLES <= tables
