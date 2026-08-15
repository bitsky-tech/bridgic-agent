from fastapi import HTTPException, Response, status

from ..protocol import ToggleSkillRequest
from ...amphi_store import Skill, SkillRepository
from ._base import BaseHandler


def _detail(skill: Skill) -> dict:
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


class SkillsHandler(BaseHandler):
    """Bind: ``GET /skills`` (list)."""

    tags = ["skills"]

    async def get(self) -> Response:
        user = await self.require_user()
        skills = await SkillRepository().list_for_user(user.id)
        return self.response([_detail(s) for s in skills])


class SkillItemHandler(BaseHandler):
    """Bind: ``GET /skill/{skill_id}``, ``DELETE /skill/{skill_id}``."""

    tags = ["skills"]

    async def get(self, skill_id: int) -> Response:
        user = await self.require_user()
        skill = await SkillRepository().get(user.id, id=skill_id)
        if skill is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Skill {skill_id!r} is not installed.",
            )
        return self.response(_detail(skill))

    async def delete(self, skill_id: int) -> Response:
        user = await self.require_user()
        repo = SkillRepository()
        skill = await repo.get(user.id, id=skill_id)
        if skill is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Skill {skill_id!r} is not installed.",
            )
        if skill.group == "builtin":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Built-in Skill {skill.name!r} cannot be deleted.",
            )
        await repo.delete(user.id, id=skill_id)
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


class SkillToggleHandler(BaseHandler):
    """Bind: ``POST /skill/{skill_id}/toggle`` — flip ``enabled``.

    Body is ``{enabled: bool}``. Returns the updated skill (404 when the
    skill is not installed for this user).
    """

    tags = ["skills"]

    async def post(self, skill_id: int, body: ToggleSkillRequest) -> Response:
        user = await self.require_user()
        skill = await SkillRepository().set_enabled(
            user.id, id=skill_id, enabled=body.enabled,
        )
        if skill is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Skill {skill_id!r} is not installed.",
            )
        return self.response(_detail(skill))


__all__ = ["SkillsHandler", "SkillItemHandler", "SkillToggleHandler"]
