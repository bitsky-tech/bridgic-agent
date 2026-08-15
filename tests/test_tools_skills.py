"""Unit coverage for the catalogue-backed local-skill view tool.

The tool resolves a skill by *name* against the user's installed-skill store
(``SkillRepository``), reads the ``skill_dir`` off the matched row, and only
then touches the filesystem to read ``SKILL.md`` / supporting files. The
fixtures below therefore (1) connect a fresh per-test DB and seed the ``local``
user the tool resolves via ``get_current_user()``, and (2) install a skill by
writing its directory on disk *and* registering a store row that points at it.
"""

from __future__ import annotations

import json
import os
import time
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Awaitable, Callable, Optional

import pytest
from bridgic.amphibious.builtin_tools import current_agent
from sqlalchemy.exc import IntegrityError

from src.amphi_agent._tools import TOOL_LIBRARY
from src.amphi_agent._skills import SkillLibrary
from src.amphi_agent.tools import _skills as skill_tools
from src.amphi_agent.tools._skills import (
    _coerce_optional_bool,
    import_skills,
    list_skills,
    set_skill_enabled,
    uninstall_skill,
    view_skill,
    view_skill_tool,
)
from src.amphi_service.auth import LOCAL_USER_ID
from src.amphi_service.handler import _skills_import_handler as skill_import_handler
from src.amphi_store import Repository, SkillRepository, UserRepository

# Sentinel so ``make_skill(fm_name=...)`` can tell "default to the row name"
# apart from an explicit ``None`` (write a SKILL.md with no frontmatter).
_DEFAULT = object()

MakeSkill = Callable[..., Awaitable[Path]]

_MANAGEMENT_RESPONSE_FIELDS = {"success", "filter", "count", "skills"}
_MANAGEMENT_SKILL_FIELDS = {
    "skill_id", "name", "description", "skill_dir", "group", "source",
    "source_uri", "enabled", "updated_at",
}
_IMPORT_SUMMARY_FIELDS = {
    "success", "status", "total", "succeeded", "failed", "added",
    "overwritten", "imported_skills", "failed_skills",
}
_IMPORT_ROW_FIELDS = {
    "skill_id", "name", "description", "skill_dir", "group", "source",
    "source_uri", "updated_at", "action",
}
_IMPORT_CHECK_FIELDS = {
    "success", "status", "message", "total", "conflicts", "results",
}
_IMPORT_CHECK_RESULT_FIELDS = {"conflict", "incoming", "existing"}
_IMPORT_INCOMING_FIELDS = {
    "name", "description", "source", "source_uri", "local_path", "updated_at",
}
BUILTIN_NAMES = set(SkillLibrary.builtin_names())
_IMPORT_EXISTING_FIELDS = {
    "skill_id", "name", "description", "skill_dir", "group", "source",
    "source_uri", "updated_at",
}


def _write_skill_dir(
    root: Path,
    rel_dir: str,
    *,
    name: str = "demo",
    description: str = "A demo skill",
) -> Path:
    """Write a source-only skill directory for import-tool tests."""
    skill_dir = root / rel_dir
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n# {name}\n",
        encoding="utf-8",
    )
    return skill_dir


@pytest.fixture
async def skills_db(temp_db_path: Path):
    """Connect a fresh per-test DB, create the schema, and seed the local user.

    ``temp_db_path`` has pointed ``$BRIDGIC_AGENT_STATE_DB`` at a tmp file; we
    open the engine, create the tables, and seed the ``local`` user that the
    tool resolves via ``get_current_user()``. The engine is disposed on teardown.
    """
    Repository.connect(temp_db_path)
    await Repository.init_schema()
    await UserRepository().ensure_seeded(LOCAL_USER_ID)
    yield
    await Repository.close()


@pytest.fixture
async def make_skill(tmp_path: Path, skills_db: None) -> MakeSkill:
    """Return an async factory that installs a skill and returns its directory.

    Each call writes ``<tmp>/skills/<rel_dir>/SKILL.md`` (+ any ``files``) on
    disk and registers a store row whose ``skill_dir`` points at it. ``name`` is
    the catalogue lookup key (the row's ``name``); ``fm_name`` is the SKILL.md
    frontmatter ``name`` (defaults to ``name``; pass ``None`` for a SKILL.md
    with no frontmatter at all).
    """
    _ = skills_db
    repo = SkillRepository()
    base = tmp_path / "skills"

    async def _make(
        rel_dir: str,
        *,
        name: str = "demo",
        description: str = "A demo skill",
        body: str = "# Demo\n\nbody",
        files: Optional[dict[str, str]] = None,
        fm_name: object = _DEFAULT,
    ) -> Path:
        skill_dir = base / rel_dir
        skill_dir.mkdir(parents=True, exist_ok=True)
        front = name if fm_name is _DEFAULT else fm_name
        head = "" if front is None else f"---\nname: {front}\ndescription: {description}\n---\n"
        (skill_dir / "SKILL.md").write_text(head + body, encoding="utf-8")
        for rel, content in (files or {}).items():
            target = skill_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        await repo.create(
            LOCAL_USER_ID, name=name, description=description,
            skill_dir=str(skill_dir), group="imported", source="local",
            source_uri=str(skill_dir),
        )
        return skill_dir

    return _make


@pytest.fixture
async def seeded_tool_skills(skills_db: None) -> list[int]:
    """Seed one enabled and one disabled skill for management-tool tests."""
    _ = skills_db
    repo = SkillRepository()
    enabled = await repo.create(
        LOCAL_USER_ID,
        name="enabled-skill",
        description="Enabled skill.",
        skill_dir="/skills/enabled-skill",
        group="imported",
        source="local",
        source_uri="/src/enabled-skill",
    )
    disabled = await repo.create(
        LOCAL_USER_ID,
        name="disabled-skill",
        description="Disabled skill.",
        skill_dir="/skills/disabled-skill",
        group="imported",
        source="local",
        source_uri="/src/disabled-skill",
    )
    await repo.set_enabled(LOCAL_USER_ID, id=disabled.id, enabled=False)
    return [enabled.id, disabled.id]


