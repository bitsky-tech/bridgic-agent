"""Preserve prompt bytes and dependency boundaries while reorganizing modes."""

import ast
import hashlib
import importlib
import importlib.util
import json
from pathlib import Path

import pytest

from src.amphi_agent import _prompt
from src.amphi_agent import prompts
from src.amphi_service.i18n import use_locale


# Captured before splitting the mode modules; whitespace is part of the contract.
BASELINE = json.loads((Path(__file__).parent / "fixtures" / "persona_hashes.json").read_text())
TOOL_PROFILES = {
    "empty": [],
    "basic": ["read_file", "request_human_choice"],
    "blocking": ["read_file", "run_subagent"],
    "background": ["read_file", "run_subagent", "start_subagent"],
}


@pytest.mark.parametrize("qualified_name, expected", BASELINE["templates"].items())
def test_persona_templates_preserve_original_bytes(qualified_name: str, expected: str) -> None:
    """All eleven personas retain their exact pre-refactor template text."""
    module_name, name = qualified_name.rsplit(".", 1)
    module = importlib.import_module(f"{prompts.__name__}.{module_name}")
    persona = getattr(module, name)
    assert hashlib.sha256(persona.encode()).hexdigest() == expected


@pytest.mark.parametrize("profile, expected", BASELINE["rendered"].items())
def test_rendered_personas_preserve_original_bytes(profile: str, expected: str) -> None:
    """Locale and tool-dependent rendering preserve all eighty-eight inputs."""
    locale, tool_profile = profile.split(":")
    personas = {}
    with use_locale(locale):
        for qualified_name in BASELINE["templates"]:
            module_name, name = qualified_name.rsplit(".", 1)
            module = importlib.import_module(f"{prompts.__name__}.{module_name}")
            render = _prompt.render_main_persona if module_name == "main" else _prompt.render_stage_persona
            personas[qualified_name] = render(TOOL_PROFILES[tool_profile], template=getattr(module, name))
    payload = json.dumps(personas, ensure_ascii=False, sort_keys=True)
    assert hashlib.sha256(payload.encode()).hexdigest() == expected


@pytest.mark.parametrize("mode, stage, name", [
    ("build", "clarify", "CLARIFY_PERSONA"),
    ("build", "explore", "EXPLORE_PERSONA"),
    ("build", "generate", "GENERATE_PERSONA"),
    ("build", "verify", "VERIFY_PERSONA"),
    ("presentation", "brief", "PRESENTATION_BRIEF_PERSONA"),
    ("presentation", "plan", "PRESENTATION_PLAN_PERSONA"),
    ("presentation", "compose", "PRESENTATION_COMPOSE_PERSONA"),
    ("presentation", "review", "PRESENTATION_REVIEW_PERSONA"),
    ("workflow", "execute", "WORKFLOW_PERSONA"),
])
def test_mode_exports_preserve_import_compatibility(mode: str, stage: str, name: str) -> None:
    """Existing imports resolve to the same templates as individual stage modules."""
    package = importlib.import_module(f"{prompts.__name__}.{mode}")
    module = importlib.import_module(f"{package.__name__}.{stage}")
    assert getattr(package, name) is getattr(module, name)
    if mode in {"build", "workflow"}:
        assert getattr(_prompt, name) is getattr(module, name)


def test_general_prompts_do_not_depend_on_mode_packages() -> None:
    """General prompt code remains usable without importing any business mode."""
    root = Path(prompts.__file__).parent
    mode_prefixes = tuple(
        f"{prompts.__name__}.{path.name}"
        for path in root.iterdir()
        if path.is_dir() and (path / "__init__.py").is_file()
    )
    for path in root.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                dependencies = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                origin = "." * node.level + (node.module or "")
                module = importlib.util.resolve_name(origin, prompts.__name__)
                dependencies = [module, *(f"{module}.{alias.name}" for alias in node.names)]
            else:
                continue
            for dependency in dependencies:
                assert not any(
                    dependency == mode or dependency.startswith(f"{mode}.")
                    for mode in mode_prefixes
                ), f"General prompt {path.name} imports business prompt {dependency}"
