from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel

from ._base import Repository


def _utcnow() -> datetime:
    """``datetime.utcnow()`` replacement (deprecated in Py 3.12+)."""
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: str = Field(primary_key=True, description="Stable identity key (e.g. 'local').")
    display_name: Optional[str] = Field(default=None)

    # AI provider credentials + preferences (per-user)
    api_key: Optional[str] = Field(default=None)
    base_url: Optional[str] = Field(default=None)
    current_model: str = Field(description="The model used when the user submits a chat.")
    default_max_rounds: int = Field(default=50)
    default_temperature: float = Field(default=0.0)
    # NEW (Phase 2): which wire protocol the active LLM client should speak.
    # Mirrored from the active ``ProviderCredential.protocol`` so the
    # ``build_llm`` factory can dispatch to OpenAILlm vs AnthropicLlm without
    # reaching back into provider_credentials on every call (keeps the User
    # row a self-sufficient credentials snapshot, matching api_key/base_url).
    protocol: str = Field(default="openai", description="'openai' | 'anthropic'")
    # Tool-permission execution mode (global, across sessions): 'request' (ask for
    # approval) | 'auto' (approve on my behalf) | 'full' (full access). Defaults to auto.
    execution_mode: str = Field(default="auto", description="'request' | 'auto' | 'full'")

    created_at: datetime = Field(default_factory=_utcnow)


class UserRepository(Repository[User]):
    """Per-identity user rows: load + the field-scoped mutations.

    ``User`` is the *owner* of other resources, so it has no ``user_id``
    column — these use a plain primary-key ``get`` rather than the base's
    ownership-gated helpers. The two credential-update methods keep
    **distinct** policies on purpose (:meth:`set_credentials` patches only
    truthy values; :meth:`set_active_provider` overwrites unconditionally).
    """

    async def load(self, user_id: str) -> Optional[User]:
        """Return the user row (detached), or ``None`` if missing."""
        async with self._session() as s:
            return await s.get(User, user_id)

    async def set_model(self, user_id: str, model: str) -> Optional[User]:
        """Set ``current_model``; ``None`` if the user row is missing."""
        async with self._session() as s:
            user = await s.get(User, user_id)
            if user is None:
                return None
            user.current_model = model
            await s.commit()
            return user

    async def set_execution_mode(self, user_id: str, mode: str) -> Optional[User]:
        """Set the tool-permission ``execution_mode``; ``None`` if the row is missing."""
        async with self._session() as s:
            user = await s.get(User, user_id)
            if user is None:
                return None
            user.execution_mode = mode
            await s.commit()
            return user

    async def set_credentials(
        self, user_id: str, *, api_key: Optional[str], base_url: Optional[str],
    ) -> Optional[User]:
        """Patch credentials, overwriting **only truthy** values.

        The ``/me/credentials`` policy: rotate ``api_key`` without
        disturbing ``base_url`` and vice versa. ``None`` if the row is
        missing.
        """
        async with self._session() as s:
            user = await s.get(User, user_id)
            if user is None:
                return None
            if api_key:
                user.api_key = api_key
            if base_url:
                user.base_url = base_url
            await s.commit()
            return user

    async def set_active_provider(
        self, user_id: str, *, api_key: Optional[str], base_url: Optional[str],
        protocol: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Optional[User]:
        """Mirror the active provider's creds onto the user row.

        Unlike :meth:`set_credentials` this overwrites **unconditionally**
        (including clearing to ``None`` when the active provider is
        removed) and optionally sets ``current_model``. ``None`` if the row
        is missing.

        ``protocol`` (Phase-2): when given, mirror the new active provider's
        protocol. When ``None``, leaves the existing value alone (avoid
        forcing handlers to think about it during partial updates). When
        clearing the active provider (api_key=None), pass protocol="openai"
        explicitly to reset the default.
        """
        async with self._session() as s:
            user = await s.get(User, user_id)
            if user is None:
                return None
            user.api_key = api_key
            user.base_url = base_url
            if model is not None:
                user.current_model = model
            if protocol is not None:
                user.protocol = protocol
            await s.commit()
            return user

    async def ensure_seeded(self, user_id: str) -> None:
        """Create the local user without selecting or configuring a model."""
        async with self._session() as s:
            user = await s.get(User, user_id)
            if user is None:
                s.add(User(id=user_id, current_model=""))
            await s.commit()


__all__ = ["User", "UserRepository"]