@pytest.mark.parametrize("value", ["None", "none", "NULL", " null "])
def test_coerce_optional_bool_accepts_stringified_null(value: str) -> None:
    """A stringified null means "not specified" — same as an omitted field.

    Mirrors the `tools/_schedule` fix: the model writes the *string* ``"None"``
    to mean "leave this flag alone". Here the omitted-field default is ``False``
    (do not allow overwrite), so a stringified null must land on ``False`` too —
    never on the truthy branch, which would silently permit overwriting skills.
    """
    assert _coerce_optional_bool(value, name="allow_overwite") == (False, None)


def test_coerce_optional_bool_rejects_garbage() -> None:
    coerced, error = _coerce_optional_bool("maybe", name="allow_overwite")
    assert coerced is None
    assert error is not None


def test_schema_registration() -> None:
    """Skill tools advertise the expected schemas and registrations."""
    assert view_skill_tool.tool_name == "view_skill"
    assert "skill" in view_skill_tool.tool_description.lower()
    schema = view_skill_tool.tool_parameters
    assert schema["required"] == ["skill_dir"]
    assert "absolute" in schema["properties"]["skill_dir"]["description"].lower()
    assert schema["properties"]["file_path"].get("default") is None
    assert "relative" in schema["properties"]["file_path"]["description"].lower()

    import_schema = skill_tools.import_skills_tool.tool_parameters
    assert import_schema["required"] == ["path"]
    assert set(import_schema["properties"]) == {"path", "allow_overwite", "skill_name"}
    allow_overwite_schema = import_schema["properties"]["allow_overwite"]
    assert allow_overwite_schema.get("default") is False
    assert "optional" in allow_overwite_schema["description"].lower()
    skill_name_schema = import_schema["properties"]["skill_name"]
    assert skill_name_schema.get("default") is None
    assert "optional" in skill_name_schema["description"].lower()
    assert "github" in import_schema["properties"]["path"]["description"].lower()

    registered = {s.tool_name for s in TOOL_LIBRARY.all()}
    assert "view_skill" in registered
    assert "import_skills" in registered
    assert "download_skill_from_github" not in registered
    assert "download_skill_from_github" not in skill_tools.SKILLS_ADVANCED_TOOL_NAMES
    assert "download_skill_from_github" not in {
        spec.tool_name for spec in skill_tools.skills_advanced_tool_specs
    }


async def test_view_skill_md_lists_linked_files(make_skill: MakeSkill) -> None:
    """A bare name (no ``file_path``) loads the SKILL.md view: frontmatter
    name/description, raw content, the skill path/dir, and supporting files
    grouped under ``linked_files`` with a usage hint — and carries no per-file
    ``file`` key (it's the SKILL.md, not a specific-file lookup)."""
    skill_dir = await make_skill(
        "airtable",
        name="airtable",
        files={
            "references/api.md": "API DOC",
            "templates/out.md": "TPL",
            "scripts/run.sh": "echo hi",
            "loose.md": "LOOSE",
        },
    )

    result = json.loads(await view_skill(str(skill_dir)))

    assert result["success"] is True
    assert result["name"] == "airtable"
    assert result["description"] == "A demo skill"
    assert "# Demo" in result["content"]
    assert "file" not in result  # the SKILL.md view, not a specific-file lookup
    assert result["path"] == str(skill_dir / "SKILL.md")
    assert result["skill_dir"] == str(skill_dir)
    assert result["linked_files"] == {
        "references": ["references/api.md"],
        "templates": ["templates/out.md"],
        "scripts": ["scripts/run.sh"],
        "other": ["loose.md"],
    }
    assert "view_skill(skill_dir, file_path)" in result["usage_hint"]


# The full field set of a successful SKILL.md-view response.
_SKILL_MD_FIELDS = {
    "success", "name", "description", "content",
    "path", "skill_dir", "linked_files", "usage_hint",
}


async def test_view_skill_md_without_frontmatter(make_skill: MakeSkill) -> None:
    """A SKILL.md with no frontmatter still loads: name and description fall
    back to the stored row, content is the raw body, and linked_files/usage_hint
    are null. Every field of the response is asserted."""
    skill_dir = await make_skill(
        "plain", name="plain", description="Stored description",
        fm_name=None, body="just body",
    )

    result = json.loads(await view_skill(str(skill_dir)))

    assert set(result) == _SKILL_MD_FIELDS
    assert result["success"] is True
    assert result["name"] == "plain"
    assert result["description"] == ""
    assert result["content"] == "just body"
    assert result["path"] == str(skill_dir / "SKILL.md")
    assert result["skill_dir"] == str(skill_dir)
    assert result["linked_files"] is None
    assert result["usage_hint"] is None


async def test_display_name_prefers_frontmatter(make_skill: MakeSkill) -> None:
    """The returned ``name``/``description`` come from the SKILL.md frontmatter,
    preferred over the stored row name when they differ (the row name is still
    the lookup key); ``content`` is the raw file, frontmatter and all. Every
    field of the response is asserted."""
    skill_dir = await make_skill(
        "dir", name="catalogue-name", fm_name="frontmatter-name",
    )

    result = json.loads(await view_skill(str(skill_dir)))

    assert set(result) == _SKILL_MD_FIELDS
    assert result["success"] is True
    assert result["name"] == "frontmatter-name"
    assert result["description"] == "A demo skill"  # the frontmatter description
    assert "name: frontmatter-name" in result["content"]  # raw, keeps frontmatter
    assert "# Demo" in result["content"]
    assert result["path"] == str(skill_dir / "SKILL.md")
    assert result["skill_dir"] == str(skill_dir)
    assert result["linked_files"] is None
    assert result["usage_hint"] is None


async def test_resolve_skill_with_nested_dir(make_skill: MakeSkill) -> None:
    """The skill loads from whatever directory the store row records, including
    a nested one — the path/dir echo that absolute location. Every field of the
    response is asserted."""
    skill_dir = await make_skill("productivity/airtable", name="airtable")

    result = json.loads(await view_skill(str(skill_dir)))

    assert set(result) == _SKILL_MD_FIELDS
    assert result["success"] is True
    assert result["name"] == "airtable"
    assert result["description"] == "A demo skill"
    assert "# Demo" in result["content"]
    assert result["skill_dir"] == str(skill_dir)
    assert result["path"] == str(skill_dir / "SKILL.md")
    assert result["linked_files"] is None
    assert result["usage_hint"] is None


