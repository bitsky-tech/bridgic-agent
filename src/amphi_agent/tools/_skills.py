from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from bridgic.amphibious.builtin_tools import current_agent
from bridgic.core.agentic.tool_specs import FunctionToolSpec

from .._skills import SkillLibrary, SkillSource
from ...amphi_service.auth import get_current_user
from ...amphi_store import Skill, SkillRepository

SKILLS_BASIC_TOOL_NAMES = frozenset({
    "view_skill",
    "manage_skills",
})

SKILLS_ADVANCED_TOOL_NAMES = frozenset({
    "import_skills",
    "list_skills",
    "set_skill_enabled",
    "uninstall_skill",
})

SKILLS_TOOL_NAMES = SKILLS_BASIC_TOOL_NAMES | SKILLS_ADVANCED_TOOL_NAMES

# The store-backed runtime catalogue records each Skill's on-disk directory.
# That directory holds ``SKILL.md`` and optional supporting files.

# File extensions surfaced when listing a skill's loose (non-foldered) files.
_SKILL_TEXT_SUFFIXES = {".md", ".py", ".yaml", ".yml", ".json", ".tex", ".sh"}


def _skills_catalog_root() -> Path:
    """Return the read-only candidate Skill catalogue root."""
    return (Path.home() / ".bridgic" / "AmphiAgent" / "skills" / "catalog").resolve()


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _coerce_optional_bool(value: Any, *, name: str) -> tuple[Optional[bool], Optional[str]]:
    """Coerce tool-supplied boolean-ish values into a real bool.

    Tool arguments normally arrive as JSON booleans, but some callers may pass
    string values such as ``"False"``. A non-empty string is truthy in Python, so
    using it directly in conditions can accidentally enable destructive actions.

    A stringified null (``"None"`` / ``"null"``) is the model spelling "not
    specified", so it lands on the same ``False`` as an omitted field — never on
    the truthy branch, which would silently permit overwriting installed skills.
    """
    if value is None:
        return False, None
    if isinstance(value, bool):
        return value, None
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True, None
        if normalized in {"false", "0", "no", "n", "off", "", "none", "null"}:
            return False, None
    return None, f"{name} must be a boolean value: omit it, or pass true / false."


def _skill_detail(skill: Skill) -> dict:
    return {
        "skill_id": skill.id,
        "name": skill.name,
        "description": skill.description,
        "skill_dir": skill.skill_dir,
        "group": skill.group,
        "source": skill.source,
        "source_uri": skill.source_uri,
        "enabled": skill.enabled,
        "updated_at": skill.updated_at.isoformat() if skill.updated_at else None,
    }


def _skill_name_error(name: str) -> Optional[str]:
    """Return an error string if *name* can't be a safe skill lookup name.

    The name is matched against the catalogue rather than joined onto a path,
    but it is still kept relative and traversal-free — for parity with
    ``file_path`` and because a real catalogue name is never an absolute or
    ``..`` path. Returns ``None`` when *name* is safe to use.
    """
    candidate = (name or "").strip()
    if not candidate:
        return "Skill name is required."
    if os.path.isabs(candidate):
        return "Skill name must be a relative name within the skills directory."
    if ".." in Path(candidate).parts:
        return "Skill name cannot contain '..' path traversal components."
    return None


