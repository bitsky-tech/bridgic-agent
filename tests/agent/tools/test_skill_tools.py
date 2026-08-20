import json
from pathlib import Path

from src.amphi_agent.tools._skills import (
    import_skills,
    list_skills,
    manage_skills,
    set_skill_enabled,
    uninstall_skill,
    view_skill,
)
from tests.agent.tools._harness import ToolHarness


async def test_skill_lifecycle(tool_harness: ToolHarness) -> None:
    """Final Skill lifecycle:

    {
      "sample-skill": {
        "imported": true,
        "disabled_then_enabled": true,
        "instructions_and_reference": "readable",
        "uninstalled": true
      }
    }

    Checks:
    1. Loading management tools changes the current Turn tool state.
    2. A local Skill package is imported into the isolated installed catalogue.
    3. Enablement changes control whether the Skill appears in the enabled projection.
    4. The selected Skill exposes its main instructions and one linked reference file.
    5. Uninstall removes the imported Skill from the complete installed projection.
    """
    incoming = tool_harness.paths.root / "incoming" / "sample-skill"
    references = incoming / "references"
    references.mkdir(parents=True)
    (incoming / "SKILL.md").write_text(
        "---\nname: sample-skill\ndescription: Produce sample reports\n---\n"
        "# Sample Skill\n\nFollow the reporting procedure.\n",
        encoding="utf-8",
    )
    (references / "format.md").write_text("# Format\n\nUse Markdown.\n", encoding="utf-8")

    # Check 1: Loading management tools changes the current Turn tool state.
    assert tool_harness.ota_context.skills_tool_loaded is False
    assert "Skill management tools are loaded" in await manage_skills()
    assert tool_harness.ota_context.skills_tool_loaded is True

    # Check 2: A local Skill package is imported into the isolated installed catalogue.
    imported = json.loads(await import_skills(str(incoming.parent), skill_name="sample-skill"))
    assert imported["success"] is True
    assert (imported["added"], imported["overwritten"]) == (1, 0)
    detail = imported["imported_skills"][0]
    assert detail["name"] == "sample-skill"
    skill_dir = detail["skill_dir"]

    # Check 3: Enablement changes control whether the Skill appears in the enabled projection.
    disabled = json.loads(await set_skill_enabled("sample-skill", False))
    assert disabled["skill"]["enabled"] is False
    enabled_names = {item["name"] for item in json.loads(await list_skills())["skills"]}
    assert "sample-skill" not in enabled_names
    assert json.loads(await set_skill_enabled("sample-skill", True))["skill"]["enabled"] is True

    # Check 4: The selected Skill exposes its main instructions and one linked reference file.
    tool_harness.ota_context.selected_skill_dirs.append(skill_dir)
    main = json.loads(await view_skill(skill_dir))
    reference = json.loads(await view_skill(skill_dir, "references/format.md"))
    assert main["success"] is True
    assert main["name"] == "sample-skill"
    assert main["linked_files"] == {
        "references": [str(Path("references") / "format.md")],
    }
    assert reference["content"] == "# Format\n\nUse Markdown.\n"

    # Check 5: Uninstall removes the imported Skill from the complete installed projection.
    removed = json.loads(await uninstall_skill("sample-skill"))
    assert removed["success"] is True
    all_names = {item["name"] for item in json.loads(await list_skills("all"))["skills"]}
    assert "sample-skill" not in all_names


async def test_skill_boundaries(tool_harness: ToolHarness) -> None:
    """Final Skill boundary results:

    {
      "unselected_directory": "rejected",
      "path_escape": "rejected",
      "relative_import": "rejected",
      "invalid_filter": "rejected"
    }

    Checks:
    1. A directory not selected by the current Think cannot be read as a Skill.
    2. A selected Skill still cannot read a file outside its own directory.
    3. Imports require an absolute local path and a real boolean overwrite decision.
    4. Installed-Skill listing rejects projections other than enabled or all.
    """
    skill_dir = tool_harness.paths.root / "untrusted-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: untrusted-skill\ndescription: Boundary fixture\n---\n# Instructions\n",
        encoding="utf-8",
    )
    outside = tool_harness.paths.root / "secret.txt"
    outside.write_text("secret", encoding="utf-8")

    # Check 1: A directory not selected by the current Think cannot be read as a Skill.
    unselected = json.loads(await view_skill(str(skill_dir)))
    assert unselected["success"] is False
    assert "neither selected" in unselected["error"]

    # Check 2: A selected Skill still cannot read a file outside its own directory.
    tool_harness.ota_context.selected_skill_dirs.append(str(skill_dir))
    escaped = json.loads(await view_skill(str(skill_dir), "../secret.txt"))
    assert escaped["success"] is False
    assert "escapes the skill directory" in escaped["error"]

    # Check 3: Imports require an absolute local path and a real boolean overwrite decision.
    relative = json.loads(await import_skills("relative/path"))
    invalid_bool = json.loads(await import_skills(str(skill_dir), allow_overwite="maybe"))
    assert relative["success"] is False
    assert "must be absolute" in relative["error"]
    assert invalid_bool["success"] is False
    assert "boolean value" in invalid_bool["error"]

    # Check 4: Installed-Skill listing rejects projections other than enabled or all.
    invalid_filter = json.loads(await list_skills("disabled"))
    assert invalid_filter == {"success": False, "error": "filter must be either 'enabled' or 'all'."}


async def test_skill_conflicts(tool_harness: ToolHarness) -> None:
    """Final imported Skill conflict:

    {
      "installed": "version one",
      "default_reimport": "blocked without mutation",
      "explicit_overwrite": "version two installed"
    }

    Checks:
    1. The first import installs the selected local Skill package.
    2. Reimporting the same Skill is blocked by default and preserves the installed package.
    3. Explicit overwrite replaces the installed package and reports the replacement.
    """
    incoming = tool_harness.paths.root / "incoming" / "conflict-skill"

    def write_version(marker: str) -> None:
        incoming.mkdir(parents=True, exist_ok=True)
        (incoming / "SKILL.md").write_text(
            "---\nname: conflict-skill\ndescription: Conflict fixture\n---\n"
            f"# Instructions\n\n{marker}\n",
            encoding="utf-8",
        )

    # Check 1: The first import installs the selected local Skill package.
    write_version("Version one")
    first = json.loads(await import_skills(str(incoming)))
    assert first["success"] is True
    installed = first["imported_skills"][0]["skill_dir"]
    installed_file = tool_harness.paths.skills / "conflict-skill" / "SKILL.md"
    assert "Version one" in installed_file.read_text(encoding="utf-8")

    # Check 2: Default reimport blocks the conflict and preserves the installed package.
    write_version("Version two")
    blocked = json.loads(await import_skills(str(incoming)))
    assert blocked["success"] is False
    assert blocked["status"] == "conflicts_detected"
    assert blocked["conflicts"] == 1
    assert "Version one" in installed_file.read_text(encoding="utf-8")

    # Check 3: Explicit overwrite replaces the package and reports the replacement.
    overwritten = json.loads(await import_skills(str(incoming), allow_overwite=True))
    assert overwritten["success"] is True
    assert (overwritten["added"], overwritten["overwritten"]) == (0, 1)
    assert overwritten["imported_skills"][0]["skill_dir"] == installed
    assert "Version two" in installed_file.read_text(encoding="utf-8")
