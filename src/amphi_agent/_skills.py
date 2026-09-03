from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from bridgic.core.agentic.tool_specs import FunctionToolSpec, ToolSpec

from ..amphi_store import SkillRepository


class SkillGroup(str, Enum):
    SELF_CREATED = "self_created"
    IMPORTED = "imported"
    BUILTIN = "builtin"


class SkillSource(str, Enum):
    GITHUB = "github"
    SKILLS_SH = "skills.sh"
    CLAWHUB = "clawhub"
    LOCAL = "local"


@dataclass(frozen=True)
class Skill:
    """One named, on-demand capability — immutable."""

    skill_id: int
    name: str
    description: str
    skill_dir: str
    group: SkillGroup
    source: SkillSource
    source_uri: str
    enabled: bool = True
    updated_at: Optional[datetime] = None


class SkillLibrary:
    """``AmphiContext.skills`` — store-backed catalogue + the load tool.

    Built with a ``user_id``; :meth:`load` pulls the user's installed skills
    from the store. ``MainThink.skills_block`` advertises their name, one-line
    description, and absolute location for path-based ``view_skill`` access;
    :meth:`as_tools` exposes the legacy ``load_skill`` adapter.
    """

    _BUILTIN_ROOT = Path(__file__).resolve().parent / "builtin_skills"

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id
        self._repo = SkillRepository()
        self._skills: Dict[str, Skill] = {}

    @classmethod
    def builtin_names(cls) -> tuple[str, ...]:
        """Discover the product-owned Skill packages shipped with the app."""
        return tuple(sorted(
            child.name
            for child in cls._BUILTIN_ROOT.iterdir()
            if child.is_dir()
            and not child.is_symlink()
            and (child / "SKILL.md").is_file()
        ))

    @classmethod
    def _builtin_definition(cls, name: str) -> dict[str, Any]:
        """Read one packaged Skill's authoritative name and description."""
        skill_dir = cls._BUILTIN_ROOT / name
        skill_path = skill_dir / "SKILL.md"
        content = skill_path.read_text(encoding="utf-8")
        lines = content.splitlines()
        if not lines or lines[0].strip() != "---":
            raise ValueError(f"Built-in Skill {name!r} has no YAML frontmatter.")
        closing = next(
            (index for index in range(1, len(lines)) if lines[index].strip() == "---"),
            None,
        )
        if closing is None:
            raise ValueError(f"Built-in Skill {name!r} has unclosed YAML frontmatter.")
        metadata = yaml.safe_load("\n".join(lines[1:closing]))
        if not isinstance(metadata, dict):
            raise ValueError(f"Built-in Skill {name!r} frontmatter must be a mapping.")
        declared_name = str(metadata.get("name") or "").strip()
        description = str(metadata.get("description") or "").strip()
        if declared_name != name:
            raise ValueError(
                f"Built-in Skill directory {name!r} declares name {declared_name!r}.",
            )
        if not description:
            raise ValueError(f"Built-in Skill {name!r} has no description.")
        return {
            "name": name,
            "description": description,
            "skill_dir": str(skill_dir),
            "source": SkillSource.LOCAL.value,
            "source_uri": f"builtin://{name}",
        }

    async def sync_builtins(self) -> None:
        """Idempotently reconcile product-owned Skills for this user."""
        names = self.builtin_names()
        for name in names:
            definition = self._builtin_definition(name)
            await self._repo.ensure_builtin(self._user_id, **definition)
        await self._repo.remove_missing_builtins(self._user_id, set(names))

    async def load(self) -> "SkillLibrary":
        """Load the user's Skill catalogue from the store (best-effort), returning
        ``self`` so an invocation can load the catalogue during context setup.

        Maps each store row onto an agent :class:`Skill` (metadata only — the
        store persists no body yet, so loading a skill's body is a later step).

        Every row is retained in the invocation snapshot. Think workers choose
        their own visible projection from :meth:`data` and :meth:`all_data`;
        ``SkillLibrary`` does not contain stage-specific selection policy.
        """
        try:
            await self.sync_builtins()
            rows = await self._repo.list_for_user(self._user_id)
            self._skills = {
                row.name: Skill(
                    skill_id=row.id,
                    name=row.name,
                    description=row.description or row.name,
                    skill_dir=row.skill_dir or "",
                    group=SkillGroup(row.group) if row.group else SkillGroup.IMPORTED,
                    source=SkillSource(row.source) if row.source else SkillSource.GITHUB,
                    source_uri=row.source_uri or "",
                    enabled=row.enabled,
                    updated_at=row.updated_at,
                )
                for row in rows
            }
        except Exception:  # noqa: BLE001 — skills are an enhancement, never fail a turn
            self._skills = {}
        return self

    def is_empty(self) -> bool:
        """True when no skills are registered."""
        return not self.data()

    def data(self) -> Dict[str, Skill]:
        """Return the enabled Skills available to a normal Think worker."""
        return {
            name: skill
            for name, skill in self._skills.items()
            if skill.enabled
        }

    def all_data(self) -> Dict[str, Skill]:
        """Return all installed Skills for worker-owned selection policy."""
        return dict(self._skills)

    def as_tools(self) -> List[ToolSpec]:
        """The skill tools the OTA loop carries this turn (load on demand)."""
        skills = self.data()
        if not skills:
            return []
        return [self._load_tool()]

    def _load_tool(self) -> ToolSpec:
        skills = self.data()

        async def load_skill(name: str) -> str:
            """Load the full instructions for a named skill from the catalogue.

            Call this once you have decided a catalogued skill is relevant —
            it returns the skill's body so you can follow it.

            Args:
                name: The skill's name, exactly as shown in the catalogue.

            Returns:
                The skill's body, or an error listing the available names.
            """
            skill = skills.get(name)
            if skill is None:
                available = ", ".join(skills) or "(none)"
                return f"Error: no skill named {name!r}. Available: {available}"
            return f"(skill {name!r} is file-backed; read its directory: {skill.skill_dir})"

        return FunctionToolSpec.from_raw(load_skill)


__all__ = ["Skill", "SkillGroup", "SkillSource", "SkillLibrary"]