def _parse_skill_frontmatter(content: str) -> Dict[str, Any]:
    """Parse the leading ``--- … ---`` YAML frontmatter block of a SKILL.md.

    Returns the block's mapping (e.g. ``name`` / ``description``) as a dict, or
    ``{}`` when there is no frontmatter or it doesn't parse to a mapping.
    """
    if not content.startswith("---"):
        return {}
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    closing = next(
        (i for i in range(1, len(lines)) if lines[i].strip() == "---"), None
    )
    if closing is None:
        return {}
    try:
        import yaml

        parsed = yaml.safe_load("\n".join(lines[1:closing]))
    except Exception:  # noqa: BLE001 — frontmatter is best-effort metadata
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _list_skill_files(skill_dir: Path) -> Dict[str, List[str]]:
    """Group a skill directory's supporting files (everything but ``SKILL.md``)
    by their top-level folder — ``references`` / ``templates`` / ``assets`` /
    ``scripts``, with loose text files under ``other`` — each as a list of paths
    relative to *skill_dir*. Empty groups are dropped."""
    grouped: Dict[str, List[str]] = {
        "references": [], "templates": [], "assets": [], "scripts": [], "other": [],
    }
    if not skill_dir.is_dir():
        return {}
    for f in sorted(skill_dir.rglob("*")):
        if not f.is_file() or f.name == "SKILL.md":
            continue
        parts = f.relative_to(skill_dir).parts
        rel = str(f.relative_to(skill_dir))
        if len(parts) > 1 and parts[0] in grouped:
            grouped[parts[0]].append(rel)
        elif f.suffix in _SKILL_TEXT_SUFFIXES:
            grouped["other"].append(rel)
    return {group: files for group, files in grouped.items() if files}


async def view_skill(skill_dir: str, file_path: Optional[str] = None) -> str:
    """View a Skill by its absolute directory, including uninstalled candidates.

    Installed Skill locations come from the ``<skills>`` catalogue. Candidate
    locations may come from the trusted Skill catalogue synchronizer under
    ``~/.bridgic/AmphiAgent/skills/catalog``. The tool reads files only; it does
    not install, enable, or register a Skill.

    Args:
        skill_dir: Absolute directory containing ``SKILL.md``. During an Agent
            run, it must be either an enabled installed Skill location from the
            current ``SkillLibrary`` snapshot or a directory inside the
            candidate catalogue root.
        file_path: OPTIONAL relative path to one file inside ``skill_dir``.
            Omit it to read ``SKILL.md``. Absolute paths and paths escaping the
            Skill directory through ``..`` or a symlink are rejected.

    Returns:
        A JSON string containing the Skill content and metadata, or a confined
        read error.
    """
    raw_dir = (skill_dir or "").strip()
    if not raw_dir:
        return _json({
            "success": False,
            "error": "skill_dir is required.",
            "hint": "Use the absolute location shown in <skills> or returned by Skill discovery.",
        })
    if not os.path.isabs(raw_dir):
        return _json({
            "success": False,
            "error": "skill_dir must be an absolute path.",
            "hint": "Use the absolute location shown in <skills> or returned by Skill discovery.",
        })

    requested_dir = Path(raw_dir)
    real_dir = Path(os.path.realpath(requested_dir))
    agent = current_agent.get(None)
    context = (
        getattr(agent, "ctx", None)
        or getattr(agent, "context", None)
        or getattr(agent, "_current_context", None)
        if agent is not None else None
    )
    if agent is not None and context is None:
        return _json({
            "success": False,
            "error": "view_skill cannot validate the Skill location without Agent context.",
        })
    if context is not None:
        ota_context = getattr(agent, "_current_ota_context", None)
        selected_dirs = {
            Path(os.path.realpath(path))
            for path in getattr(ota_context, "selected_skill_dirs", [])
            if path
        }
        catalog_root = _skills_catalog_root()
        try:
            inside_catalog = real_dir != catalog_root and real_dir.is_relative_to(catalog_root)
        except ValueError:
            inside_catalog = False
        if real_dir not in selected_dirs and not inside_catalog:
            return _json({
                "success": False,
                "error": (
                    "skill_dir is neither selected by the current Think worker "
                    "nor a candidate inside the Skill catalogue."
                ),
                "hint": "Use a location from <skills> or the candidate synchronizer output.",
            })

    if not real_dir.is_dir():
        return _json({
            "success": False,
            "error": f"Skill directory does not exist: {raw_dir!r}.",
        })
    skill_md = real_dir / "SKILL.md"
    if not skill_md.is_file():
        return _json({
            "success": False,
            "error": f"Skill directory does not contain SKILL.md: {raw_dir!r}.",
        })
    try:
        main_content = skill_md.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        return _json({
            "success": False,
            "error": f"Failed to read Skill at {raw_dir!r}: {exc}",
        })
    frontmatter = _parse_skill_frontmatter(main_content)
    skill_name = str(frontmatter.get("name") or requested_dir.name)
    skill_description = str(frontmatter.get("description") or "")

    # ── A specific file inside the skill directory ──────────────────────────
    rel = (file_path or "").strip()
    if rel:
        # Containment: reject absolute paths outright; resolve relative ones and
        # confine the result to the skill directory. ``realpath`` collapses
        # ``..`` segments and follows symlinks, so any path escaping the
        # directory (``../secrets``, a symlink pointing out) is caught here.
        if os.path.isabs(rel):
            return json.dumps(
                {"success": False,
                 "error": "file_path must be relative to the skill directory.",
                 "hint": "Use a path like 'references/api.md'."},
                ensure_ascii=False,
            )
        target = os.path.realpath(os.path.join(real_dir, rel))
        real_dir_text = str(real_dir)
        if target != real_dir_text and not target.startswith(real_dir_text + os.sep):
            return json.dumps(
                {"success": False,
                 "error": "file_path escapes the skill directory; it must stay inside it.",
                 "hint": "Use a relative path with no '..' segments or outward symlinks."},
                ensure_ascii=False,
            )
        if not os.path.isfile(target):
            return json.dumps(
                {"success": False,
                 "error": f"File '{rel}' not found in skill '{skill_name}'.",
                 "available_files": _list_skill_files(real_dir),
                 "hint": "Use one of the available file paths listed above."},
                ensure_ascii=False,
            )
        try:
            content = Path(target).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return json.dumps(
                {"success": True, "name": skill_name, "file": rel,
                 "content": f"[Binary file: {os.path.basename(target)}, "
                            f"size: {os.path.getsize(target)} bytes]",
                 "is_binary": True},
                ensure_ascii=False,
            )
        return json.dumps(
            {"success": True, "name": skill_name, "file": rel,
             "content": content, "file_type": Path(target).suffix},
            ensure_ascii=False,
        )

    # ── The skill's main SKILL.md ───────────────────────────────────────────
    linked_files = _list_skill_files(real_dir)
    return json.dumps(
        {"success": True,
         "name": skill_name,
         "description": skill_description,
         "content": main_content,
         "path": str(requested_dir / "SKILL.md"),
         "skill_dir": str(requested_dir),
         "linked_files": linked_files or None,
         "usage_hint": (
             "To view a linked file, call view_skill(skill_dir, file_path) with a "
             "path like 'references/api.md'." if linked_files else None
         )},
        ensure_ascii=False,
    )