async def test_duplicate_name_rejected_by_unique_key(make_skill: MakeSkill) -> None:
    """The ``(user_id, name)`` unique key forbids two installed skills sharing a
    name for one user — the second install raises rather than duplicating, which
    is why ``get_by_name`` resolves a name to a single row."""
    await make_skill("first", name="airtable")

    with pytest.raises(IntegrityError):
        await make_skill("second", name="airtable")


async def test_skill_dir_is_symlink_to_other_dir(
    skills_db: None, tmp_path: Path,
) -> None:
    """A row whose ``skill_dir`` is a symlink to a real directory elsewhere
    still loads — the symlinked dir is the skill itself (unlike an outward
    symlink used as a ``file_path``)."""
    real = tmp_path / "elsewhere" / "airtable-real"
    (real / "references").mkdir(parents=True)
    (real / "SKILL.md").write_text(
        "---\nname: airtable\ndescription: d\n---\nbody", encoding="utf-8",
    )
    (real / "references" / "api.md").write_text("API", encoding="utf-8")
    link = tmp_path / "skills" / "airtable-link"
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")
    await SkillRepository().create(
        LOCAL_USER_ID, name="airtable", description="d", skill_dir=str(link),
        group="imported", source="local", source_uri=str(link),
    )

    result = json.loads(await view_skill(str(link)))

    assert set(result) == _SKILL_MD_FIELDS
    assert result["success"] is True
    assert result["name"] == "airtable"
    assert result["description"] == "d"
    assert "body" in result["content"]
    assert result["path"] == str(link / "SKILL.md")
    assert result["skill_dir"] == str(link)
    assert result["linked_files"] == {"references": ["references/api.md"]}
    assert "view_skill(skill_dir, file_path)" in result["usage_hint"]


# ── Reading a specific file ────────────────────────────────────────────────


async def test_view_specific_file(make_skill: MakeSkill) -> None:
    """``file_path`` reads that one file inside the skill dir, echoing the
    relative path and its suffix. Every field of the response is asserted."""
    skill_dir = await make_skill("demo", name="demo", files={"references/api.md": "API DOC"})

    result = json.loads(await view_skill(str(skill_dir), "references/api.md"))

    assert set(result) == {"success", "name", "file", "content", "file_type"}
    assert result["success"] is True
    assert result["name"] == "demo"
    assert result["file"] == "references/api.md"
    assert result["content"] == "API DOC"
    assert result["file_type"] == ".md"


async def test_view_binary_file_reports_metadata(make_skill: MakeSkill) -> None:
    """A non-UTF-8 file isn't decoded: it comes back flagged ``is_binary`` with
    a size note instead of garbled content (and no ``file_type``). Every field
    of the response is asserted."""
    skill_dir = await make_skill("demo", name="demo")
    (skill_dir / "assets").mkdir()
    (skill_dir / "assets" / "logo.png").write_bytes(b"\x89PNG\x00\xff\xfe")

    result = json.loads(await view_skill(str(skill_dir), "assets/logo.png"))

    assert set(result) == {"success", "name", "file", "content", "is_binary"}
    assert result["success"] is True
    assert result["name"] == "demo"
    assert result["file"] == "assets/logo.png"
    assert result["is_binary"] is True
    assert "logo.png" in result["content"]
    assert "7 bytes" in result["content"]


async def test_missing_file_lists_available(make_skill: MakeSkill) -> None:
    """A bad ``file_path`` in a real skill fails closed and lists the files that
    are actually present, grouped by folder. Every field of the response is
    asserted."""
    skill_dir = await make_skill("demo", name="demo", files={"references/api.md": "API DOC"})

    result = json.loads(await view_skill(str(skill_dir), "references/missing.md"))

    assert set(result) == {"success", "error", "available_files", "hint"}
    assert result["success"] is False
    assert "not found in skill 'demo'" in result["error"]
    assert result["available_files"] == {"references": ["references/api.md"]}
    assert "available file paths" in result["hint"]


# ── Failure / validation ───────────────────────────────────────────────────


async def test_missing_skill_directory_is_not_found(tmp_path: Path) -> None:
    """An absent absolute Skill directory fails without a catalogue lookup."""
    result = json.loads(await view_skill(str(tmp_path / "nope")))

    assert set(result) == {"success", "error"}
    assert result["success"] is False
    assert "does not exist" in result["error"]


async def test_no_skills_installed_yields_not_found(skills_db: None) -> None:
    """A relative directory is rejected independently of installed records."""
    result = json.loads(await view_skill("demo"))

    assert set(result) == {"success", "error", "hint"}
    assert result["success"] is False
    assert "absolute path" in result["error"]


async def test_skill_dir_missing_on_disk(skills_db: None, tmp_path: Path) -> None:
    """A row pointing at a directory that doesn't exist on disk surfaces the
    read failure rather than crashing."""
    ghost = tmp_path / "skills" / "ghost"
    result = json.loads(await view_skill(str(ghost)))

    assert result["success"] is False
    assert "does not exist" in result["error"]


@pytest.mark.parametrize(
    ("skill_dir", "fragment"),
    [
        ("", "skill_dir is required"),
        ("relative/skill", "absolute path"),
    ],
)
async def test_skill_dir_validation(skill_dir: str, fragment: str) -> None:
    """The Skill root must be a non-empty absolute directory."""
    result = json.loads(await view_skill(skill_dir))

    assert result["success"] is False
    assert fragment in result["error"]


