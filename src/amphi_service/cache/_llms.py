from typing import Tuple

from bridgic.llms.openai import OpenAILlm

from ...amphi_store import User
from ..protocol.llms import build_llm
from ._base import Registry


class LlmCache(Registry[Tuple[str, str], OpenAILlm]):
    """Cache of :class:`OpenAILlm` clients keyed by ``(user_id, model)``."""

    async def resolve(self, user: User, model: str) -> OpenAILlm:
        """Return the cached client for ``(user, model)``; build on miss.

        Delegates to :meth:`Registry.get_or_create`, which builds under the
        lock so concurrent misses share the one client. ``build_llm`` is
        synchronous, so holding the lock across it is cheap.
        """
        return await self.get_or_create(
            (user.id, model), lambda: build_llm(user, model),
        )

    async def invalidate_user(self, user_id: str) -> None:
        """Drop every cached client owned by ``user_id``.

        Called after a user rotates their credentials so the next
        ``resolve`` rebuilds with the new creds.
        """
        await self.drop_where(lambda key, _client: key[0] == user_id)


__all__ = ["LlmCache"]