async def manage_skills() -> str:
    """Load skill management tools into the next reasoning step.

    Call this when you need to download, import/install, list, enable/disable, or uninstall/remove
    skills. Management tools become available on the next
    observe-think-act round, not in the same model turn as this call.

    Returns:
        A short message naming the tools that will be available next.
    """
    agent = current_agent.get(None)
    ota_ctx = getattr(agent, "ota_ctx", None) if agent is not None else None
    if ota_ctx is None:
        raise RuntimeError("manage_skills can only run inside an agent turn.")
    ota_ctx.skills_tool_loaded = True
    return (
        "Skill management tools are loaded for the next reasoning step.\n\n"
        "New skill tools include:\n"
        "- import_skills: Import/Install skills from a local directory, GitHub URL, or skills.sh page URL, checking conflicts first.\n"
        "- list_skills: List installed skills, either enabled-only or all.\n"
        "- set_skill_enabled: Enable or disable a skill by name.\n"
        "- uninstall_skill: Remove an installed skill by name.\n\n"
        "Continue with the next reasoning step to call them."
    )


async def list_skills(filter: str = "enabled") -> str:
    """List installed skills for the current user.

    Only skills with ``enabled=true`` are available for use. Unless explicitly
    asked otherwise, call this tool with the default ``filter`` value.

    Args:
        filter: ``"enabled"`` lists only enabled skills. ``"all"`` lists enabled
            and disabled skills.

    Returns:
        A JSON string containing ``success`` and ``skills``.
    """
    if filter not in {"enabled", "all"}:
        return _json({
            "success": False,
            "error": "filter must be either 'enabled' or 'all'.",
        })
    user = await get_current_user()
    await SkillLibrary(user.id).sync_builtins()
    rows = await SkillRepository().list_for_user(user.id)
    if filter == "enabled":
        rows = [row for row in rows if row.enabled]
    return _json({
        "success": True,
        "filter": filter,
        "count": len(rows),
        "skills": [_skill_detail(row) for row in rows],
    })


