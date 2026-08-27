import copy
import secrets
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field as PydanticField
from sqlalchemy import Column, Text, TypeDecorator, UniqueConstraint, delete, func
from sqlmodel import Field, SQLModel, select

from ._base import JsonType, Repository
from ._session import SessionRecord
from ._user import _utcnow


class UserInput(BaseModel):
    """Structured user input persisted with one Session Turn."""

    model_config = ConfigDict(extra="forbid")

    text: str
    blocks: List[dict] = PydanticField(default_factory=list)

    @classmethod
    def from_runtime(cls, value: Any) -> "UserInput":
        """Preserve text and structured blocks from one runtime input message."""
        if isinstance(value, cls):
            return value.model_copy(deep=True)
        if isinstance(value, str):
            return cls(text=value)
        read = value.get if isinstance(value, dict) else lambda name, default=None: getattr(value, name, default)
        blocks = [
            block if isinstance(block, dict) else block.model_dump()
            for block in (read("blocks", []) or [])
        ]
        return cls(text=str(read("text") or read("input") or ""), blocks=blocks)

    def remap_references(self, reference_ids: Mapping[str, str]) -> "UserInput":
        """Return a copy with structured reference ids replaced."""
        replacements = dict(reference_ids)
        blocks = copy.deepcopy(self.blocks)
        for block in blocks:
            reference_id = block.get("id")
            if isinstance(reference_id, str) and reference_id in replacements:
                block["id"] = replacements[reference_id]
        return self.model_copy(update={"blocks": blocks})