async def test_agent_view_allows_enabled_and_catalogue_paths_only(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """An Agent may read enabled installed Skills and uninstalled candidates."""
    enabled = _write_skill_dir(tmp_path, "local/enabled", name="enabled")
    disabled = _write_skill_dir(tmp_path, "local/disabled", name="disabled")
    catalog_root = tmp_path / "catalog"
    candidate = _write_skill_dir(catalog_root, "owner/repo/candidate", name="candidate")
    monkeypatch.setattr(skill_tools, "_skills_catalog_root", lambda: catalog_root.resolve())

    ota_context = SimpleNamespace(selected_skill_dirs=[str(enabled)])
    token = current_agent.set(SimpleNamespace(
        ctx=SimpleNamespace(skills=SimpleNamespace()),
        _current_ota_context=ota_context,
    ))
    try:
        enabled_result = json.loads(await view_skill(str(enabled)))
        candidate_result = json.loads(await view_skill(str(candidate)))
        disabled_result = json.loads(await view_skill(str(disabled)))
    finally:
        current_agent.reset(token)

    assert enabled_result["success"] is True
    assert candidate_result["success"] is True
    assert disabled_result["success"] is False
    assert "neither selected by the current Think worker" in disabled_result["error"]


async def test_agent_view_forces_disabled_builtin_only_during_explore(
    tmp_path: Path,
) -> None:
    builtin = _write_skill_dir(tmp_path, "builtin/how-to", name="how-to")

    ota_context = SimpleNamespace(selected_skill_dirs=[])
    token = current_agent.set(SimpleNamespace(
        ctx=SimpleNamespace(skills=SimpleNamespace()),
        _current_ota_context=ota_context,
    ))
    try:
        ordinary = json.loads(await view_skill(str(builtin)))
        ota_context.selected_skill_dirs = [str(builtin)]
        explore = json.loads(await view_skill(str(builtin)))
    finally:
        current_agent.reset(token)

    assert ordinary["success"] is False
    assert explore["success"] is True


async def test_file_path_absolute_is_rejected(make_skill: MakeSkill) -> None:
    """An absolute ``file_path`` is refused outright — it must be relative to
    the skill directory."""
    skill_dir = await make_skill("demo", name="demo")

    result = json.loads(await view_skill(str(skill_dir), "/etc/passwd"))

    assert result["success"] is False
    assert "must be relative" in result["error"]


async def test_file_path_traversal_is_rejected(
    make_skill: MakeSkill, tmp_path: Path,
) -> None:
    """A ``..`` ``file_path`` that resolves outside the skill directory is
    refused even though the target exists."""
    skill_dir = await make_skill("demo", name="demo")
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")

    rel = os.path.relpath(secret, skill_dir)
    result = json.loads(await view_skill(str(skill_dir), rel))

    assert result["success"] is False
    assert "escapes the skill directory" in result["error"]


async def test_file_path_symlink_out_is_rejected(
    make_skill: MakeSkill, tmp_path: Path,
) -> None:
    """A symlink inside the skill dir pointing outside it is caught by the
    realpath containment check, not silently followed."""
    skill_dir = await make_skill("demo", name="demo")
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")
    link = skill_dir / "leak.txt"
    try:
        link.symlink_to(secret)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")

    result = json.loads(await view_skill(str(skill_dir), "leak.txt"))

    assert result["success"] is False
    assert "escapes the skill directory" in result["error"]


# ── Management tools ───────────────────────────────────────────────────────


async def test_list_skills_filters_enabled(seeded_tool_skills: list[int]) -> None:
    """``list_skills`` defaults to enabled skills, while ``filter='all'`` keeps
    disabled skills visible for management. Disabled skills stay out of the
    runtime skill catalogue."""
    enabled_id, disabled_id = seeded_tool_skills

    enabled = json.loads(await list_skills())
    assert set(enabled) == _MANAGEMENT_RESPONSE_FIELDS
    assert enabled["success"] is True
    assert enabled["filter"] == "enabled"
    assert enabled["count"] == len(BUILTIN_NAMES) + 1
    assert len(enabled["skills"]) == len(BUILTIN_NAMES) + 1
    enabled_by_name = {row["name"]: row for row in enabled["skills"]}
    assert set(enabled_by_name) == BUILTIN_NAMES | {"enabled-skill"}
    assert enabled_by_name["how-to"]["group"] == "builtin"
    enabled_row = enabled_by_name["enabled-skill"]
    assert set(enabled_row) == _MANAGEMENT_SKILL_FIELDS
    assert enabled_row["skill_id"] == enabled_id
    assert enabled_row["name"] == "enabled-skill"
    assert enabled_row["description"] == "Enabled skill."
    assert enabled_row["skill_dir"] == "/skills/enabled-skill"
    assert enabled_row["group"] == "imported"
    assert enabled_row["source"] == "local"
    assert enabled_row["source_uri"] == "/src/enabled-skill"
    assert enabled_row["enabled"] is True
    assert isinstance(enabled_row["updated_at"], str)
    assert enabled_row["updated_at"]

    all_rows = json.loads(await list_skills(filter="all"))
    assert set(all_rows) == _MANAGEMENT_RESPONSE_FIELDS
    assert all_rows["success"] is True
    assert all_rows["filter"] == "all"
    assert all_rows["count"] == len(BUILTIN_NAMES) + 2
    assert len(all_rows["skills"]) == len(BUILTIN_NAMES) + 2
    by_name = {row["name"]: row for row in all_rows["skills"]}
    assert set(by_name) == BUILTIN_NAMES | {"enabled-skill", "disabled-skill"}
    assert {enabled_id, disabled_id}.issubset(
        {row["skill_id"] for row in all_rows["skills"]},
    )
    assert all(set(row) == _MANAGEMENT_SKILL_FIELDS for row in all_rows["skills"])
    assert by_name["enabled-skill"] == enabled_row
    disabled_row = by_name["disabled-skill"]
    assert disabled_row["skill_id"] == disabled_id
    assert disabled_row["name"] == "disabled-skill"
    assert disabled_row["description"] == "Disabled skill."
    assert disabled_row["skill_dir"] == "/skills/disabled-skill"
    assert disabled_row["group"] == "imported"
    assert disabled_row["source"] == "local"
    assert disabled_row["source_uri"] == "/src/disabled-skill"
    assert disabled_row["enabled"] is False
    assert isinstance(disabled_row["updated_at"], str)
    assert disabled_row["updated_at"]

    library = await SkillLibrary(LOCAL_USER_ID).load()
    assert set(library.data()) == BUILTIN_NAMES | {"enabled-skill"}


async def test_set_enabled_and_uninstall_skill_by_name(
    seeded_tool_skills: list[int],
) -> None:
    """Management tools resolve skills by catalogue name rather than skill id."""
    enabled_id, disabled_id = seeded_tool_skills

    disabled = json.loads(await set_skill_enabled("enabled-skill", enabled=False))
    assert set(disabled) == {"success", "skill"}
    assert disabled["success"] is True
    assert set(disabled["skill"]) == _MANAGEMENT_SKILL_FIELDS
    assert disabled["skill"]["skill_id"] == enabled_id
    assert disabled["skill"]["name"] == "enabled-skill"
    assert disabled["skill"]["description"] == "Enabled skill."
    assert disabled["skill"]["skill_dir"] == "/skills/enabled-skill"
    assert disabled["skill"]["group"] == "imported"
    assert disabled["skill"]["source"] == "local"
    assert disabled["skill"]["source_uri"] == "/src/enabled-skill"
    assert disabled["skill"]["enabled"] is False
    assert isinstance(disabled["skill"]["updated_at"], str)
    assert disabled["skill"]["updated_at"]

    enabled = json.loads(await set_skill_enabled("disabled-skill", enabled=True))
    assert set(enabled) == {"success", "skill"}
    assert enabled["success"] is True
    assert set(enabled["skill"]) == _MANAGEMENT_SKILL_FIELDS
    assert enabled["skill"]["skill_id"] == disabled_id
    assert enabled["skill"]["name"] == "disabled-skill"
    assert enabled["skill"]["description"] == "Disabled skill."
    assert enabled["skill"]["skill_dir"] == "/skills/disabled-skill"
    assert enabled["skill"]["group"] == "imported"
    assert enabled["skill"]["source"] == "local"
    assert enabled["skill"]["source_uri"] == "/src/disabled-skill"
    assert enabled["skill"]["enabled"] is True
    assert isinstance(enabled["skill"]["updated_at"], str)
    assert enabled["skill"]["updated_at"]

    removed = json.loads(await uninstall_skill("enabled-skill"))
    assert set(removed) == {"success", "uninstalled", "message"}
    assert removed["success"] is True
    assert set(removed["uninstalled"]) == _MANAGEMENT_SKILL_FIELDS
    assert removed["uninstalled"] == disabled["skill"]
    assert removed["message"] == "Skill 'enabled-skill' was uninstalled."

    all_rows = json.loads(await list_skills(filter="all"))
    assert set(all_rows) == _MANAGEMENT_RESPONSE_FIELDS
    assert all_rows["success"] is True
    assert all_rows["filter"] == "all"
    assert all_rows["count"] == len(BUILTIN_NAMES) + 1
    assert len(all_rows["skills"]) == len(BUILTIN_NAMES) + 1
    by_name = {row["name"]: row for row in all_rows["skills"]}
    assert set(by_name) == BUILTIN_NAMES | {"disabled-skill"}
    assert by_name["disabled-skill"] == enabled["skill"]


async def test_uninstall_builtin_skill_is_rejected(skills_db: None) -> None:
    await SkillLibrary(LOCAL_USER_ID).sync_builtins()

    result = json.loads(await uninstall_skill("how-to"))

    assert result["success"] is False
    assert result["uninstalled"] is None
    assert "cannot be uninstalled" in result["message"]
    stored = await SkillRepository().get_by_name(LOCAL_USER_ID, "how-to")
    assert stored is not None and stored.group == "builtin"


async def test_import_skills_returns_conflicts_before_overwrite(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Import checks return conflict details before overwriting; setting
    ``allow_overwite`` performs the overwrite."""
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    first_source = tmp_path / "first"
    first_source.mkdir()
    _write_skill_dir(first_source, "demo", name="demo", description="v1")

    first = json.loads(await import_skills(str(first_source), allow_overwite=False))
    assert set(first) == _IMPORT_SUMMARY_FIELDS
    assert first["success"] is True
    assert first["status"] == "import_executed"
    assert first["total"] == 1
    assert first["succeeded"] == 1
    assert first["failed"] == 0
    assert first["added"] == 1
    assert first["overwritten"] == 0
    assert first["failed_skills"] == []
    assert len(first["imported_skills"]) == 1
    first_imported = first["imported_skills"][0]
    assert set(first_imported) == _IMPORT_ROW_FIELDS
    assert isinstance(first_imported["skill_id"], int)
    assert first_imported["name"] == "demo"
    assert first_imported["description"] == "v1"
    assert first_imported["skill_dir"] == str(managed_root / "demo")
    assert first_imported["group"] == "imported"
    assert first_imported["source"] == "local"
    assert first_imported["source_uri"] == str(first_source / "demo")
    assert isinstance(first_imported["updated_at"], str)
    assert first_imported["updated_at"]
    assert first_imported["action"] == "added"

    second_source = tmp_path / "second"
    second_source.mkdir()
    _write_skill_dir(second_source, "demo-v2", name="demo", description="v2")

    check = json.loads(await import_skills(str(second_source), allow_overwite=False))
    assert set(check) == _IMPORT_CHECK_FIELDS
    assert check["success"] is False
    assert check["status"] == "conflicts_detected"
    assert "same-named installed skills" in check["message"]
    assert "Present the conflict details to the user" in check["message"]
    assert "serious skill data loss" in check["message"]
    assert "allow_overwite=true" not in check["message"]
    assert check["total"] == 1
    assert check["conflicts"] == 1
    assert len(check["results"]) == 1
    conflict = check["results"][0]
    assert set(conflict) == _IMPORT_CHECK_RESULT_FIELDS
    assert conflict["conflict"] is True
    assert set(conflict["incoming"]) == _IMPORT_INCOMING_FIELDS
    assert conflict["incoming"]["name"] == "demo"
    assert conflict["incoming"]["description"] == "v2"
    assert conflict["incoming"]["source"] == "local"
    assert conflict["incoming"]["source_uri"] == str(second_source / "demo-v2")
    assert conflict["incoming"]["local_path"] == str(second_source / "demo-v2")
    assert isinstance(conflict["incoming"]["updated_at"], str)
    assert conflict["incoming"]["updated_at"]
    assert set(conflict["existing"]) == _IMPORT_EXISTING_FIELDS
    assert conflict["existing"]["skill_id"] == first_imported["skill_id"]
    assert conflict["existing"]["name"] == "demo"
    assert conflict["existing"]["description"] == "v1"
    assert conflict["existing"]["skill_dir"] == str(managed_root / "demo")
    assert conflict["existing"]["group"] == "imported"
    assert conflict["existing"]["source"] == "local"
    assert conflict["existing"]["source_uri"] == str(first_source / "demo")
    assert isinstance(conflict["existing"]["updated_at"], str)
    assert conflict["existing"]["updated_at"]

    overwritten = json.loads(
        await import_skills(str(second_source), allow_overwite=True)
    )
    assert set(overwritten) == _IMPORT_SUMMARY_FIELDS
    assert overwritten["success"] is True
    assert overwritten["status"] == "import_executed"
    assert overwritten["total"] == 1
    assert overwritten["succeeded"] == 1
    assert overwritten["failed"] == 0
    assert overwritten["added"] == 0
    assert overwritten["overwritten"] == 1
    assert overwritten["failed_skills"] == []
    assert len(overwritten["imported_skills"]) == 1
    overwritten_row = overwritten["imported_skills"][0]
    assert set(overwritten_row) == _IMPORT_ROW_FIELDS
    assert overwritten_row["skill_id"] == first_imported["skill_id"]
    assert overwritten_row["name"] == "demo"
    assert overwritten_row["description"] == "v2"
    assert overwritten_row["skill_dir"] == str(managed_root / "demo-v2")
    assert overwritten_row["group"] == "imported"
    assert overwritten_row["source"] == "local"
    assert overwritten_row["source_uri"] == str(second_source / "demo-v2")
    assert isinstance(overwritten_row["updated_at"], str)
    assert overwritten_row["updated_at"]
    assert overwritten_row["action"] == "overwritten"


async def test_import_skills_with_skill_name_imports_only_matching_skill(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    source = tmp_path / "source"
    source.mkdir()
    _write_skill_dir(source, "alpha-dir", name="alpha", description="Alpha skill")
    _write_skill_dir(source, "beta-dir", name="beta", description="Beta skill")

    result = json.loads(
        await import_skills(
            str(source),
            allow_overwite=False,
            skill_name="beta",
        )
    )

    assert set(result) == _IMPORT_SUMMARY_FIELDS
    assert result["success"] is True
    assert result["status"] == "import_executed"
    assert result["total"] == 1
    assert result["succeeded"] == 1
    assert result["failed"] == 0
    assert result["added"] == 1
    assert result["overwritten"] == 0
    assert result["failed_skills"] == []
    assert len(result["imported_skills"]) == 1
    imported = result["imported_skills"][0]
    assert imported["name"] == "beta"
    assert imported["description"] == "Beta skill"
    assert imported["skill_dir"] == str(managed_root / "beta-dir")

    repo = SkillRepository()
    assert await repo.get_by_name(LOCAL_USER_ID, "alpha") is None
    beta = await repo.get_by_name(LOCAL_USER_ID, "beta")
    assert beta is not None
    assert beta.description == "Beta skill"


async def test_import_skills_with_missing_skill_name_returns_error(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_skill_dir(source, "alpha-dir", name="alpha", description="Alpha skill")

    result = json.loads(
        await import_skills(
            str(source),
            allow_overwite=False,
            skill_name="missing",
        )
    )

    assert result["success"] is False
    assert result["error"] == f"No skill named 'missing' was found under {str(source)!r}."


async def test_import_skills_string_false_returns_conflicts_before_overwrite(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """String ``"False"`` should not be treated as truthy and overwrite."""
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    first_source = tmp_path / "first"
    first_source.mkdir()
    _write_skill_dir(first_source, "demo", name="demo", description="v1")
    first = json.loads(await import_skills(str(first_source), allow_overwite=False))
    assert first["success"] is True

    second_source = tmp_path / "second"
    second_source.mkdir()
    _write_skill_dir(second_source, "demo-v2", name="demo", description="v2")

    check = json.loads(
        await import_skills(  # type: ignore[arg-type]
            str(second_source),
            allow_overwite="False",
        )
    )

    assert set(check) == _IMPORT_CHECK_FIELDS
    assert check["success"] is False
    assert check["status"] == "conflicts_detected"
    assert check["conflicts"] == 1

    stored = await SkillRepository().get_by_name(LOCAL_USER_ID, "demo")
    assert stored is not None
    assert stored.description == "v1"
    assert stored.skill_dir == str(managed_root / "demo")


async def test_import_skills_string_true_overwrites_conflict(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """String ``"true"`` remains accepted for tool-call compatibility."""
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    first_source = tmp_path / "first"
    first_source.mkdir()
    _write_skill_dir(first_source, "demo", name="demo", description="v1")
    first = json.loads(await import_skills(str(first_source), allow_overwite=False))
    assert first["success"] is True

    second_source = tmp_path / "second"
    second_source.mkdir()
    _write_skill_dir(second_source, "demo-v2", name="demo", description="v2")

    overwritten = json.loads(
        await import_skills(  # type: ignore[arg-type]
            str(second_source),
            allow_overwite="true",
        )
    )

    assert overwritten["success"] is True
    assert overwritten["overwritten"] == 1
    assert overwritten["imported_skills"][0]["description"] == "v2"


async def test_import_skills_invalid_overwrite_flag_returns_error(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()

    result = json.loads(
        await import_skills(  # type: ignore[arg-type]
            str(source),
            allow_overwite="definitely",
        )
    )

    assert result == {
        "success": False,
        # The message names the fix so the model can self-correct instead of
        # retrying the same value (see _coerce_optional_bool).
        "error": "allow_overwite must be a boolean value: omit it, or pass true / false.",
        "hint": "Pass true or false for allow_overwite.",
    }


async def test_import_skills_skills_sh_url_rejects_mismatched_skill_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested_url = "https://www.skills.sh/acme/repo/page-skill"

    monkeypatch.setattr(
        skill_import_handler,
        "_fetch_skills_sh_page_metadata",
        lambda _url: skill_import_handler._SkillShPageMetadata(
            skill_name="page-skill",
            repository_url="https://github.com/acme/repo",
        ),
    )

    def fail_download(_url: str) -> None:  # pragma: no cover - should not run
        raise AssertionError("download should not run for a mismatched skill_name")

    monkeypatch.setattr(skill_import_handler, "_download_skill_from_github_url", fail_download)

    result = json.loads(
        await import_skills(
            requested_url,
            allow_overwite=False,
            skill_name="other-skill",
        )
    )

    assert result == {
        "success": False,
        "error": (
            "skills.sh page skill name 'page-skill' does not match requested "
            "skill_name 'other-skill'."
        ),
    }


async def test_import_skills_supports_skills_sh_url(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The agent import tool accepts a skills.sh page URL, resolves the page
    skill name + Repository URL, and imports only that page's skill."""
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))
    requested_url = "https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices"
    downloaded = tmp_path / "downloaded"
    downloaded.mkdir()
    _write_skill_dir(
        downloaded,
        "vercel-react-best-practices",
        name="vercel-react-best-practices",
        description="React guidance.",
    )
    monkeypatch.setattr(
        skill_import_handler,
        "_fetch_skills_sh_page_metadata",
        lambda _url: skill_import_handler._SkillShPageMetadata(
            skill_name="vercel-react-best-practices",
            repository_url="https://github.com/vercel-labs/agent-skills",
        ),
    )
    monkeypatch.setattr(
        skill_import_handler,
        "_download_skill_from_github_url",
        lambda _url: SimpleNamespace(
            skill_dir=downloaded,
            source_uri="https://github.com/vercel-labs/agent-skills/tree/main",
        ),
    )

    summary = json.loads(await import_skills(requested_url, allow_overwite=False))

    assert set(summary) == _IMPORT_SUMMARY_FIELDS
    assert summary["success"] is True
    assert summary["status"] == "import_executed"
    assert summary["total"] == 1
    assert summary["succeeded"] == 1
    assert summary["failed"] == 0
    imported = summary["imported_skills"][0]
    assert set(imported) == _IMPORT_ROW_FIELDS
    assert imported["name"] == "vercel-react-best-practices"
    assert imported["source"] == "skills.sh"
    assert imported["source_uri"] == "https://github.com/vercel-labs/agent-skills/tree/main"
    assert Path(imported["skill_dir"]).is_relative_to(managed_root)
    assert Path(imported["skill_dir"], "SKILL.md").is_file()

    stored = await SkillRepository().get_by_name(
        LOCAL_USER_ID,
        "vercel-react-best-practices",
    )
    assert stored is not None
    assert stored.source == "skills.sh"
    assert stored.source_uri == "https://github.com/vercel-labs/agent-skills/tree/main"


