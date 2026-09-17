import hashlib
import json
from datetime import datetime
from typing import Any

from sqlalchemy import Column
from sqlmodel import Field, SQLModel, select

from ._base import JsonType, Repository
from ._user import _utcnow


def debug_fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class DebugModelRun(SQLModel, table=True):
    """One explicitly submitted model experiment, separate from conversation Turns."""

    __tablename__ = "debug_model_runs"

    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    session_id: str = Field(index=True)
    turn_id: str = Field(index=True)
    round_index: int
    fingerprint: str
    status: str = "running"
    snapshot: dict[str, Any] = Field(sa_column=Column(JsonType, nullable=False))
    created_at: datetime = Field(default_factory=_utcnow)


class DebugModelRunRepository(Repository[DebugModelRun]):
    async def save(self, run: DebugModelRun) -> None:
        async with self._session() as session:
            await session.merge(run)
            await session.commit()

    async def get(self, user_id: str, session_id: str, run_id: str) -> DebugModelRun | None:
        async with self._session() as session:
            row = await self._get_owned(session, DebugModelRun, run_id, user_id)
            return row if row is not None and row.session_id == session_id else None

    async def list_round(self, user_id: str, session_id: str, turn_id: str, round_index: int) -> list[DebugModelRun]:
        async with self._session() as session:
            rows = await session.execute(select(DebugModelRun).where(
                DebugModelRun.user_id == user_id, DebugModelRun.session_id == session_id,
                DebugModelRun.turn_id == turn_id, DebugModelRun.round_index == round_index,
            ).order_by(DebugModelRun.created_at))
            return list(rows.scalars())
