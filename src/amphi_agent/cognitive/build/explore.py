"""Cognitive worker for exploring a Workflow Build implementation plan."""

from typing import TYPE_CHECKING, Dict, List, Optional

from bridgic.amphibious import StepToolCall
from bridgic.core.model.types import Message, Role

from ...security import Permission
from ..register import cognitive_stage
from .base import BuildThink
from ..._context import AmphiContext, AmphiOTAContext, _view
from ..state import CallVerdict
from ..._skills import Skill, SkillGroup
from ...prompts.build.explore import EXPLORE_PERSONA


if TYPE_CHECKING:
    from ..._agent import AmphiAgent


@cognitive_stage(mode="build", stage="explore", order=20)
class ExploreThink(BuildThink):
    """Explore and record this build's implementation plan."""

    persona: str = EXPLORE_PERSONA

    ############################################################################
    # Dynamic prompt assembly
    ############################################################################
    async def assemble_messages(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> List[Message]:
        """Assemble explore's model messages.

        Parameters
        ----------
        ota_context : AmphiOTAContext
            Active build turn and its current action trace.
        context : AmphiContext
            Session context for this Build turn.

        Returns
        -------
        List[Message]
            Persona, live context, Session history, task artifact, user input,
            and the current Explore trace.
        """
        ota_context.tools = list(self.select_tools(ota_context, context))
        blocks = await self.build_context_blocks(
            ota_context,
            context,
            "task.md",
        )
        umbrella = "<context>\n" + "\n\n".join(block for block in blocks if block) + "\n</context>"
        system = "\n\n".join(block for block in (
            self.system_block(ota_context, context), umbrella,
        ) if block)

        turn_context, _ = self._stage_turn_context(
            ota_context,
            "build",
            "explore",
        )

        messages = [Message.from_text(system, role=Role.SYSTEM)]
        messages += await self.session_messages_block(ota_context, context)
        messages.append(await self.current_user_message(ota_context, context))
        messages += self.turn_messages_block(turn_context, context)
        return messages

    ############################################################################
    # Tools and Skills selection
    ############################################################################
    def select_skills(
        self,
        ota_context: AmphiOTAContext,
        context: AmphiContext,
    ) -> Dict[str, Skill]:
        """Select enabled Skills plus the Explore-only built-in ``how-to``."""
        selected = super().select_skills(ota_context, context)
        skills = context.skills
        how_to = skills.all_data().get("how-to") if skills is not None else None
        if how_to is not None and how_to.group is SkillGroup.BUILTIN:
            selected["how-to"] = how_to
        return selected

    ############################################################################
    # Helpers
    ############################################################################
    async def _check_action_legality(self, ota_context: Optional[AmphiOTAContext], context: AmphiContext, calls: List[StepToolCall], verdicts: List[CallVerdict], agent: "AmphiAgent") -> List[CallVerdict]:
        """Apply inherited admission rules, then this worker's business constraints."""
        resolved = await super()._check_action_legality(ota_context, context, calls, verdicts, agent)

        def reason_for_call(call: StepToolCall) -> Optional[str]:
            if getattr(call, "tool", None) != "switch":
                return None

            target_stage = next(
                (
                    _view(argument, "value")
                    for argument in reversed(getattr(call, "tool_arguments", None) or [])
                    if _view(argument, "name") == "stage"
                ),
                None,
            )
            if target_stage != "generate":
                return None
            package = self.build_package(context)
            body = package.read_document("explore.md") if package is not None else None
            if body:
                reason = self.human_document_reason("explore.md", body)
                return f"switch rejected: {reason}" if reason else None
            return (
                "switch rejected: write explore.md before handing off to "
                "generate; it is the operation sequence generate builds from. Create "
                "explore.md now as a complete, non-empty file, then call switch "
                "again."
            )

        for index, (call, verdict) in enumerate(zip(calls, resolved)):
            if verdict.verdict == Permission.DENY.value:
                continue
            reason = reason_for_call(call)
            if reason:
                resolved[index] = verdict.model_copy(update={
                    "verdict": Permission.DENY.value,
                    "reason": reason,
                })
        return resolved
