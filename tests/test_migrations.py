"""Backfill-DDL invariants for enum columns.

SQLModel maps ``str``-``Enum`` columns via ``sa.Enum``, which persists AND reads
by the enum *member name* ('USER'), not its value ('user') — the same way
``SessionStatus`` stores 'FINISH'. So a column added by ``_COLUMN_BACKFILLS``
whose ``DEFAULT`` is the value-case string makes every migrated row unreadable
on the next SELECT (``LookupError: '<value>' is not among the defined enum
values``). This guards that whole class of bug (regression for the
``sessions.kind DEFAULT 'user'`` slip).
"""
from __future__ import annotations

import re
from pathlib import Path

from src.amphi_store import (
    Repository,
    SessionKind,
    SessionRecord,
    SessionRepository,
    SessionTurnRecord,
    UserRepository,
    WorkflowRun,
    WorkflowRunRepository,
    WorkflowValidationStatus,
)


def _backfill_default(table: str, column: str) -> str:
    """The quoted ``DEFAULT '<x>'`` literal of one backfill DDL entry."""
    for t, c, ddl in Repository._COLUMN_BACKFILLS:
        if t == table and c == column:
            match = re.search(r"DEFAULT\s+'([^']*)'", ddl)
            assert match, f"{table}.{column} backfill lacks a quoted DEFAULT: {ddl!r}"
            return match.group(1)
    raise AssertionError(f"no backfill registered for {table}.{column}")


def test_sessions_kind_backfill_default_is_a_valid_enum_name() -> None:
    default = _backfill_default("sessions", "kind")
    assert default in SessionKind.__members__, (
        f"sessions.kind backfill DEFAULT {default!r} is not a SessionKind member "
        f"NAME; SQLAlchemy reads enums by name, so migrated rows would raise "
        f"LookupError on load. Use one of {list(SessionKind.__members__)}."
    )


def test_sessions_subagent_mode_has_a_nullable_backfill() -> None:
    ddl = next(
        ddl for table, column, ddl in Repository._COLUMN_BACKFILLS
        if table == "sessions" and column == "subagent_mode"
    )
    assert "DEFAULT" not in ddl


def test_workflow_run_snapshot_reuses_filesystem_storage() -> None:
    """Run source ownership must not add database state or a migration."""
    assert "snapshot_digest" not in WorkflowRun.__table__.columns
    assert not any(
        table == "workflow_runs" and column == "snapshot_digest"
        for table, column, _ddl in Repository._COLUMN_BACKFILLS
    )


def test_turn_completion_metrics_reuse_existing_storage() -> None:
    """Message timing must not add columns or startup migrations."""
    columns = set(SessionTurnRecord.__table__.columns.keys())
    assert "duration_ms" not in columns
    assert "completed_at" not in columns
    assert not any(table == "session_turns" for table, _column, _ddl in Repository._COLUMN_BACKFILLS)


async def test_schema_init_backfills_schedule_locale_for_legacy_database(
    temp_db_path: Path,
) -> None:
    Repository.connect(temp_db_path)
    try:
        assert Repository._engine is not None
        async with Repository._engine.begin() as connection:
            await connection.exec_driver_sql(
                "CREATE TABLE schedules (id VARCHAR PRIMARY KEY, user_id VARCHAR NOT NULL, "
                "name VARCHAR NOT NULL, desc VARCHAR NOT NULL, cron VARCHAR NOT NULL, "
                "timezone VARCHAR, refs_json VARCHAR, enabled BOOLEAN NOT NULL, "
                "created_at DATETIME NOT NULL, last_run_at DATETIME, next_run_at DATETIME)"
            )

        await Repository.init_schema()

        async with Repository._engine.connect() as connection:
            columns = await connection.exec_driver_sql("PRAGMA table_info(schedules)")
            assert "locale" in {row[1] for row in columns}
    finally:
        await Repository.close()


