from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any, Optional, Sequence

import httpx

from ..amphi_service.server import ServerManager


class AgentCLI:
    """Run an Agent through the active local Bridgic Agent daemon."""

    SESSION_ID_ENV = "SESSION_ID"
    PARENT_TOOL_CALL_ID_ENV = "PARENT_TOOL_CALL_ID"
    EXECUTION_MODE_ENV = "EXECUTION_MODE"
    POLL_INTERVAL_SECONDS = 0.5

    def __init__(self, manager: Optional[ServerManager] = None) -> None:
        self._manager = manager or ServerManager()

    def main(self, argv: Optional[Sequence[str]] = None) -> int:
        """Parse and execute ``amphi agent`` commands.

        Parameters
        ----------
        argv : Optional[Sequence[str]]
            Arguments following ``amphi agent``. ``None`` reads process argv.

        Returns
        -------
        int
            Process exit code.
        """
        parser = argparse.ArgumentParser(
            prog="amphi agent",
            description="Run an Agent through the local Bridgic Agent daemon.",
        )
        commands = parser.add_subparsers(dest="command", required=True)
        run = commands.add_parser("run", help="Run an Agent with the supplied input.")
        run.add_argument("input", nargs="+", help="Input passed to the Agent.")
        args = parser.parse_args(list(argv) if argv is not None else None)

        try:
            answer = self._run(" ".join(args.input))
        except (RuntimeError, httpx.HTTPError) as exc:
            print(f"amphi agent run: {exc}", file=sys.stderr)
            return 1
        print(answer)
        return 0

    def _run(self, user_input: str) -> str:
        status = self._manager.status()
        server = status.instance
        if status.state != "running" or server is None:
            raise RuntimeError("the Bridgic Agent daemon is not running")

        headers = (
            {"Authorization": f"Bearer {server.token}"}
            if server.token
            else {}
        )
        with httpx.Client(
            base_url=server.base_url(),
            headers=headers,
            timeout=None,
        ) as client:
            parent_session_id = os.environ.get(self.SESSION_ID_ENV)
            if parent_session_id:
                payload = {
                    "input": user_input,
                    "parent_tool_call_id": os.environ.get(self.PARENT_TOOL_CALL_ID_ENV),
                }
                execution_mode = os.environ.get(self.EXECUTION_MODE_ENV)
                if execution_mode:
                    payload["execution_mode"] = execution_mode
                response = client.post(
                    f"/api/agent/sessions/{parent_session_id}/subagents",
                    json=payload,
                )
            else:
                session = self._json(client.post("/sessions", json={}))
                response = client.post(
                    f"/api/agent/sessions/{session['id']}/run",
                    json={"input": user_input},
                )

            result = self._json(response)
            if result.get("disposition") == "completed":
                return str(result.get("answer") or "")
            return self._await_terminal(client, str(result["session_id"]))

    def _await_terminal(self, client: httpx.Client, session_id: str) -> str:
        """Wait while a parked Agent is resumed through its normal Session UI."""
        while True:
            time.sleep(self.POLL_INTERVAL_SECONDS)
            result = self._json(client.get(f"/api/agent/sessions/{session_id}/run"))
            status = result.get("status")
            if status == "completed":
                return str(result.get("answer") or "")
            if status in {"failed", "cancelled"}:
                detail = result.get("error") or f"Agent Session {session_id!r} {status}"
                raise RuntimeError(str(detail))

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            try:
                detail = response.json().get("detail")
            except (ValueError, AttributeError):
                detail = None
            raise RuntimeError(detail or str(exc)) from exc
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("the Bridgic Agent daemon returned an invalid response")
        return payload


__all__ = ["AgentCLI"]