async def set_skill_enabled(name: str, enabled: bool) -> str:
    """Enable or disable an installed skill by skill name.

    Args:
        name: The skill name.
        enabled: Use ``true`` to enable the skill, or ``false`` to disable it.

    Returns:
        A JSON string containing the updated skill, or an error when not found.
    """
    name_error = _skill_name_error(name)
    if name_error:
        return _json({
            "success": False,
            "error": name_error,
            "hint": "Use the skill's name as shown by list_skills(filter='all').",
        })
    skill_name = name.strip()
    user = await get_current_user()
    repo = SkillRepository()
    skill = await repo.get_by_name(user.id, skill_name)
    if skill is None or skill.id is None:
        return _json({
            "success": False,
            "error": f"Skill '{skill_name}' is not installed.",
            "hint": "Call list_skills(filter='all') to see installed skill names.",
        })
    updated = await repo.set_enabled(user.id, id=skill.id, enabled=enabled)
    if updated is None:
        return _json({
            "success": False,
            "error": f"Skill '{skill_name}' is not installed.",
        })
    return _json({"success": True, "skill": _skill_detail(updated)})


async def uninstall_skill(name: str) -> str:
    """Uninstall an installed skill by skill name.

    This removes the skill from the installed-skill catalogue. After uninstalling, 
    it no longer appears in ``list_skills(filter="all")``.

    Args:
        name: The skill name.

    Returns:
        A JSON string describing whether the skill was removed.
    """
    name_error = _skill_name_error(name)
    if name_error:
        return _json({
            "success": False,
            "error": name_error,
            "hint": "Use the skill's name as shown by list_skills(filter='all').",
        })
    skill_name = name.strip()
    user = await get_current_user()
    repo = SkillRepository()
    skill = await repo.get_by_name(user.id, skill_name)
    if skill is None or skill.id is None:
        return _json({
            "success": False,
            "error": f"Skill '{skill_name}' is not installed.",
            "hint": "Call list_skills(filter='all') to see installed skill names.",
        })
    if skill.group == "builtin":
        return _json({
            "success": False,
            "uninstalled": None,
            "message": f"Built-in Skill '{skill_name}' cannot be uninstalled.",
        })
    removed = await repo.delete(user.id, id=skill.id)
    return _json({
        "success": removed,
        "uninstalled": _skill_detail(skill) if removed else None,
        "message": (
            f"Skill '{skill_name}' was uninstalled."
            if removed else f"Skill '{skill_name}' is not installed."
        ),
    })


