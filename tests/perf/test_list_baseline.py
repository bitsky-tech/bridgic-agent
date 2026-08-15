"""Perf baselines for the list endpoints that currently return everything.

Purpose: turn "this will be a problem someday" into numbers we can hold a fix
against. Each test seeds one scale, times the real HTTP GET through the ASGI
transport (no network noise — this measures handler + DB + serialization only)
and prints a row of the baseline table.

Opt-in: `AMPHI_RUN_PERF_TESTS=1 uv run pytest tests/perf -s` (the -s matters,
the numbers go to stdout). `tests/conftest.py` ignores this package otherwise.

These assert only on gross regressions, not on wall-clock targets: absolute
timings differ per machine, so the value is the printed comparison across
scales, and later across before/after a pagination change.

Measured 2026-07-30 (M-series mac, ASGI transport, SQLite on tmpfs)::

    GET /sessions        50 →   4.1ms   11.7KiB | 1000 →  12.1ms  234.3KiB
    GET /{id}/messages   50 →   3.5ms   48.9KiB | 1000 →  20.2ms  991.9KiB
    GET /workflow-runs  100 →   3.9ms   34.8KiB | 2000 →   6.5ms   35.0KiB (!)
    GET /mounts          50 →   4.0ms   15.1KiB | 2000 →  52.4ms  605.5KiB

Read-out: the DB + serialization path is NOT the bottleneck — every endpoint
stays under ~50ms even at the largest realistic scale. Two things do stand out:

1. ``/workflow-runs`` returns a constant 100 rows regardless of how many exist,
   because the handler's default ``limit=100`` is never overridden by the
   client. That is the silent-truncation bug, visible here as a flat payload.
2. Payload size grows unbounded (≈1MiB for a 1000-turn transcript). That cost
   lands on HTTP transfer + ``JSON.parse`` + React state, not on the server —
   which is why the renderer baseline (``list-perf-baseline.test.tsx``) matters
   more than these numbers for prioritizing the fix.
"""

from __future__ import annotations

import time
from typing import Tuple

import httpx
import pytest

from ._seed import seed_mounts, seed_sessions, seed_turns, seed_workflow_runs

pytestmark = pytest.mark.perf


async def _timed_get(client: httpx.AsyncClient, url: str) -> Tuple[float, int, int]:
    """Return (elapsed_ms, payload_bytes, row_count) for one GET."""
    started = time.perf_counter()
    response = await client.get(url)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert response.status_code == 200, response.text
    payload = response.json()
    rows = payload if isinstance(payload, list) else payload.get("messages", payload)
    return elapsed_ms, len(response.content), len(rows) if isinstance(rows, list) else -1


def _report(label: str, scale: int, elapsed_ms: float, payload_bytes: int, rows: int) -> None:
    print(
        f"\n[baseline] {label:<24} scale={scale:>5}  "
        f"{elapsed_ms:>8.1f}ms  {payload_bytes / 1024:>9.1f}KiB  rows={rows}",
    )


@pytest.mark.parametrize("scale", [50, 300, 1000])
async def test_sessions_list_baseline(client: httpx.AsyncClient, scale: int) -> None:
    """GET /sessions — no pagination; the sidebar loads every Session."""
    await seed_sessions(scale)
    elapsed_ms, payload_bytes, rows = await _timed_get(client, "/sessions")
    _report("GET /sessions", scale, elapsed_ms, payload_bytes, rows)
    assert rows == scale


@pytest.mark.parametrize("scale", [50, 300, 1000])
async def test_session_messages_baseline(client: httpx.AsyncClient, scale: int) -> None:
    """GET /sessions/{id}/messages — no pagination; one Session's whole transcript."""
    session_id = (await seed_sessions(1, prefix="turns"))[0]
    await seed_turns(session_id, scale)
    elapsed_ms, payload_bytes, rows = await _timed_get(
        client, f"/sessions/{session_id}/messages",
    )
    _report("GET /{id}/messages", scale, elapsed_ms, payload_bytes, rows)


@pytest.mark.parametrize("scale", [100, 500, 2000])
async def test_workflow_runs_baseline(client: httpx.AsyncClient, scale: int) -> None:
    """GET /workflow-runs — paginated, but the default limit=100 truncates silently."""
    session_id = (await seed_sessions(1, prefix="runs"))[0]
    await seed_workflow_runs(scale, session_id)
    elapsed_ms, payload_bytes, rows = await _timed_get(client, "/workflow-runs")
    _report("GET /workflow-runs", scale, elapsed_ms, payload_bytes, rows)
    # Documents the P0 bug: the default page caps at 100 no matter the scale.
    assert rows == min(scale, 100)


@pytest.mark.parametrize("scale", [50, 500, 2000])
async def test_mounts_baseline(client: httpx.AsyncClient, scale: int) -> None:
    """GET /mounts — no pagination; every mount of every Session, forever."""
    session_id = (await seed_sessions(1, prefix="mounts"))[0]
    await seed_mounts(scale, session_id)
    elapsed_ms, payload_bytes, rows = await _timed_get(client, "/mounts")
    _report("GET /mounts", scale, elapsed_ms, payload_bytes, rows)
    assert rows >= scale