async def test_schema_init_migrates_legacy_workflow_run_states(
    temp_db_path: Path,
    tmp_path: Path,
) -> None:
    Repository.connect(temp_db_path)
    try:
        await Repository.init_schema()
        await UserRepository().ensure_seeded("legacy-user")
        await SessionRepository().save(SessionRecord(
            id="legacy-session",
            user_id="legacy-user",
            workspace_root=str(tmp_path / "legacy-session"),
        ))
        legacy_rows = (
            ("failed", "FAILED", "PENDING"),
            ("completed", "COMPLETED", "PENDING"),
            ("cancelled", "CANCELLED", "PENDING"),
            ("waiting", "WAITING", "PENDING"),
        )
        assert Repository._engine is not None
        async with Repository._engine.begin() as connection:
            for run_id, status, validation_status in legacy_rows:
                await connection.exec_driver_sql(
                    "INSERT INTO workflow_runs "
                    "(id, user_id, workflow_id, workflow_name, source_session_id, "
                    "workflow_input, status, validation_status, run_dir, created_at, finished_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                    (
                        run_id,
                        "legacy-user",
                        "legacy-workflow",
                        "Legacy workflow",
                        "legacy-session",
                        '{"text":"legacy","blocks":[]}',
                        status,
                        validation_status,
                        f"/legacy/{run_id}",
                    ),
                )
                await connection.exec_driver_sql(
                    "INSERT INTO session_workflow_runs "
                    "(session_id, run_id, user_id, created_at) "
                    "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
                    ("legacy-session", run_id, "legacy-user"),
                )

        await Repository.init_schema()
        await Repository.init_schema()

        rows = await WorkflowRunRepository().list_for_user("legacy-user")
        assert {
            row.id: row.validation_status for row in rows
        } == {
            "failed": WorkflowValidationStatus.FAILED,
            "completed": WorkflowValidationStatus.NOT_REQUIRED,
        }
        async with Repository._engine.connect() as connection:
            associations = await connection.exec_driver_sql(
                "SELECT run_id FROM session_workflow_runs ORDER BY run_id"
            )
            assert [row[0] for row in associations] == ["completed", "failed"]
    finally:
        await Repository.close()


async def test_schema_init_repairs_codex_rows_with_stale_base_url(tmp_path) -> None:
    """Databases written before the api_key→Codex switch fix carry a stale
    ``base_url`` on ``protocol='openai-codex'`` rows (and on the mirroring user
    row), which sends Codex traffic to ``https://api.openai.com/v1/codex/...``.
    Schema init must NULL both — the Codex flow never legitimately sets one."""
    import sqlite3

    from src.amphi_store._base import Repository

    db = tmp_path / "legacy.db"
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE provider_credentials (
            id INTEGER NOT NULL PRIMARY KEY, user_id VARCHAR NOT NULL,
            provider_id VARCHAR NOT NULL, auth_mode VARCHAR NOT NULL,
            api_key VARCHAR, base_url VARCHAR, is_active BOOLEAN NOT NULL,
            is_enabled BOOLEAN NOT NULL, protocol VARCHAR NOT NULL,
            display_name VARCHAR, enabled_models TEXT, created_at DATETIME NOT NULL
        );
        INSERT INTO provider_credentials VALUES
            (1, 'local', 'openai', 'oauth', NULL, 'https://api.openai.com/v1',
             1, 1, 'openai-codex', 'OpenAI', '[]', '2026-01-01'),
            (2, 'local', 'glm', 'api_key', 'sk-x', 'https://open.bigmodel.cn/api/paas/v4',
             0, 1, 'openai', 'GLM', '[]', '2026-01-01');
        CREATE TABLE users (
            id VARCHAR NOT NULL PRIMARY KEY, display_name VARCHAR,
            api_key VARCHAR, base_url VARCHAR, protocol VARCHAR NOT NULL,
            current_model VARCHAR, default_max_rounds INTEGER,
            default_temperature FLOAT, execution_mode VARCHAR
        );
        INSERT INTO users VALUES
            ('local', NULL, NULL, 'https://api.openai.com/v1', 'openai-codex',
             'gpt-5.5', 50, 0.0, 'auto');
        """
    )
    con.commit(); con.close()

    Repository.connect(db)
    try:
        await Repository.init_schema()
    finally:
        await Repository.close()

    con = sqlite3.connect(db)
    codex_base, = con.execute(
        "SELECT base_url FROM provider_credentials WHERE provider_id='openai'").fetchone()
    glm_base, = con.execute(
        "SELECT base_url FROM provider_credentials WHERE provider_id='glm'").fetchone()
    user_base, = con.execute("SELECT base_url FROM users WHERE id='local'").fetchone()
    con.close()

    assert codex_base is None, "stale codex base_url must be nulled"
    assert glm_base == "https://open.bigmodel.cn/api/paas/v4", "api_key rows untouched"
    assert user_base is None, "the user mirror must be repaired too"