async def import_skills(
    path: str,
    allow_overwite: Optional[bool] = False,
    skill_name: Optional[str] = None,
) -> str:
    """Import/Install skills from a local directory, GitHub URL, or skills.sh page.

    Scans ``path`` for skill directories containing ``SKILL.md``. ``path`` may
    be an absolute local directory path, a GitHub repository/tree/blob URL, or a
    skills.sh skill page URL. Remote URLs are downloaded to a temporary local
    directory first, then imported through the same local import flow.

    If any same-named installed skill would be overwritten and
    ``allow_overwite`` is false, returns conflict details without importing. If
    there are no conflicts, or ``allow_overwite`` is true, imports the skills
    and overwrites same-named installed skills when needed.

    Args:
        path: Absolute local directory path to scan for skills, a GitHub URL,
            or a skills.sh skill page URL. GitHub URLs may point to a repository
            root, a ``/tree/`` directory, or a ``/blob/.../SKILL.md`` file.
        allow_overwite: OPTIONAL. Defaults to false. When false, stop before
            overwriting same-named installed skills and return conflict details.
            When true, import and overwrite.
        skill_name: OPTIONAL. Defaults to None. When omitted or empty, import all
            scanned skills from ``path``. When provided, import only the scanned skill
            whose name exactly matches this value.

    Returns:
        A JSON string with either conflict-check details or an import summary.
    """
    overwrite_allowed, bool_error = _coerce_optional_bool(
        allow_overwite,
        name="allow_overwite",
    )
    if bool_error:
        return _json({
            "success": False,
            "error": bool_error,
            "hint": "Pass true or false for allow_overwite.",
        })
    allow_overwite = overwrite_allowed

    raw = (path or "").strip()
    if not raw:
        return _json({
            "success": False,
            "error": "path is required.",
            "hint": "Pass an absolute directory path or github.com URL containing one or more skills.",
        })

    # Import lazily to avoid creating a module-load cycle between service
    # handlers and the agent tool registry. GitHub download helpers live with
    # the HTTP import handler so both entry points use the same implementation.
    from ...amphi_service.handler._skills_import_handler import (  # noqa: PLC0415
        SkillImportItem,
        _SkillDownloadError,
        _check_result,
        _download_skill_from_github_url,
        _execute_one,
        _fetch_skills_sh_page_metadata,
        _imported_skill_detail,
        _is_github_url,
        _is_skills_sh_url,
        _plan_import,
        _row_detail,
        _scanned_skill_detail,
        _skills_local_root,
        scan_skills,
    )

    source_override: Optional[str] = None
    source_uri: Optional[str] = None
    requested_skill_name = (skill_name or "").strip()
    if _is_github_url(raw):
        try:
            downloaded = _download_skill_from_github_url(raw)
        except _SkillDownloadError as exc:
            return _json({
                "success": False,
                "error": f"GitHub skill download failed: {exc}",
            })
        scan_root = downloaded.skill_dir
        source_override = SkillSource.GITHUB.value
        source_uri = downloaded.source_uri
    elif _is_skills_sh_url(raw):
        try:
            page_metadata = _fetch_skills_sh_page_metadata(raw)
            if requested_skill_name and skill_name and requested_skill_name != page_metadata.skill_name:
                return _json({
                    "success": False,
                    "error": (
                        "skills.sh page skill name "
                        f"{page_metadata.skill_name!r} does not match requested "
                        f"skill_name {requested_skill_name!r}."
                    ),
                })
            downloaded = _download_skill_from_github_url(page_metadata.repository_url)
        except _SkillDownloadError as exc:
            return _json({
                "success": False,
                "error": f"skills.sh skill download failed: {exc}",
            })
        scan_root = downloaded.skill_dir
        source_override = SkillSource.SKILLS_SH.value
        source_uri = downloaded.source_uri
        requested_skill_name = page_metadata.skill_name
    else:
        if not os.path.isabs(raw):
            return _json({
                "success": False,
                "error": (
                    "Scan path must be absolute, a github.com URL, "
                    f"or a skills.sh URL: {raw!r}."
                ),
            })
        scan_root = Path(raw)
        if not scan_root.is_dir():
            return _json({
                "success": False,
                "error": f"No such directory on the agent host: {raw!r}.",
            })

    def apply_metadata_overrides(detail: dict) -> dict:
        if source_override is not None:
            detail["source"] = source_override
        if source_uri is not None:
            detail["source_uri"] = source_uri
        return detail

    scanned = [_scanned_skill_detail(skill) for skill in scan_skills(scan_root)]
    if requested_skill_name:
        scanned = [
            skill for skill in scanned
            if skill.get("name") == requested_skill_name
        ]
        if not scanned:
            return _json({
                "success": False,
                "error": f"No skill named {requested_skill_name!r} was found under {raw!r}.",
            })
    items = [SkillImportItem.model_validate(item) for item in scanned]
    user = await get_current_user()
    root = _skills_local_root()
    plans = await _plan_import(items, user.id, root)
    check_results = [_check_result(plan) for plan in plans]
    for result in check_results:
        incoming = result.get("incoming")
        if isinstance(incoming, dict):
            apply_metadata_overrides(incoming)
    conflicts = [row for row in check_results if row.get("conflict")]

    if conflicts and not allow_overwite:
        return _json({
            "success": False,
            "status": "conflicts_detected",
            "message": (
                "Import was not executed because same-named installed skills "
                "would be overwritten. Present the conflict details to the "
                "user and let them decide whether to continue, to avoid "
                "serious skill data loss."
            ),
            "total": len(check_results),
            "conflicts": len(conflicts),
            "results": check_results,
        })

    repo = SkillRepository()
    imported_skills: List[dict] = []
    failed_skills: List[dict] = []
    added = overwritten = 0
    for plan in plans:
        try:
            row, action = await _execute_one(plan, user.id, repo)
            if source_override is not None or source_uri is not None:
                updated = await repo.update(
                    user.id,
                    row.id,
                    name=row.name,
                    description=row.description,
                    skill_dir=row.skill_dir,
                    group=row.group,
                    source=source_override if source_override is not None else row.source,
                    source_uri=source_uri if source_uri is not None else row.source_uri,
                )
                if updated is not None:
                    row = updated
        except Exception as exc:  # noqa: BLE001 — mirror API batch behavior
            detail = apply_metadata_overrides(_imported_skill_detail(plan.incoming))
            detail["reason"] = f"{type(exc).__name__}: {exc}"
            failed_skills.append(detail)
            continue
        detail = _row_detail(row)
        detail["action"] = action
        imported_skills.append(detail)
        if action == "overwritten":
            overwritten += 1
        else:
            added += 1

    return _json({
        "success": not failed_skills,
        "status": "import_executed",
        "total": len(plans),
        "succeeded": len(imported_skills),
        "failed": len(failed_skills),
        "added": added,
        "overwritten": overwritten,
        "imported_skills": imported_skills,
        "failed_skills": failed_skills,
    })


