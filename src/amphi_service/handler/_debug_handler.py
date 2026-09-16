import asyncio
import json
from typing import Any

from bridgic.core.model.types import Message, Tool
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ._base import BaseHandler
from ..protocol._schemas import GetSessionPromptRequest
from ...amphi_store import DebugModelRunRepository, ProviderRepository, SessionTurnRepository
from ...amphi_store._debug_run import debug_fingerprint


class DebugRunSource(GetSessionPromptRequest):
    revision: str = Field(min_length=1)


class DebugLlmRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str = Field(min_length=1)
    provider_id: str | None = Field(alias="providerId")
    protocol: str
    messages: list[Message] = Field(min_length=1)
    tools: list[Tool] = Field(default_factory=list)
    extra_body: dict[str, Any] = Field(default_factory=dict, alias="extraBody")

    @field_validator("messages", mode="before")
    @classmethod
    def messages_with_content(cls, values: Any) -> Any:
        if not isinstance(values, list):
            return values
        converted = []
        for value in values:
            if isinstance(value, dict) and "content" in value:
                if "blocks" in value or not isinstance(value["content"], str) or set(value) - {"role", "content", "extras"}:
                    raise ValueError("Structured messages must use native blocks and extras")
                message = Message.from_text(value["content"], role=value.get("role", "user"))
                converted.append({**message.model_dump(mode="json"), "extras": value.get("extras", {})})
            else:
                if isinstance(value, dict) and ("blocks" not in value or set(value) - {"role", "blocks", "extras"}):
                    raise ValueError("Messages require native blocks; unknown message fields belong in extras")
                converted.append(value)
        return converted

    @field_validator("extra_body")
    @classmethod
    def semantic_options_only(cls, value: dict[str, Any]) -> dict[str, Any]:
        if set(value) & {"model", "messages", "input", "instructions", "tools", "stream", "api_key", "headers", "base_url"}:
            raise ValueError("Request identity, messages and tools cannot be overridden through extraBody")
        return value


class CreateDebugLlmRun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_request_id: str = Field(alias="clientRequestId", min_length=1, max_length=128)
    source: DebugRunSource
    request: DebugLlmRequest


class DebugLlmRunsHandler(BaseHandler):
    tags = ["debug"]

    async def post(self, session_id: str, body: CreateDebugLlmRun):
        user = await self.require_user()
        await self.require_session(session_id, user)
        self.require_ai(user)
        self.require_no_running_turn(session_id)
        turn = await SessionTurnRepository().get(user.id, body.source.turn_id)
        if turn is None or turn.session_id != session_id:
            raise HTTPException(404, "The source Turn does not belong to this Session")
        records = turn.ota_records or []
        if body.source.round_index >= len(records):
            raise HTTPException(422, "The source round is unavailable")
        record = records[body.source.round_index]
        scope = record.get("think_scope") or {}
        if scope.get("mode") != body.source.mode or scope.get("stage") != body.source.stage:
            raise HTTPException(422, "The source mode and stage do not match")
        if debug_fingerprint(record) != body.source.revision:
            raise HTTPException(409, "This round changed; assemble its request again")
        providers = await ProviderRepository().list_for_user(user.id)
        provider = next((item for item in providers if item.is_active), None)
        if body.request.protocol != user.protocol or body.request.provider_id != (provider.provider_id if provider else None):
            raise HTTPException(409, "The active provider changed; assemble the request again")
        try:
            llm = await self.llms.resolve(user, body.request.model)
            run = await self.state.debug_runs.start(user.id, session_id, body, llm)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return self.response(run, status_code=202)

    async def get(self, session_id: str, turnId: str, roundIndex: int):
        user = await self.require_user()
        await self.require_session(session_id, user)
        rows = await DebugModelRunRepository().list_round(user.id, session_id, turnId, roundIndex)
        runs = []
        for row in rows:
            run = await self.state.debug_runs.get(user.id, session_id, row.id)
            if run is not None:
                runs.append(run)
        return self.response(runs)


class DebugLlmRunHandler(BaseHandler):
    tags = ["debug"]

    async def get(self, session_id: str, run_id: str):
        user = await self.require_user()
        await self.require_session(session_id, user)
        run = await self.state.debug_runs.get(user.id, session_id, run_id)
        if run is None:
            raise HTTPException(404, "Model experiment not found")
        return self.response(run)


class DebugLlmCancelHandler(BaseHandler):
    tags = ["debug"]

    async def post(self, session_id: str, run_id: str):
        user = await self.require_user()
        await self.require_session(session_id, user)
        run = await self.state.debug_runs.cancel(user.id, session_id, run_id)
        if run is None:
            raise HTTPException(404, "Model experiment not found")
        return self.response(run)


class DebugLlmEventsHandler(BaseHandler):
    tags = ["debug"]

    async def get(self, session_id: str, run_id: str):
        user = await self.require_user()
        await self.require_session(session_id, user)
        if await self.state.debug_runs.get(user.id, session_id, run_id) is None:
            raise HTTPException(404, "Model experiment not found")

        async def snapshots():
            previous = None
            while True:
                run = await self.state.debug_runs.get(user.id, session_id, run_id)
                if run is None:
                    return
                data = json.dumps({key: value for key, value in run.items() if key != "request"}, ensure_ascii=False)
                if data != previous:
                    yield data + "\n"
                    previous = data
                if run["status"] != "running":
                    return
                await asyncio.sleep(0.15)

        return StreamingResponse(snapshots(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
