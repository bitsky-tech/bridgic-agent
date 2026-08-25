import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, List, Optional, Tuple, Type, TypeVar, Generic

from sqlalchemy import Text, TypeDecorator
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlmodel import SQLModel, select

if TYPE_CHECKING:
    from sqlalchemy.sql import Executable

# Row type a concrete repository works with (a ``table=True`` SQLModel).
T = TypeVar("T")

# Env var override for the SQLite path. Production never sets it; tests do
# (``monkeypatch.setenv``) so they hit a per-test tmp file.
_PATH_ENV_VAR: str = "BRIDGIC_AGENT_STATE_DB"


class Repository(Generic[T]):
    """Base for durable-storage repositories: the DB connection + the DB atoms."""

    DEFAULT_PATH: ClassVar[Path] = Path.home() / ".bridgic" / "AmphiAgent" / "state.db"

    # The one process-wide engine + session factory, built by ``connect``.
    # Class-level on purpose: a single connection pool is shared by every
    # (arg-less) repository.
    _engine: ClassVar[Optional[AsyncEngine]] = None
    _sessionmaker: ClassVar[Optional["async_sessionmaker[AsyncSession]"]] = None

    @classmethod
    def connect(cls, db_path: Optional[Path] = None) -> None:
        """Build the process-wide engine + session factory. Call once at startup.

        Path resolution: ``db_path`` arg > ``$BRIDGIC_AGENT_STATE_DB`` >
        :attr:`DEFAULT_PATH`. The parent dir is forced to 0700 on every startup
        (it holds the user's plaintext api_key, so lock it to the owner —
        best-effort, POSIX only).
        """
        env_override = os.environ.get(_PATH_ENV_VAR)
        path = db_path or (
            Path(env_override) if env_override else cls.DEFAULT_PATH
        )
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # mkdir's mode applies ONLY at creation and is masked by umask, so a
        # dir that already existed (created by an earlier release, or by any
        # other code path touching ~/.bridgic first) keeps its old bits —
        # observed 0755 in the wild, i.e. every local user could read the
        # plaintext keys. Re-assert it every startup.
        if os.name == "posix":
            try:
                path.parent.chmod(0o700)
            except OSError:
                pass  # read-only FS / exotic mount — don't block startup
        Repository._engine = create_async_engine(
            f"sqlite+aiosqlite:///{path}", echo=False,
        )
        Repository._sessionmaker = async_sessionmaker(
            Repository._engine, class_=AsyncSession, expire_on_commit=False,
        )

    # Columns added to a model AFTER its table first shipped. ``create_all``
    # only does CREATE TABLE IF NOT EXISTS — it never ALTERs an existing
    # table — so each (table, column, ddl) here is applied by hand on startup
    # when the column is missing. SQLite-specific, idempotent, append-only.
    _COLUMN_BACKFILLS: ClassVar[Tuple[Tuple[str, str, str], ...]] = (
        ("skills", "enabled",
         "ALTER TABLE skills ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1"),
        ("workflows", "source_session_id",
         "ALTER TABLE workflows ADD COLUMN source_session_id TEXT"),
        # NOTE: the backfill default MUST be the enum *member name* ('USER'),
        # not its value ('user'): SQLModel maps ``SessionKind`` via ``sa.Enum``,
        # which persists/reads by NAME (like ``SessionStatus`` → 'FINISH'). A
        # 'user' default makes migrated rows unreadable (``LookupError: 'user'
        # is not among the defined enum values``) on the next SELECT.
        ("sessions", "kind",
         "ALTER TABLE sessions ADD COLUMN kind VARCHAR NOT NULL DEFAULT 'USER'"),
        ("sessions", "schedule_id",
         "ALTER TABLE sessions ADD COLUMN schedule_id TEXT"),
        ("sessions", "subagent_mode",
         "ALTER TABLE sessions ADD COLUMN subagent_mode VARCHAR"),
        ("schedules", "locale",
         "ALTER TABLE schedules ADD COLUMN locale VARCHAR"),
        ("provider_credentials", "model_limits",
         "ALTER TABLE provider_credentials ADD COLUMN model_limits TEXT NOT NULL DEFAULT '{}'"),
        ("session_turns", "context_usage",
         "ALTER TABLE session_turns ADD COLUMN context_usage TEXT NOT NULL DEFAULT '{}'"),
    )
    @classmethod
    async def init_schema(cls) -> None:
        """``CREATE TABLE IF NOT EXISTS`` for every registered model, then
        backfill any columns added to existing tables after they first shipped.

        Idempotent. Relies on :mod:`src.amphi_store` importing every model
        module so the tables are registered on ``SQLModel.metadata``.
        """
        async with cls._engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
            await conn.run_sync(cls._backfill_columns)

    @classmethod
    def _backfill_columns(cls, sync_conn: Any) -> None:
        """Add missing columns to an existing SQLite schema."""
        from sqlalchemy import text

        for table, column, ddl in cls._COLUMN_BACKFILLS:
            rows = sync_conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
            existing = {r[1] for r in rows}  # r[1] is the column name
            if existing and column not in existing:
                sync_conn.execute(text(ddl))

        cls._migrate_session_turn_usage(sync_conn)
        cls._migrate_legacy_workflow_runs(sync_conn)
        # Repair rows written before the api_key→Codex switch cleared the stale
        # base_url: Codex channels never legitimately carry one, and a leftover
        # https://api.openai.com/v1 routes /codex/responses to a 404. Idempotent.
        for table in ("provider_credentials", "users"):
            rows = sync_conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
            if rows:
                sync_conn.execute(text(
                    f"UPDATE {table} SET base_url = NULL "
                    "WHERE protocol = 'openai-codex' AND base_url IS NOT NULL"
                ))
        sync_conn.execute(text(
            "INSERT OR IGNORE INTO session_workflow_runs "
            "(session_id, run_id, user_id, created_at) "
            "SELECT workflow_runs.source_session_id, workflow_runs.id, "
            "workflow_runs.user_id, workflow_runs.created_at "
            "FROM workflow_runs JOIN sessions "
            "ON sessions.id = workflow_runs.source_session_id "
            "AND sessions.user_id = workflow_runs.user_id"
        ))

    @staticmethod
    def _migrate_session_turn_usage(sync_conn: Any) -> None:
        """Move legacy Turn token columns into the structured usage snapshot."""
        from sqlalchemy import text

        rows = sync_conn.exec_driver_sql("PRAGMA table_info(session_turns)").all()
        columns = {row[1] for row in rows}
        legacy_columns = columns & {"input_tokens", "output_tokens"}
        if not legacy_columns:
            return

        input_expression = "input_tokens" if "input_tokens" in columns else "0"
        output_expression = "output_tokens" if "output_tokens" in columns else "0"
        stored_rows = sync_conn.exec_driver_sql(
            "SELECT id, model, context_usage, "
            f"{input_expression}, {output_expression} FROM session_turns"
        ).all()
        for turn_id, model, raw_usage, input_tokens, output_tokens in stored_rows:
            try:
                existing_usage = json.loads(raw_usage) if raw_usage else {}
            except (json.JSONDecodeError, TypeError):
                existing_usage = {}
            if not isinstance(existing_usage, dict):
                existing_usage = {}
            usage = {
                "model_id": model or "",
                "input_tokens": max(0, int(input_tokens or 0)),
                "output_tokens": max(0, int(output_tokens or 0)),
                "occupied_input_tokens": 0,
                "occupied_output_tokens": 0,
                "used_tokens": 0,
                "usable_tokens": None,
                "percentage": None,
                "source": "estimated",
                "estimated_occupied_tokens": 0,
                **existing_usage,
            }
            sync_conn.execute(
                text("UPDATE session_turns SET context_usage = :usage WHERE id = :turn_id"),
                {"usage": json.dumps(usage, ensure_ascii=False), "turn_id": turn_id},
            )

        for column in ("input_tokens", "output_tokens"):
            if column in legacy_columns:
                sync_conn.exec_driver_sql(
                    f"ALTER TABLE session_turns DROP COLUMN {column}"
                )

    @staticmethod
    def _migrate_legacy_workflow_runs(sync_conn: Any) -> None:
        """Normalize rows persisted by the former database-backed Run lifecycle."""
        from sqlalchemy import text

        legacy_statuses = "'RUNNING', 'WAITING', 'PAUSED', 'CANCELLED'"
        sync_conn.execute(text(
            "DELETE FROM session_workflow_runs WHERE run_id IN "
            f"(SELECT id FROM workflow_runs WHERE status IN ({legacy_statuses}))"
        ))
        sync_conn.execute(text(
            f"DELETE FROM workflow_runs WHERE status IN ({legacy_statuses})"
        ))
        sync_conn.execute(text(
            "UPDATE workflow_runs SET validation_status = 'FAILED' "
            "WHERE status = 'FAILED' AND validation_status = 'PENDING'"
        ))
        sync_conn.execute(text(
            "UPDATE workflow_runs SET validation_status = 'NOT_REQUIRED' "
            "WHERE status = 'COMPLETED' AND validation_status = 'PENDING'"
        ))

    @classmethod
    async def close(cls) -> None:
        """Dispose the engine (close pooled connections)."""
        if Repository._engine is not None:
            await Repository._engine.dispose()
            Repository._engine = None
            Repository._sessionmaker = None

    def _session(self) -> AsyncSession:
        """Open a fresh short-lived :class:`AsyncSession` for ``async with``."""
        if Repository._sessionmaker is None:
            raise RuntimeError(
                "Repository is not connected; call Repository.connect() at "
                "startup before using a repository."
            )
        return Repository._sessionmaker()

    # Session-scoped query atoms — take an open ``s``, never commit.
    async def _get_owned(
        self, s: "AsyncSession", model: Type[T], pk: Any, user_id: str,
    ) -> Optional[T]:
        """Fetch by primary key, ownership-gated.

        ``None`` when the row is missing **or** owned by another user
        (same no-information-leak response). Assumes ``model`` has a
        ``user_id`` column.
        """
        row = await s.get(model, pk)
        if row is None or row.user_id != user_id:
            return None
        return row

    async def _get_by(
        self, s: "AsyncSession", model: Type[T], **filters: Any,
    ) -> Optional[T]:
        """Single row matching equality ``filters`` (e.g. a composite natural
        key), or ``None``. Raises if the filters match more than one row."""
        stmt = select(model)
        for attr, value in filters.items():
            stmt = stmt.where(getattr(model, attr) == value)
        return (await s.execute(stmt)).scalar_one_or_none()

    async def _list_owned(
        self, s: "AsyncSession", model: Type[T], user_id: str,
        *, order_by: Any = None,
    ) -> List[T]:
        """Every row owned by ``user_id``, optionally ordered."""
        stmt = select(model).where(getattr(model, "user_id") == user_id)
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        return list((await s.execute(stmt)).scalars().all())

    async def _delete_owned(
        self, s: "AsyncSession", model: Type[T], pk: Any, user_id: str,
    ) -> bool:
        """Ownership-gated delete by primary key; ``True`` iff a row was deleted.

        Does **not** commit — the caller owns the surrounding transaction
        (so a parent + children delete commits once).
        """
        row = await self._get_owned(s, model, pk, user_id)
        if row is None:
            return False
        await s.delete(row)
        return True

    async def _scalar(self, s: "AsyncSession", stmt: "Executable") -> Any:
        """``scalar_one_or_none()`` for a caller-built statement — the escape
        hatch for non-ownership / composite queries."""
        return (await s.execute(stmt)).scalar_one_or_none()

    async def _scalars(self, s: "AsyncSession", stmt: "Executable") -> List[Any]:
        """``scalars().all()`` as a list, for a caller-built statement."""
        return list((await s.execute(stmt)).scalars().all())


class JsonType(TypeDecorator):
    """Generic JSON column type: a JSON-serialisable value (a list / dict) <-> a
    TEXT blob, so a structured column without a dedicated domain type reads and
    writes as the value itself — callers never ``json.dumps`` / ``loads`` around
    the row. ``bind`` also accepts an already-serialised ``str`` (existing rows /
    transitional call sites).
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Optional[str]:
        if value is None or isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None


__all__ = ["Repository", "JsonType"]