async def test_import_skills_github_url_overrides_source_metadata(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub URL imports download first and store the remote source metadata.

    The downloaded local directory still has to be used internally as the copy
    source, while the imported row records the resolved GitHub source URI.
    """
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    source_root = tmp_path / "downloaded"
    source_root.mkdir()
    local_skill_dir = _write_skill_dir(
        source_root,
        "demo",
        name="demo",
        description="Downloaded from GitHub",
    )
    github_url = "https://github.com/openai/skills/tree/main/skills/.curated/cloudflare-deploy"
    remote_source_uri = github_url
    monkeypatch.setattr(
        skill_import_handler,
        "_download_skill_from_github_url",
        lambda _url: skill_import_handler._DownloadedGithubSkill(
            "openai", "skills", "main", "skills/.curated/cloudflare-deploy",
            source_root, source_root,
            "https://github.com/openai/skills.git", remote_source_uri,
        ),
    )

    imported = json.loads(await import_skills(github_url, allow_overwite=False))

    assert set(imported) == _IMPORT_SUMMARY_FIELDS
    assert imported["success"] is True
    assert imported["status"] == "import_executed"
    assert imported["total"] == 1
    assert imported["succeeded"] == 1
    assert imported["failed"] == 0
    row = imported["imported_skills"][0]
    assert set(row) == _IMPORT_ROW_FIELDS
    assert row["name"] == "demo"
    assert row["description"] == "Downloaded from GitHub"
    assert row["skill_dir"] == str(managed_root / "demo")
    assert row["source"] == "github"
    assert row["source_uri"] == remote_source_uri
    assert row["source_uri"] != str(local_skill_dir)
    assert Path(row["skill_dir"], "SKILL.md").is_file()

    stored = await SkillRepository().get_by_name(LOCAL_USER_ID, "demo")
    assert stored is not None
    assert stored.source == "github"
    assert stored.source_uri == remote_source_uri
    assert stored.skill_dir == str(managed_root / "demo")


async def test_import_skills_github_conflict_details_use_remote_metadata(
    skills_db: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Conflict previews for GitHub imports should show remote metadata too."""
    _ = skills_db
    managed_root = tmp_path / "managed"
    monkeypatch.setenv("BRIDGIC_AGENT_SKILLS_ROOT", str(managed_root))

    first_source = tmp_path / "first"
    first_source.mkdir()
    _write_skill_dir(first_source, "demo", name="demo", description="v1")
    first = json.loads(await import_skills(str(first_source), allow_overwite=False))
    assert first["success"] is True

    second_source = tmp_path / "second"
    second_source.mkdir()
    _write_skill_dir(second_source, "demo-v2", name="demo", description="v2")
    github_url = "https://github.com/example/repo/tree/main/skills/demo"
    remote_source_uri = github_url
    monkeypatch.setattr(
        skill_import_handler,
        "_download_skill_from_github_url",
        lambda _url: skill_import_handler._DownloadedGithubSkill(
            "example", "repo", "main", "skills/demo",
            second_source, second_source,
            "https://github.com/example/repo.git", remote_source_uri,
        ),
    )

    check = json.loads(await import_skills(github_url, allow_overwite=False))

    assert set(check) == _IMPORT_CHECK_FIELDS
    assert check["success"] is False
    assert check["status"] == "conflicts_detected"
    incoming = check["results"][0]["incoming"]
    assert incoming["name"] == "demo"
    assert incoming["description"] == "v2"
    assert incoming["source"] == "github"
    assert incoming["source_uri"] == remote_source_uri


# ── GitHub URL parsing and local safety ─────────────────────────────────────


def test_bare_repo_url_candidates_use_resolved_default_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bare repo URL (with or without ``.git`` / trailing slash) resolves the
    repository default branch and returns that single ref with an empty path."""
    slash = "https://github.com/bitsky-tech/bridgic-browser/"
    dot_git = "https://github.com/bitsky-tech/bridgic-browser.git"
    owner, repo = "bitsky-tech", "bridgic-browser"

    resolved: list[tuple[str, str]] = []

    def _fake_resolve(owner_arg: str, repo_arg: str) -> str:
        resolved.append((owner_arg, repo_arg))
        return "develop"

    monkeypatch.setattr(skill_import_handler, "_resolve_default_branch", _fake_resolve)

    assert skill_import_handler._github_url_download_candidates(slash) == [
        (owner, repo, "develop", ""),
    ]
    assert skill_import_handler._github_url_download_candidates(dot_git) == [
        (owner, repo, "develop", ""),
    ]
    assert resolved == [(owner, repo), (owner, repo)]


def test_tree_url_candidates_enumerate_ref_path_splits() -> None:
    """A ``/tree/`` URL with a slashed branch enumerates every ref/path split so a
    later candidate recovers the real ref."""
    url = (
        "https://github.com/anthropics/skills/tree/"
        "andibrae/create-top-level-namespace/skills/xlsx"
    )
    assert skill_import_handler._github_url_download_candidates(url) == [
        ("anthropics", "skills", "andibrae", "create-top-level-namespace/skills/xlsx"),
        ("anthropics", "skills", "andibrae/create-top-level-namespace", "skills/xlsx"),
        ("anthropics", "skills", "andibrae/create-top-level-namespace/skills", "xlsx"),
        ("anthropics", "skills", "andibrae/create-top-level-namespace/skills/xlsx", ""),
    ]


def test_blob_skill_md_url_candidates_strip_trailing_skill_md() -> None:
    """A ``/blob/.../SKILL.md`` URL drops the file so the first candidate points at
    the skill's parent directory."""
    url = "https://github.com/openai/skills/blob/main/skills/.curated/pdf/SKILL.md"
    candidates = skill_import_handler._github_url_download_candidates(url)
    assert candidates[0] == ("openai", "skills", "main", "skills/.curated/pdf")


class _FakeHttpResponse:
    """Minimal context-manager stand-in for ``urllib.request.urlopen``."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeHttpResponse":
        return self

    def __exit__(self, *_exc: object) -> bool:
        return False


def test_resolve_default_branch_reads_rest_api(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_resolve_default_branch`` reads ``default_branch`` from the REST API
    (no ``git`` subprocess)."""
    payload = json.dumps({"default_branch": "develop"}).encode("utf-8")
    monkeypatch.setattr(
        skill_import_handler.urllib.request,
        "urlopen",
        lambda *_a, **_k: _FakeHttpResponse(payload),
    )
    assert skill_import_handler._resolve_default_branch("owner", "repo") == "develop"


def test_resolve_default_branch_raises_on_api_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_a: object, **_k: object) -> None:
        raise OSError("network down")

    monkeypatch.setattr(skill_import_handler.urllib.request, "urlopen", _boom)
    with pytest.raises(skill_import_handler._SkillDownloadError):
        skill_import_handler._resolve_default_branch("owner", "repo")


