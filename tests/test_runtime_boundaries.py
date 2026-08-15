"""Static ownership boundaries for the Agent runtime package."""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = PROJECT_ROOT / "src"
AGENT_ROOT = SOURCE_ROOT / "amphi_agent"
RUNTIME_ROOT = AGENT_ROOT / "runtime"
WORKSPACE_PATH = AGENT_ROOT / "_workspace.py"
EXPECTED_RUNTIME_FILES = {
    "_environment.py",
    "_errors.py",
    "_node_env.py",
    "_probe.py",
    "_python_env.py",
    "_resources.py",
    "_shell_env.py",
    "_windows_env.py",
}


def test_runtime_surface_and_import_boundaries() -> None:
    """Keep runtime composition private to Workspace and resource discovery explicit."""
    violations: list[str] = []
    actual_files = {path.name for path in RUNTIME_ROOT.glob("*.py")}
    if actual_files != EXPECTED_RUNTIME_FILES:
        unexpected = sorted(actual_files - EXPECTED_RUNTIME_FILES)
        missing = sorted(EXPECTED_RUNTIME_FILES - actual_files)
        violations.append(f"runtime files: unexpected={unexpected}, missing={missing}")

    def imports_in(path: Path) -> list[tuple[int, str]]:
        relative = path.relative_to(PROJECT_ROOT).with_suffix("")
        package = ".".join(relative.parts[:-1])
        imports: list[tuple[int, str]] = []
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                imports.extend((node.lineno, alias.name) for alias in node.names)
                continue
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.level:
                target = importlib.util.resolve_name(
                    "." * node.level + (node.module or ""),
                    package,
                )
            else:
                target = node.module or ""
            imports.append((node.lineno, target))
            if target.removeprefix("src.") == "amphi_agent":
                imports.extend(
                    (node.lineno, f"{target}.{alias.name}")
                    for alias in node.names
                    if alias.name == "runtime"
                )
        return imports

    for path in sorted(SOURCE_ROOT.rglob("*.py")):
        if path.is_relative_to(AGENT_ROOT):
            continue
        for line, target in imports_in(path):
            normalized = target.removeprefix("src.")
            if normalized != "amphi_agent.runtime" and not normalized.startswith(
                "amphi_agent.runtime."
            ):
                continue
            if normalized != "amphi_agent.runtime._resources":
                violations.append(
                    f"{path.relative_to(PROJECT_ROOT)}:{line}: forbidden import {target}"
                )

    workspace_runtime_imports = {
        target.removeprefix("src.")
        for _line, target in imports_in(WORKSPACE_PATH)
        if target.removeprefix("src.") == "amphi_agent.runtime"
        or target.removeprefix("src.").startswith("amphi_agent.runtime.")
    }
    expected_workspace_imports = {"amphi_agent.runtime._environment"}
    if workspace_runtime_imports != expected_workspace_imports:
        violations.append(
            "src/amphi_agent/_workspace.py runtime imports: "
            f"expected={sorted(expected_workspace_imports)}, "
            f"actual={sorted(workspace_runtime_imports)}"
        )

    assert violations == [], "\n".join(violations)
