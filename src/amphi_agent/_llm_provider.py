from typing import Any, Dict, Mapping, Optional

from ..amphi_store import ProviderRepository


class LlmProvider:
    """Agent-facing view of the selected model's provider configuration.

    The object owns the Store lookup needed to resolve model metadata, keeping
    persistence details outside Invocation assembly and cognitive workers.
    """

    def __init__(self, user_id: Optional[str] = None, model_id: Optional[str] = None, model_limits: Optional[Mapping[str, Any]] = None) -> None:
        self._user_id = user_id
        self._repo = ProviderRepository()
        self.model_id = model_id or ""
        self.model_limits = dict(model_limits or {})

    async def load(self) -> "LlmProvider":
        """Load this model's limits from the user's active provider."""
        if self._user_id is None:
            self.model_limits = {}
            return self
        providers = await self._repo.list_for_user(self._user_id)
        active = next((provider for provider in providers if provider.is_active), None)
        self.model_limits = dict(
            (active.model_limits or {}).get(self.model_id, {})
            if active is not None else {}
        )
        return self

    def input_capacity(self) -> Optional[int]:
        """Return the prompt budget after reserving the output ceiling."""
        def positive_int(name: str) -> int:
            try:
                return max(0, int(self.model_limits.get(name) or 0))
            except (TypeError, ValueError):
                return 0

        input_limit = positive_int("input")
        if input_limit > 0:
            return input_limit
        context_limit = positive_int("context")
        output_limit = positive_int("output")
        if context_limit <= 0:
            return None
        remaining = context_limit - output_limit if output_limit > 0 else context_limit
        return remaining if remaining > 0 else None


__all__ = ["LlmProvider"]