class UserInputType(TypeDecorator):
    """Persist one typed :class:`UserInput` as JSON text."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Optional[str]:
        if value is None or isinstance(value, str):
            return value
        return UserInput.model_validate(value).model_dump_json()

    def process_result_value(self, value: Any, dialect: Any) -> UserInput:
        if isinstance(value, UserInput):
            return value
        if not value:
            return UserInput(text="")
        try:
            return UserInput.model_validate_json(value)
        except Exception:  # noqa: BLE001
            return UserInput(text="")


class TurnStatus(str, Enum):
    """Durable lifecycle state of one Session Turn."""

    AWAITING_HUMAN = "awaiting_human"
    AWAITING_PERMISSION = "awaiting_permission"
    AWAITING_SUBAGENTS = "awaiting_subagents"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in {
            self.COMPLETED,
            self.FAILED,
            self.CANCELLED,
        }


class SessionTurnRecord(SQLModel, table=True):
    """One ordered Agent Turn contained by a Session."""

    __tablename__ = "session_turns"
    __table_args__ = (
        UniqueConstraint(
            "session_id",
            "session_ordinal",
            name="ux_session_turns_order",
        ),
    )

    # Identity and ownership
    id: str = Field(primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    session_id: str = Field(foreign_key="sessions.id", index=True)
    session_ordinal: int = Field(index=True)

    # Session Turn context
    user_input: UserInput = Field(sa_column=Column(UserInputType, nullable=False))
    ota_records: Optional[List[dict[str, Any]]] = Field(default=None, sa_column=Column(JsonType))
    agent_state: Optional[dict[str, Any]] = Field(default=None, sa_column=Column(JsonType))
    browser_tool_loaded: bool = Field(default=False)
    workspace_tools_loaded: bool = Field(default=False)
    skills_tool_loaded: bool = Field(default=False)
    status: TurnStatus = Field(nullable=False, index=True)
    final_answer: Optional[str] = Field(default=None, sa_column=Column(Text))
    error: Optional[str] = Field(default=None, sa_column=Column(Text))

    # Execution configuration and usage
    execution_mode: Optional[str] = Field(default=None)
    max_rounds: Optional[int] = Field(default=None)
    model: Optional[str] = Field(default=None)
    context_usage: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JsonType, nullable=False),
    )
    created_at: datetime = Field(default_factory=_utcnow)

    @property
    def duration_ms(self) -> Optional[int]:
        """Read total execution time from the existing OTA JSON trace."""
        for record in reversed(self.ota_records or []):
            if not isinstance(record, dict) or "turn_duration_ms" not in record:
                continue
            try:
                return max(0, int(record["turn_duration_ms"]))
            except (TypeError, ValueError):
                return None
        return None

    def ota_context_dump(self) -> dict[str, Any]:
        """Assemble the persisted fields into an Agent-facing OTA context dump."""
        dump = {
            "ota_record": copy.deepcopy(self.ota_records or []),
            "state": copy.deepcopy(self.agent_state or {}),
            "browser_tool_loaded": self.browser_tool_loaded,
            "workspace_tools_loaded": self.workspace_tools_loaded,
            "skills_tool_loaded": self.skills_tool_loaded,
            "context_usage": copy.deepcopy(self.context_usage),
        }
        if self.error and self.status is TurnStatus.FAILED:
            dump["turn_error"] = self.error
        else:
            dump.pop("turn_error", None)
        return dump


class SessionTurnSummary(SQLModel):
    """Lightweight Session summary without OTA record payloads."""

    first_user_input: Optional[str] = None
    tokens: int = 0
    latest_status: Optional[TurnStatus] = None


class SessionTurnRepository(Repository[SessionTurnRecord]):
    """Persist Turn lifecycles and query each Session's conversation."""

    async def append_result(
        self,
        user_id: str,
        *,
        session_id: str,
        expected_tail_id: Optional[str],
        user_input: UserInput,
        ota_records: List[dict[str, Any]],
        agent_state: dict[str, Any],
        browser_tool_loaded: bool,
        workspace_tools_loaded: bool,
        skills_tool_loaded: bool,
        status: TurnStatus,
        final_answer: Optional[str],
        error: Optional[str],
        context_usage: dict[str, Any],
        model: Optional[str] = None,
        execution_mode: Optional[str] = None,
        max_rounds: Optional[int] = None,
        duration_ms: int = 0,
    ) -> SessionTurnRecord:
        """Append one completed Agent result after the expected Session tail."""
        return await self._store_result(
            user_id,
            session_id=session_id,
            expected_tail_id=expected_tail_id,
            replace_tail=False,
            user_input=user_input,
            ota_records=ota_records,
            agent_state=agent_state,
            browser_tool_loaded=browser_tool_loaded,
            workspace_tools_loaded=workspace_tools_loaded,
            skills_tool_loaded=skills_tool_loaded,
            status=status,
            final_answer=final_answer,
            error=error,
            context_usage=context_usage,
            model=model,
            execution_mode=execution_mode,
            max_rounds=max_rounds,
            duration_ms=duration_ms,
        )

    async def replace_tail_result(
        self,
        user_id: str,
        *,
        session_id: str,
        expected_tail_id: str,
        user_input: UserInput,
        ota_records: List[dict[str, Any]],
        agent_state: dict[str, Any],
        browser_tool_loaded: bool,
        workspace_tools_loaded: bool,
        skills_tool_loaded: bool,
        status: TurnStatus,
        final_answer: Optional[str],
        error: Optional[str],
        context_usage: dict[str, Any],
        model: Optional[str] = None,
        execution_mode: Optional[str] = None,
        max_rounds: Optional[int] = None,
        duration_ms: int = 0,
    ) -> SessionTurnRecord:
        """Atomically replace the expected Session tail with a new result row."""
        return await self._store_result(
            user_id,
            session_id=session_id,
            expected_tail_id=expected_tail_id,
            replace_tail=True,
            user_input=user_input,
            ota_records=ota_records,
            agent_state=agent_state,
            browser_tool_loaded=browser_tool_loaded,
            workspace_tools_loaded=workspace_tools_loaded,
            skills_tool_loaded=skills_tool_loaded,
            status=status,
            final_answer=final_answer,
            error=error,
            context_usage=context_usage,
            model=model,
            execution_mode=execution_mode,
            max_rounds=max_rounds,
            duration_ms=duration_ms,
        )

    async def _store_result(
        self,
        user_id: str,
        *,
        session_id: str,
        expected_tail_id: Optional[str],
        replace_tail: bool,
        user_input: UserInput,
        ota_records: List[dict[str, Any]],
        agent_state: dict[str, Any],
        browser_tool_loaded: bool,
        workspace_tools_loaded: bool,
        skills_tool_loaded: bool,
        status: TurnStatus,
        final_answer: Optional[str],
        error: Optional[str],
        context_usage: dict[str, Any],
        model: Optional[str],
        execution_mode: Optional[str],
        max_rounds: Optional[int],
        duration_ms: int,
    ) -> SessionTurnRecord:
        """Persist one result after validating the caller-selected tail operation."""
        async with self._session() as session:
            owner = await self._get_owned(
                session,
                SessionRecord,
                session_id,
                user_id,
            )
            if owner is None:
                raise ValueError(f"session {session_id!r} is missing")

            tail = await self._scalar(
                session,
                select(SessionTurnRecord)
                .where(
                    SessionTurnRecord.user_id == user_id,
                    SessionTurnRecord.session_id == session_id,
                )
                .order_by(SessionTurnRecord.session_ordinal.desc())
                .limit(1),
            )
            tail_id = tail.id if tail is not None else None
            if tail_id != expected_tail_id:
                raise RuntimeError(
                    f"Session {session_id!r} tail changed from "
                    f"{expected_tail_id!r} to {tail_id!r}",
                )
            if replace_tail and tail is None:
                raise RuntimeError(f"Session {session_id!r} has no tail to replace")

            session_ordinal = (
                tail.session_ordinal
                if replace_tail and tail is not None
                else (tail.session_ordinal + 1 if tail is not None else 0)
            )
            if replace_tail:
                await session.delete(tail)
                await session.flush()

            stored_ota_records = copy.deepcopy(ota_records)
            if stored_ota_records:
                stored_ota_records[-1]["turn_duration_ms"] = max(0, duration_ms)

            record = SessionTurnRecord(
                id=f"turn_{secrets.token_hex(8)}",
                user_id=user_id,
                session_id=session_id,
                session_ordinal=session_ordinal,
                user_input=user_input,
                ota_records=stored_ota_records,
                agent_state=agent_state,
                browser_tool_loaded=browser_tool_loaded,
                workspace_tools_loaded=workspace_tools_loaded,
                skills_tool_loaded=skills_tool_loaded,
                status=status,
                final_answer=final_answer,
                error=error,
                model=model,
                execution_mode=execution_mode,
                max_rounds=max_rounds,
                context_usage=copy.deepcopy(context_usage),
            )
            session.add(record)
            await session.commit()
            await session.refresh(record)
            return record

    async def copy_to_session(
        self,
        source_session_id: str,
        dest_session_id: str,
        dest_user_id: str,
        *,
        reference_id_map: Optional[Mapping[str, str]] = None,
    ) -> int:
        """Copy every Turn of ``source_session_id`` into ``dest_session_id`` (fresh
        turn ids, same ordinals, re-owned by ``dest_user_id``). Returns the count.

        Used by session duplication ("continue the conversation" copies the session wholesale): the copy carries the
        transcript, Turn statuses, and cognitive state so the new Session tree
        retains the same context. The transport admits only finished root Sessions;
        independently parked Child Session projections are copied as-is.
        """
        replacements = dict(reference_id_map or {})

        def remap_key(value: Any) -> Any:
            return replacements.get(value, value) if isinstance(value, str) else value

        def remap(value: Any) -> Any:
            if isinstance(value, str):
                return replacements.get(value, value)
            if isinstance(value, dict):
                return {
                    remap_key(key): remap(item)
                    for key, item in value.items()
                }
            if isinstance(value, list):
                return [remap(item) for item in value]
            if isinstance(value, tuple):
                return tuple(remap(item) for item in value)
            return copy.deepcopy(value)

        async with self._session() as session:
            rows = await self._scalars(
                session,
                select(SessionTurnRecord)
                .where(SessionTurnRecord.session_id == source_session_id)
                .order_by(SessionTurnRecord.session_ordinal.asc()),
            )
            for row in rows:
                session.add(SessionTurnRecord(
                    id=f"turn_{secrets.token_hex(8)}",
                    user_id=dest_user_id,
                    session_id=dest_session_id,
                    session_ordinal=row.session_ordinal,
                    user_input=row.user_input.remap_references(replacements),
                    ota_records=remap(row.ota_records),
                    agent_state=remap(row.agent_state),
                    browser_tool_loaded=row.browser_tool_loaded,
                    workspace_tools_loaded=row.workspace_tools_loaded,
                    skills_tool_loaded=row.skills_tool_loaded,
                    status=row.status,
                    final_answer=row.final_answer,
                    error=row.error,
                    model=row.model,
                    execution_mode=row.execution_mode,
                    max_rounds=row.max_rounds,
                    context_usage=remap(row.context_usage),
                    created_at=row.created_at,
                ))
            await session.commit()
            return len(rows)

    async def get(self, user_id: str, turn_id: str) -> Optional[SessionTurnRecord]:
        """Return one Turn owned by ``user_id``."""
        async with self._session() as session:
            return await self._owned_turn(session, user_id, turn_id)

    async def list_conversation(
        self,
        user_id: str,
        session_id: str,
        *,
        before_ordinal: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[SessionTurnRecord]:
        """Return one owned Session's conversation in ordinal order.

        Default (no keywords) is the FULL transcript — prompt assembly and
        subagent replay depend on that. With ``limit`` set, returns the newest
        ``min(limit, 200)`` turns strictly below ``before_ordinal`` (cursor;
        None = from the tail), still oldest-first. ``session_ordinal`` is the
        cursor because it is append-only per Session — pages stay stable while
        new turns land at the tail.
        """
        async with self._session() as session:
            stmt = select(SessionTurnRecord).where(
                SessionTurnRecord.user_id == user_id,
                SessionTurnRecord.session_id == session_id,
            )
            if before_ordinal is not None:
                stmt = stmt.where(SessionTurnRecord.session_ordinal < before_ordinal)
            if limit is None:
                return await self._scalars(
                    session,
                    stmt.order_by(SessionTurnRecord.session_ordinal.asc()),
                )
            rows = await self._scalars(
                session,
                stmt.order_by(SessionTurnRecord.session_ordinal.desc())
                .limit(max(1, min(limit, 200))),
            )
            return list(reversed(rows))

    async def delete_for_session(self, user_id: str, session_id: str) -> int:
        """Delete every Turn in one owned Session."""
        async with self._session() as session:
            result = await session.execute(
                delete(SessionTurnRecord).where(
                    SessionTurnRecord.user_id == user_id,
                    SessionTurnRecord.session_id == session_id,
                ),
            )
            await session.commit()
            return int(result.rowcount or 0)

    async def latest(
        self,
        session_id: str,
        user_id: str,
    ) -> Optional[SessionTurnRecord]:
        """Return the latest Turn in one owned Session."""
        async with self._session() as session:
            return await self._scalar(
                session,
                select(SessionTurnRecord)
                .where(
                    SessionTurnRecord.user_id == user_id,
                    SessionTurnRecord.session_id == session_id,
                )
                .order_by(SessionTurnRecord.session_ordinal.desc())
                .limit(1),
            )

    async def list_latest_by_status(self, status: TurnStatus) -> List[SessionTurnRecord]:
        """Return Sessions whose latest Turn has the requested durable status."""
        latest = (
            select(
                SessionTurnRecord.session_id.label("session_id"),
                func.max(SessionTurnRecord.session_ordinal).label("session_ordinal"),
            )
            .group_by(SessionTurnRecord.session_id)
            .subquery()
        )
        async with self._session() as session:
            return await self._scalars(
                session,
                select(SessionTurnRecord)
                .join(
                    latest,
                    (SessionTurnRecord.session_id == latest.c.session_id)
                    & (SessionTurnRecord.session_ordinal == latest.c.session_ordinal),
                )
                .where(SessionTurnRecord.status == status),
            )

    async def load_summaries(
        self,
        records: Sequence[SessionRecord],
    ) -> Dict[str, SessionTurnSummary]:
        """Load first-input and token summaries without OTA record blobs."""
        if not records:
            return {}
        record_by_id = {record.id: record for record in records}
        user_ids = {record.user_id for record in records}
        async with self._session() as session:
            rows = (
                await session.execute(
                    select(
                        SessionTurnRecord.session_id,
                        SessionTurnRecord.session_ordinal,
                        SessionTurnRecord.user_input,
                        SessionTurnRecord.context_usage,
                        SessionTurnRecord.status,
                    )
                    .where(
                        SessionTurnRecord.user_id.in_(user_ids),
                        SessionTurnRecord.session_id.in_(list(record_by_id)),
                    )
                    .order_by(
                        SessionTurnRecord.session_id.asc(),
                        SessionTurnRecord.session_ordinal.asc(),
                    ),
                )
            ).all()
        values: Dict[str, List[tuple[str, int, TurnStatus]]] = {
            session_id: [] for session_id in record_by_id
        }

        def usage_tokens(usage: Any) -> int:
            if not isinstance(usage, dict):
                return 0

            def token_value(name: str) -> int:
                try:
                    return max(0, int(usage.get(name) or 0))
                except (TypeError, ValueError):
                    return 0

            return token_value("input_tokens") + token_value("output_tokens")

        for session_id, _ordinal, user_input, context_usage, turn_status in rows:
            values[session_id].append((
                user_input.text,
                usage_tokens(context_usage),
                turn_status,
            ))
        return {
            session_id: SessionTurnSummary(
                first_user_input=pairs[0][0] if pairs else None,
                tokens=sum(pair[1] for pair in pairs),
                latest_status=pairs[-1][2] if pairs else None,
            )
            for session_id, pairs in values.items()
        }

    async def load_summary(self, record: SessionRecord) -> SessionTurnSummary:
        """Load one Session's lightweight history summary."""
        return (await self.load_summaries([record]))[record.id]

    async def _owned_turn(
        self,
        session: Any,
        user_id: str,
        turn_id: str,
    ) -> Optional[SessionTurnRecord]:
        """Return one Turn authorized by its direct owner field."""
        return await self._get_owned(
            session,
            SessionTurnRecord,
            turn_id,
            user_id,
        )

__all__ = [
    "SessionTurnRecord",
    "SessionTurnRepository",
    "SessionTurnSummary",
    "TurnStatus",
    "UserInput",
]