view_skill_tool: FunctionToolSpec = FunctionToolSpec.from_raw(view_skill)
manage_skills_tool: FunctionToolSpec = FunctionToolSpec.from_raw(manage_skills)
import_skills_tool: FunctionToolSpec = FunctionToolSpec.from_raw(import_skills)
list_skills_tool: FunctionToolSpec = FunctionToolSpec.from_raw(list_skills)
set_skill_enabled_tool: FunctionToolSpec = FunctionToolSpec.from_raw(set_skill_enabled)
uninstall_skill_tool: FunctionToolSpec = FunctionToolSpec.from_raw(uninstall_skill)

skills_basic_tool_specs = [
    view_skill_tool,
    manage_skills_tool,
]

skills_advanced_tool_specs = [
    import_skills_tool,
    list_skills_tool,
    set_skill_enabled_tool,
    uninstall_skill_tool,
]

skills_tool_specs = [
    *skills_basic_tool_specs,
    *skills_advanced_tool_specs,
]

__all__ = [
    "SKILLS_BASIC_TOOL_NAMES",
    "SKILLS_ADVANCED_TOOL_NAMES",
    "SKILLS_TOOL_NAMES",
    "view_skill",
    "manage_skills",
    "import_skills",
    "list_skills",
    "set_skill_enabled",
    "uninstall_skill",
    "view_skill_tool",
    "manage_skills_tool",
    "import_skills_tool",
    "list_skills_tool",
    "set_skill_enabled_tool",
    "uninstall_skill_tool",
    "skills_basic_tool_specs",
    "skills_advanced_tool_specs",
    "skills_tool_specs",
]
