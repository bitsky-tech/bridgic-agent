import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi.encoders import jsonable_encoder

from ...amphi_store import DebugModelRun, DebugModelRunRepository, SessionRecord, SessionRepository
from ...amphi_store._debug_run import debug_fingerprint


class DebugModelRuns:
    """Own model-only tasks and publish snapshots without entering the Agent loop."""

    def __init__(self) -> None:
        self._repo = DebugModelRunRepository()
        self._tasks: dict[str, asyncio.Task] = {}
        self._live: dict[str, DebugModelRun] = {}
        self._lock = asyncio.Lock()

    async def start(self, user_id: str, session_id: str, body: Any, llm: Any) -> dict[str, Any]:
        submitted = body.model_dump(mode="json", by_alias=True)
        run_id = "debug_" + debug_fingerprint([user_id, session_id, body.client_request_id])[:32]
        fingerprint = debug_fingerprint(submitted)
        async with self._lock:
            # Model resolution happens before this lock and may outlive a Session.
            if await SessionRepository().load(session_id, user_id) is None:
                raise ValueError("The Session is no longer available")
            existing = await self._get(user_id, session_id, run_id)
            if existing is not None:
                row = await self._repo.get(user_id, session_id, run_id)
                if row.fingerprint != fingerprint:
                    raise ValueError("This request ID already belongs to a different experiment")
                return existing
            if any(row.session_id == session_id and row.user_id == user_id for row in self._live.values()):
                raise ValueError("A model experiment is already running in this Session")
            row = DebugModelRun(
                id=run_id, user_id=user_id, session_id=session_id, turn_id=body.source.turn_id,
                round_index=body.source.round_index, fingerprint=fingerprint,
                snapshot={"id": run_id, "sessionId": session_id, "source": submitted["source"],
                          "request": submitted["request"], "status": "running", "content": "", "reasoning": "",
                          "toolCalls": [], "usage": None, "durationMs": None, "error": None, "retries": []},
            )
            row.snapshot["createdAt"] = row.created_at.isoformat()
            await self._repo.save(row)
            self._live[run_id] = row

            async def execute() -> None:
                started = time.monotonic()

                def publish(event: str, **payload: Any) -> None:
                    if event in {"token", "reasoning"}:
                        key = "content" if event == "token" else "reasoning"
                        row.snapshot[key] += str(payload.get("text", ""))
                    elif event == "model_retry":
                        row.snapshot["content"] = ""
                        row.snapshot["reasoning"] = ""
                        row.snapshot["retries"].append(jsonable_encoder(payload))

                try:
                    result = await llm.stream_turn(body.request.messages, body.request.tools or None,
                                                   publish=publish, extra_body=body.request.extra_body)
                    row.snapshot.update(content=result.content, toolCalls=result.tool_calls,
                                        usage=jsonable_encoder(result.usage), status="succeeded")
                except asyncio.CancelledError:
                    row.snapshot["status"] = "cancelled"
                except Exception as exc:
                    row.snapshot.update(status="failed", error=str(exc))
                finally:
                    row.status = row.snapshot["status"]
                    row.snapshot["durationMs"] = max(0, int((time.monotonic() - started) * 1000))
                    try:
                        await self._repo.save(row)
                    finally:
                        self._live.pop(run_id, None)
                        self._tasks.pop(run_id, None)

            self._tasks[run_id] = asyncio.create_task(execute())
            await asyncio.sleep(0)
            return dict(row.snapshot)

    async def get(self, user_id: str, session_id: str, run_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return await self._get(user_id, session_id, run_id)

    async def _get(self, user_id: str, session_id: str, run_id: str) -> dict[str, Any] | None:
        """Read under the lifecycle lock so pending registrations are not orphans."""
        row = self._live.get(run_id)
        if row is not None:
            return dict(row.snapshot) if row.user_id == user_id and row.session_id == session_id else None
        row = await self._repo.get(user_id, session_id, run_id)
        if row is None:
            return None
        if row.status == "running":
            row.status = "interrupted"
            row.snapshot = {**row.snapshot, "status": "interrupted", "error": "The service restarted before this experiment completed"}
            await self._repo.save(row)
        return row.snapshot

    async def cancel(self, user_id: str, session_id: str, run_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return await self._cancel(user_id, session_id, run_id)

    async def _cancel(self, user_id: str, session_id: str, run_id: str) -> dict[str, Any] | None:
        """Wait for terminal persistence before releasing the lifecycle lock."""
        run = await self._get(user_id, session_id, run_id)
        if run is not None and (task := self._tasks.get(run_id)) is not None:
            if run["status"] == "running":
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return await self._get(user_id, session_id, run_id)
        return run

    async def shutdown(self) -> None:
        async with self._lock:
            tasks = list(self._tasks.values())
            for run_id, task in list(self._tasks.items()):
                if self._live[run_id].snapshot["status"] == "running":
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    @asynccontextmanager
    async def deleting_session_tree(self, user_id: str, session_id: str) -> AsyncIterator[list[SessionRecord]]:
        """Exclude experiment starts and reads until the Session tree is deleted."""
        async with self._lock:
            tree = await SessionRepository().list_tree(user_id, session_id)
            session_ids = {item.id for item in tree}
            for run_id, row in list(self._live.items()):
                if row.user_id == user_id and row.session_id in session_ids:
                    await self._cancel(user_id, row.session_id, run_id)
            yield tree
