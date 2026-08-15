"""Bulk seeding helpers for the list-endpoint perf baselines.

Rows go in through the real repository write path (not raw SQL) so schema
defaults, enum coercion and ownership columns match production exactly — the
baseline would be meaningless if the seeded shape differed from real data.

Every helper is user-scoped to ``local``, the seeded single user the service
lifespan creates. Callers own the DB lifecycle (see the ``client`` fixture).
"""

from __future__ import annotations

from typing import List, Optional

from src.amphi_store import (
    SessionKind,
    SessionMountRepository,
    SessionRecord,
    SessionRepository,
    SessionStatus,
    SessionTurnRepository,
    TurnStatus,
    UserInput,
    WorkflowRunRepository,
    WorkflowRunStatus,
    WorkflowValidationStatus,
)

LOCAL_USER = "local"


async def seed_sessions(count: int, *, prefix: str = "perf") -> List[str]:
    """Create ``count`` root user Sessions; return their ids in creation order."""
    repository = SessionRepository()
    ids: List[str] = []
    for index in range(count):
        session_id = f"session_{prefix}_{index:05d}"
        await repository.save(
            SessionRecord(
                id=session_id,
                user_id=LOCAL_USER,
                workspace_root=f"/tmp/{prefix}/{session_id}",
                title=f"{prefix} 压力会话 {index}",
                status=SessionStatus.FINISH,
                kind=SessionKind.USER,
            ),
        )
        ids.append(session_id)
    return ids


async def seed_turns(session_id: str, count: int) -> int:
    """Append ``count`` completed Turns to one Session; return rows written.

    Turns are chained through ``expected_tail_id`` because the repository
    enforces optimistic tail matching — passing None twice would be rejected.
    """
    repository = SessionTurnRepository()
    tail_id: Optional[str] = None
    for index in range(count):
        record = await repository.append_result(
            LOCAL_USER,
            session_id=session_id,
            expected_tail_id=tail_id,
            user_input=UserInput(text=f"压力测试第 {index} 轮提问，带一点中文正文长度。"),
            ota_records=[{"turn_duration_ms": 1200}],
            agent_state={},
            browser_tool_loaded=False,
            workspace_tools_loaded=False,
            skills_tool_loaded=False,
            status=TurnStatus.COMPLETED,
            final_answer=f"第 {index} 轮的回答正文，模拟一段中等长度的助手输出。" * 3,
            error=None,
            input_tokens=120,
            output_tokens=340,
        )
        tail_id = record.id
    return count


async def seed_workflow_runs(count: int, source_session_id: str) -> int:
    """Create ``count`` published Workflow runs over 5 synthetic definitions.

    Runs are created RUNNING and then driven to COMPLETED: ``list_for_user``
    only returns published (COMPLETED/FAILED) rows, so seeding without the
    second step would leave every list endpoint empty.
    """
    repository = WorkflowRunRepository()
    for index in range(count):
        definition = index % 5
        run = await repository.create(
            LOCAL_USER,
            workflow_id=f"wf_perf_{definition}",
            workflow_name=f"压力工作流 {definition}",
            source_session_id=source_session_id,
            run_dir=f"/tmp/perf/runs/{index:05d}",
            workflow_input=UserInput(text=f"/压力工作流 {definition} 第 {index} 次运行"),
        )
        await repository.update(
            LOCAL_USER,
            run.id,
            status=WorkflowRunStatus.COMPLETED,
            validation_status=WorkflowValidationStatus.PASSED,
            finished=True,
        )
    return count


async def seed_mounts(count: int, session_id: str) -> int:
    """Create ``count`` external file mounts under one Session."""
    repository = SessionMountRepository()
    for index in range(count):
        await repository.create(
            session_id,
            LOCAL_USER,
            name=f"压力文件_{index:05d}.pdf",
            abs_path=f"/tmp/perf/files/压力文件_{index:05d}.pdf",
            kind="file",
        )
    return count