def test_sweep_stale_skill_downloads_removes_only_old_stagings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The sweep deletes ``amphi-skill-*`` stagings past the TTL, keeps fresh ones,
    and never touches unrelated temp dirs."""
    monkeypatch.setattr(skill_import_handler.tempfile, "gettempdir", lambda: str(tmp_path))
    prefix = skill_import_handler._SKILL_DOWNLOAD_PREFIX
    ttl = skill_import_handler._SKILL_DOWNLOAD_TTL_SECONDS

    stale = tmp_path / f"{prefix}anthropics-skills-old"
    fresh = tmp_path / f"{prefix}openai-skills-new"
    unrelated = tmp_path / "some-other-tempdir"
    for d in (stale, fresh, unrelated):
        d.mkdir()
    old_mtime = time.time() - ttl - 60
    os.utime(stale, (old_mtime, old_mtime))

    skill_import_handler._sweep_stale_skill_downloads()

    assert not stale.exists()  # past TTL → swept
    assert fresh.exists()  # within TTL → kept (a just-scanned download survives)
    assert unrelated.exists()  # non-matching name → never touched


@pytest.mark.parametrize(
    ("owner", "repo", "path", "ref", "expected_error"),
    [
        ("", "repo", "", "main", "owner is required"),
        ("owner/name", "repo", "", "main", "owner must be a single GitHub path segment"),
        ("owner", "", "", "main", "repo is required"),
        ("owner", "repo/name", "", "main", "repo must be a single GitHub path segment"),
        ("owner", "repo", "/absolute", "main", "path must be a relative directory path"),
        ("owner", "repo", "../skill", "main", "path cannot contain '..'"),
        ("owner", "repo", "skill", "-bad", "ref is invalid"),
    ],
)
async def test_internal_github_download_validates_inputs(
    owner: str,
    repo: str,
    path: str,
    ref: str,
    expected_error: str,
) -> None:
    with pytest.raises(skill_import_handler._SkillDownloadError, match=expected_error):
        skill_import_handler._download_skill_from_github(owner, repo, path=path, ref=ref)


def test_safe_extract_zip_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zip_file:
        zip_file.writestr("../evil.txt", "owned")

    with zipfile.ZipFile(archive, "r") as zip_file:
        with pytest.raises(skill_import_handler._SkillDownloadError, match="outside the destination"):
            skill_import_handler._safe_extract_zip(zip_file, tmp_path / "extract")
