import os
import sys
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest

from src.amphi_agent import AgentInvocation, InvocationDisposition
from src.amphi_agent.cognitive import base as base_module
from src.amphi_agent.runtime._environment import AppCommandEnvironmentSnapshot, app_command_environment
from src.amphi_service.runtime._session_events import SessionEventBroker
from src.amphi_service.runtime._system_events import SystemEventBroker
from src.amphi_store import SessionRecord, SessionRepository, SessionTurnRepository, UserRepository
from tests._support.sandbox import IsolatedPaths
from tests.service.flows._scripted_llm import ScriptedLlm


async def test_round_usage_survives_turn_persistence(agent_store: None, agent_model: str, test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """A real two-round Invocation persists distinct measurements and one Turn total."""
    usage = [
        {"input_tokens": 40, "output_tokens": 10, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 10},
        {"input_tokens": 120, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 90, "cache_write_tokens": 30}},
    ]

    class MeasuredLlm(ScriptedLlm):
        async def stream_turn(self, messages, tools, *, publish, extra_body=None):
            result = await super().stream_turn(messages, tools, publish=publish, extra_body=extra_body)
            return replace(result, usage=usage[len(self.turn_calls) - 1])

    class StaticLlms:
        async def resolve(self, _user, _model):
            return llm

    environment = {**test_sandbox.process_environment(), "PATH": os.environ.get("PATH", "")}
    snapshot = AppCommandEnvironmentSnapshot(
        environment=MappingProxyType(environment),
        managed_environment=MappingProxyType(dict(environment)),
        uv_executable=None,
        uv_version=None,
        python_executable=Path(sys.executable),
        python_version=sys.version.split()[0],
        node_executable=None,
        node_version=None,
    )
    monkeypatch.setattr(app_command_environment, "snapshot", lambda: snapshot)
    clock = iter((10.0, 11.25, 20.0, 20.5))
    monkeypatch.setattr(base_module, "time", SimpleNamespace(monotonic=lambda: next(clock)))
    await UserRepository().set_execution_mode("local", "full")
    session = SessionRecord(
        id="round-usage", user_id="local", title="Round usage persistence",
        workspace_root=str(test_sandbox.sessions / "round-usage"),
    )
    await SessionRepository().save(session)
    work = Path(session.workspace_root) / ".work"
    work.mkdir(parents=True)
    (work / "input.txt").write_text("Measured input.\n", encoding="utf-8")
    llm = MeasuredLlm(model=agent_model)
    llm.enqueue_tool("read_file", {"file_path": "input.txt"}, call_id="read-usage")
    llm.enqueue_text("Finished.")
    invocation = AgentInvocation(StaticLlms(), SessionEventBroker(), SystemEventBroker())
    try:
        result = await (await invocation.arun(session.id, "Read input.txt and summarize it."))
        assert result.outcome.disposition is InvocationDisposition.COMPLETED
        saved = await SessionTurnRepository().latest(session.id, "local")
        assert saved is not None
        rounds = saved.ota_records
        assert len(rounds) == 2
        assert [row["model_duration_ms"] for row in rounds] == [1250, 500]
        assert all(row["model_call_started"] and row["model_id"] == agent_model for row in rounds)
        assert [row["usage"]["prompt_tokens"] for row in rounds] == [100, 120]
        assert [row["usage"]["completion_tokens"] for row in rounds] == [10, 20]
        assert [row["usage"]["prompt_tokens_details"]["cached_tokens"] for row in rounds] == [50, 90]
        assert rounds[0]["usage"]["cache_creation_input_tokens"] == 10
        assert rounds[1]["usage"]["cache_creation_input_tokens"] == 30
        assert saved.context_usage["input_tokens"] == 220
        assert saved.context_usage["output_tokens"] == 30
        assert saved.context_usage["cached_input_tokens"] == 90
        llm.assert_finished()
    finally:
        await invocation.shutdown()
