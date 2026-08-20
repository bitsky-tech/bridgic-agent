from datetime import datetime
from typing import List, Optional

from sqlalchemy import Column, UniqueConstraint
from sqlmodel import Field, SQLModel

from ._base import JsonType, Repository
from ._user import _utcnow


class ProviderCredential(SQLModel, table=True):
    __tablename__ = "provider_credentials"
    __table_args__ = (
        UniqueConstraint("user_id", "provider_id", name="uq_provider_per_user"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    # provider_id is now any user-chosen slug; the catalog (see
    # ``protocol/_providers_catalog.py``) acts only as a UI prefill source
    # and no longer constrains POST /me/providers (the catalog was once a 400 gate).
    provider_id: str = Field(description="User-chosen slug; catalog entries reuse their id but custom channels are free-form.")
    auth_mode: str = Field(description="'api_key' | 'oauth'.")
    api_key: Optional[str] = Field(default=None)
    base_url: Optional[str] = Field(default=None)
    is_active: bool = Field(default=False)
    # NEW (Phase 2.5): user-controlled enable flag. Disabled channels are
    # hidden from the chat picker AND skipped by ``set_active`` (the
    # next-active election prefers enabled rows). Distinct from
    # ``is_active`` (which is "globally selected for chat right now") and
    # from row existence (deleting drops the credentials; disabling keeps
    # them so the user can re-enable later without re-entering the key).
    is_enabled: bool = Field(default=True)
    # NEW (Phase 2): which wire protocol the active LLM client should speak.
    # Consumed by ``build_llm`` dispatch (OpenAI Chat Completions vs Anthropic
    # Messages). Mirrored onto the User row when this credential is active.
    protocol: str = Field(default="openai", description="'openai' | 'anthropic'")
    # NEW (Phase 2): user-given channel name; falls back to provider_id for
    # display when None. Lets two configured channels share a provider_id slug
    # is forbidden (UniqueConstraint) but lets users rename "openai" → "Azure GPT-4o".
    display_name: Optional[str] = Field(default=None, description="User-given name; None falls back to provider_id.")
    # NEW (Phase 2): JSON-encoded whitelist of model ids the user wants exposed
    # to the picker. Empty list = no models = provider doesn't appear in picker.
    # The catalog's models[] is only a prefill source; once saved, this column
    # is the single source of truth.
    enabled_models: List[str] = Field(
        default_factory=list,
        sa_column=Column(JsonType),
        description="Picker whitelist of model ids.",
    )
    created_at: datetime = Field(default_factory=_utcnow)


class ProviderRepository(Repository[ProviderCredential]):
    """Per-user provider credentials; all methods ownership-scoped by user."""

    async def upsert(
        self,
        user_id: str,
        provider_id: str,
        *,
        auth_mode: str,
        api_key: Optional[str],
        base_url: Optional[str],
        protocol: Optional[str] = None,
        display_name: Optional[str] = None,
        models: Optional[List[str]] = None,
    ) -> ProviderCredential:
        """Insert or update one provider credential; return the row.

        On update only non-``None`` arguments overwrite the stored value
        (so a re-POST without a key doesn't wipe it); ``auth_mode`` always
        overwrites. ``is_active`` is preserved.

        ``protocol`` / ``display_name`` / ``models`` are Phase-2 additions:
        - ``protocol``: None preserves existing; insert defaults to "openai".
        - ``display_name``: None preserves existing; nullable column so users
          can clear via explicit "".
        - ``models``: None preserves existing; insert defaults to [] (the
          ``enabled_models`` column stores the list directly).
        """
        async with self._session() as s:
            row = await self._get_by(
                s, ProviderCredential, user_id=user_id, provider_id=provider_id,
            )
            if row is None:
                row = ProviderCredential(
                    user_id=user_id,
                    provider_id=provider_id,
                    auth_mode=auth_mode,
                    api_key=api_key,
                    base_url=base_url,
                    protocol=protocol or "openai",
                    display_name=display_name,
                    enabled_models=models or [],
                )
                s.add(row)
            else:
                row.auth_mode = auth_mode
                if api_key is not None:
                    row.api_key = api_key
                if base_url is not None:
                    row.base_url = base_url
                if protocol is not None:
                    row.protocol = protocol
                if display_name is not None:
                    row.display_name = display_name
                if models is not None:
                    row.enabled_models = models
            await s.commit()
            await s.refresh(row)
            return row

    async def clear_base_url(self, user_id: str, provider_id: str) -> None:
        """Explicitly NULL a row's ``base_url``.

        ``upsert`` treats ``base_url=None`` as "preserve" (so a re-POST without
        a url doesn't wipe it), which means a mode switch that must FORGET the
        old url needs this explicit call — e.g. api_key → Codex subscription,
        where the api_key-era ``https://api.openai.com/v1`` would otherwise
        survive and route Codex traffic to the wrong host.
        """
        async with self._session() as s:
            row = await self._get_by(
                s, ProviderCredential, user_id=user_id, provider_id=provider_id,
            )
            if row is not None and row.base_url is not None:
                row.base_url = None
                await s.commit()

    async def list_for_user(self, user_id: str) -> List[ProviderCredential]:
        """Return every provider credential owned by ``user_id``, oldest first."""
        async with self._session() as s:
            return await self._list_owned(
                s, ProviderCredential, user_id,
                order_by=ProviderCredential.created_at,
            )

    async def set_active(
        self, user_id: str, provider_id: str
    ) -> Optional[ProviderCredential]:
        """Mark one provider active (clearing the others); return that row.

        Returns ``None`` when the user has not configured ``provider_id``
        OR when the target provider is currently disabled — the handler
        maps both to 404 with a hint to enable / re-add first. Disallowing
        activation of disabled rows keeps the chat path's invariant
        ``active → enabled`` true without a second guard at chat time.
        """
        async with self._session() as s:
            rows = await self._list_owned(s, ProviderCredential, user_id)
            target = next((r for r in rows if r.provider_id == provider_id), None)
            if target is None or not target.is_enabled:
                return None
            for row in rows:
                row.is_active = row.provider_id == provider_id
            await s.commit()
            await s.refresh(target)
            return target

    async def clear_active(self, user_id: str) -> None:
        """Clear ``is_active`` on every one of this user's providers.

        Used when the active provider is disabled and no replacement can be
        promoted: leaving a *disabled* row still flagged ``is_active`` is the
        inconsistency that silently drifts the User-row credential mirror (the
        picker reads provider_credentials and shows the model as usable, while
        chat reads the stale User row and 503s). After this there is no active
        provider — the frontend self-heal (or an explicit ``POST
        /me/active-model``) picks one up.
        """
        async with self._session() as s:
            rows = await self._list_owned(s, ProviderCredential, user_id)
            for row in rows:
                row.is_active = False
            await s.commit()

    async def set_enabled(
        self, user_id: str, provider_id: str, enabled: bool,
    ) -> Optional[ProviderCredential]:
        """Flip ``is_enabled`` on one provider; return the row (or None on 404).

        Side-effects the handler is responsible for:
          - **Disabling the active row** → caller must clear the User-row
            credential mirror (so chat doesn't keep using a key the user
            just paused) AND pick a replacement active provider from the
            remaining enabled rows.
          - **Enabling a previously disabled row** has no automatic
            promotion — the user can ``POST /me/active-model`` to take it.
        """
        async with self._session() as s:
            row = await self._get_by(
                s, ProviderCredential, user_id=user_id, provider_id=provider_id,
            )
            if row is None:
                return None
            row.is_enabled = enabled
            await s.commit()
            await s.refresh(row)
            return row

    async def first_enabled_other(
        self, user_id: str, exclude_provider_id: str,
    ) -> Optional[ProviderCredential]:
        """Find the next usable provider to promote to active.

        Used by the handler when the currently-active provider gets disabled
        or deleted and the chat path needs a fallback. Picks oldest-first
        (matches ``list_for_user`` order so the result is deterministic from
        the user's perspective).

        "Usable" = enabled AND drivable without further setup: either it
        carries an ``api_key``, OR it is an OAuth channel (``auth_mode ==
        'oauth'`` — a Codex subscription whose creds live in ~/.codex, which
        ``build_llm`` / ``require_ai`` both run with no api_key). Excluding
        OAuth channels here was the bug that dropped the user to "configure a model first"
        after deleting the last api_key provider while a Codex subscription
        remained.
        """
        async with self._session() as s:
            rows = await self._list_owned(
                s, ProviderCredential, user_id,
                order_by=ProviderCredential.created_at,
            )
            for r in rows:
                if (r.provider_id != exclude_provider_id
                        and r.is_enabled
                        and (r.api_key or r.auth_mode == "oauth")):
                    return r
            return None

    async def delete(self, user_id: str, provider_id: str) -> Optional[bool]:
        """Delete one provider credential; ownership-gated.

        Returns the deleted row's ``is_active`` flag so the handler can
        clear the mirrored User credentials when the *active* provider is
        removed. Returns ``None`` when nothing matched (→ 404).
        """
        async with self._session() as s:
            row = await self._get_by(
                s, ProviderCredential, user_id=user_id, provider_id=provider_id,
            )
            if row is None:
                return None
            was_active = bool(row.is_active)
            await s.delete(row)
            await s.commit()
            return was_active


__all__ = ["ProviderCredential", "ProviderRepository"]
