from fastapi import HTTPException, Response, status

from ..protocol import (
    CreateMemoryRequest,
    CredentialsRequest,
    SetExecutionModeRequest,
    SetModelRequest,
)
from ...amphi_store import Memory, MemoryRepository, User, UserRepository
from ._base import BaseHandler


class MeProfileHandler(BaseHandler):
    """Bind: ``GET /me`` — read-only profile of the current user."""

    tags = ["me"]

    async def get(self) -> Response:
        user = await self.require_user()
        return self.response(me_profile(user))


class MeCredentialsHandler(BaseHandler):
    """Bind: ``GET /me/credentials`` (status) and ``POST`` (update).

    Sensitive: the ``api_key`` is never echoed back; the response only
    carries a boolean ``api_key_set`` flag.
    """

    tags = ["me"]

    async def get(self) -> Response:
        user = await self.require_user()
        return self.response(
            {
                "api_key_set": bool(user.api_key),
                "base_url": user.base_url,
            }
        )

    async def post(self, body: CredentialsRequest) -> Response:
        """Update the current user's credentials.

        Empty / missing fields leave the corresponding value untouched
        (clients can rotate ``api_key`` without disturbing ``base_url``
        and vice versa). After commit, every cached LLM client owned by
        this user is invalidated so the next chat picks up the new creds
        without a daemon restart.
        """
        user = await self.require_user()
        updated = await UserRepository().set_credentials(
            user.id, api_key=body.api_key, base_url=body.base_url,
        )
        if updated is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=(
                    f"User row {user.id!r} missing — daemon "
                    "startup did not seed correctly."
                ),
            )
        await self.llms.invalidate_user(user.id)
        return self.response(
            {
                "api_key_set": bool(updated.api_key),
                "base_url": updated.base_url,
            }
        )


class MeModelHandler(BaseHandler):
    """Bind: ``GET /me/model`` (read) and ``POST /me/model`` (update).

    Model is a **user** attribute (not session-scoped).
    """

    tags = ["me"]

    async def get(self) -> Response:
        user = await self.require_user()
        return self.response({"model": user.current_model})

    async def post(self, body: SetModelRequest) -> Response:
        user = await self.require_user()
        updated = await UserRepository().set_model(user.id, body.model)
        if updated is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"User row {user.id!r} missing.",
            )

        # Soft pre-warm: build the LLM client now so the next chat starts
        # without a build delay — but only when an api_key is configured.
        # Without one we just record the choice; the next chat 503s via
        # ``require_ai`` until creds are set.
        if user.api_key:
            await self.llms.resolve(user, body.model)

        return self.response({"model": body.model})


class MeExecutionModeHandler(BaseHandler):
    """Bind: ``GET /me/execution-mode`` (read) and ``POST`` (update).

    The execution mode is a **user** attribute (global, across sessions) controlling how
    tightly tool permissions are gated: 'request' (ask for approval) | 'auto' (approve on
    my behalf) | 'full' (full access).
    """

    tags = ["me"]

    async def get(self) -> Response:
        user = await self.require_user()
        return self.response({"mode": user.execution_mode})

    async def post(self, body: SetExecutionModeRequest) -> Response:
        user = await self.require_user()
        updated = await UserRepository().set_execution_mode(user.id, body.mode)
        if updated is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"User row {user.id!r} missing.",
            )
        return self.response({"mode": body.mode})


class MeMemoryListHandler(BaseHandler):
    """Bind: ``GET /me/memories`` (list) and ``POST /me/memories`` (create).

    Storage only — no auto-extraction, no indexing (see module docstring).
    """

    tags = ["me"]

    async def get(self) -> Response:
        user = await self.require_user()
        rows = await MemoryRepository().list_for_user(user.id)
        return self.response([_memory_to_row(r) for r in rows])

    async def post(self, body: CreateMemoryRequest) -> Response:
        user = await self.require_user()
        new = await MemoryRepository().create(
            user.id, content=body.content, source=body.source,
        )
        return self.response(
            _memory_to_row(new), status_code=status.HTTP_201_CREATED,
        )


class MeMemoryItemHandler(BaseHandler):
    """Bind: ``DELETE /me/memories/{memory_id}``."""

    tags = ["me"]

    async def delete(self, memory_id: int) -> Response:
        user = await self.require_user()
        # 404 on both "no such id" and "owned by another user" (the repo's
        # ownership gate returns False either way) to avoid info leak.
        if not await MemoryRepository().delete(memory_id, user.id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Memory {memory_id!r} not found.",
            )
        return self.response(status_code=status.HTTP_204_NO_CONTENT)


# Module helpers
def me_profile(user: User) -> dict:
    """Map a ``User`` row to the ``/me`` wire view.

    Shared by ``GET /me`` and the providers ``active-model`` response so
    the field mapping (notably ``api_key_set = bool(api_key)``) lives in
    one place.

    Phase 2 addition: ``protocol`` carries which LLM wire family the
    factory will dispatch to on the next chat (mirrored from the active
    provider). Defaults to ``"openai"`` on legacy rows that pre-date the
    column.
    """
    return {
        "id": user.id,
        "display_name": user.display_name,
        "current_model": user.current_model,
        "base_url": user.base_url,
        "default_max_rounds": user.default_max_rounds,
        "default_temperature": user.default_temperature,
        "api_key_set": bool(user.api_key),
        "protocol": getattr(user, "protocol", "openai"),
        "execution_mode": getattr(user, "execution_mode", "auto"),
    }


def _memory_to_row(memory: Memory) -> dict:
    # ``memory.id`` is always populated by the time we get here — list
    # queries return persisted rows; POST flows refresh after commit.
    # If a caller ever hands us an unpersisted instance, this assert
    # surfaces the bug instead of silently emitting a null ``id``.
    assert memory.id is not None, "memory row must be persisted before shaping"
    return {
        "id": memory.id,
        "content": memory.content,
        "source": memory.source,
        "created_at": memory.created_at.isoformat(),
    }


__all__ = [
    "MeProfileHandler",
    "MeCredentialsHandler",
    "MeModelHandler",
    "MeExecutionModeHandler",
    "MeMemoryListHandler",
    "MeMemoryItemHandler",
    "me_profile",
]
