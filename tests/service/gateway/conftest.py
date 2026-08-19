from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests._support.sandbox import IsolatedPaths


PROJECT_ROOT = Path(__file__).resolve().parents[3]
STARTUP_TIMEOUT_SECONDS = 20.0
SHUTDOWN_TIMEOUT_SECONDS = 10.0
CommandResult = subprocess.CompletedProcess[str]


def _reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _process_environment(test_sandbox: IsolatedPaths) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(test_sandbox.process_environment())
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    if os.name == "nt":
        environment["USERPROFILE"] = str(test_sandbox.home)
    return environment


@dataclass(slots=True)
class RunningGateway:
    """One production Gateway process isolated from the user's application data."""

    process: subprocess.Popen[bytes]
    command: list[str]
    environment: dict[str, str]
    runtime_file: Path
    runtime: dict[str, Any]
    log_file: Path

    @property
    def base_url(self) -> str:
        return f"http://{self.runtime['host']}:{self.runtime['port']}"

    @property
    def websocket_url(self) -> str:
        return f"ws://{self.runtime['host']}:{self.runtime['port']}{self.runtime['ws_path']}"

    def log_output(self) -> str:
        try:
            return self.log_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "<gateway log unavailable>"

    async def compete(self) -> subprocess.CompletedProcess[str]:
        """Try to start a second foreground process with the same instance lock."""
        def run() -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                self.command,
                cwd=PROJECT_ROOT,
                env=self.environment,
                capture_output=True,
                text=True,
                timeout=SHUTDOWN_TIMEOUT_SECONDS,
                check=False,
            )

        return await asyncio.to_thread(run)

    async def shutdown(self, require_graceful: bool = True) -> None:
        """Request cooperative shutdown and bound the cleanup of this exact process."""
        if self.process.poll() is not None:
            return

        graceful_error: BaseException | None = None
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=3) as client:
                response = await client.post(
                    "/api/gateway/shutdown",
                    headers={"Authorization": f"Bearer {self.runtime['token']}"},
                )
            if response.status_code != 202:
                graceful_error = AssertionError(
                    f"Gateway shutdown returned HTTP {response.status_code}: {response.text}"
                )
        except BaseException as exc:  # noqa: BLE001 - cleanup still owns the child
            graceful_error = exc

        try:
            await asyncio.to_thread(self.process.wait, SHUTDOWN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                await asyncio.to_thread(self.process.wait, 3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                await asyncio.to_thread(self.process.wait, 3)
            if graceful_error is None:
                graceful_error = AssertionError("Gateway did not exit after cooperative shutdown")

        if require_graceful and graceful_error is not None:
            raise AssertionError(
                f"Gateway shutdown failed: {graceful_error}\n{self.log_output()}"
            ) from graceful_error


@dataclass(slots=True)
class GatewayCLI:
    """The production lifecycle commands used by Desktop to manage a Gateway."""

    environment: dict[str, str]
    runtime_file: Path
    port: int
    owned_pid: int | None = None

    def _registered_pid(self) -> int | None:
        try:
            registered = json.loads(self.runtime_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None
        candidate = registered.get("pid")
        if registered.get("port") == self.port and isinstance(candidate, int):
            return candidate
        return None

    async def execute(self, *arguments: str, timeout: float = STARTUP_TIMEOUT_SECONDS) -> CommandResult:
        def run() -> CommandResult:
            return subprocess.run(
                [sys.executable, "-m", "src", "server", *arguments],
                cwd=PROJECT_ROOT,
                env=self.environment,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )

        return await asyncio.to_thread(run)

    async def status(self) -> dict[str, Any]:
        """Return the same JSON snapshot parsed by the Desktop process."""
        result = await self.execute("status")
        if result.returncode != 0:
            raise AssertionError(f"Gateway status failed: {result.stderr}")
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise AssertionError(f"Gateway status returned a non-object: {payload!r}")
        return payload

    async def start(self) -> CommandResult:
        """Run the background start command and remember only its registered PID."""
        result = await self.execute(
            "start",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--log-level",
            "warning",
            "--timeout",
            str(STARTUP_TIMEOUT_SECONDS),
            timeout=STARTUP_TIMEOUT_SECONDS + 5,
        )
        if result.returncode == 0:
            self.owned_pid = self._registered_pid()
        return result

    async def stop(self, force: bool = False) -> CommandResult:
        """Run the same stop command exposed to Desktop and other local clients."""
        arguments = ["stop", "--timeout", str(SHUTDOWN_TIMEOUT_SECONDS)]
        if force:
            arguments.append("--force")
        return await self.execute(*arguments, timeout=SHUTDOWN_TIMEOUT_SECONDS + 5)

    async def cleanup(self) -> None:
        """Bound cleanup to the exact daemon created by this test harness."""
        self.owned_pid = self.owned_pid or self._registered_pid()
        try:
            # The isolated lock can identify a daemon that has not published
            # runtime.json yet, so cleanup must not depend on knowing its PID.
            await self.stop(force=True)
        except (OSError, subprocess.TimeoutExpired):
            pass

        try:
            remaining = await self.status()
        except (AssertionError, json.JSONDecodeError, OSError, subprocess.TimeoutExpired):
            remaining = {}
        if remaining.get("status") == "stopped":
            return
        if remaining.get("status") == "running" and remaining.get("port") != self.port:
            return
        if remaining.get("status") == "running":
            candidate = remaining.get("pid")
            if isinstance(candidate, int):
                if self.owned_pid is not None and candidate != self.owned_pid:
                    return
                self.owned_pid = candidate
        self.owned_pid = self.owned_pid or self._registered_pid()
        if self.owned_pid is None:
            return
        if os.name == "nt":
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(self.owned_pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
        else:
            try:
                os.kill(self.owned_pid, 9)
            except ProcessLookupError:
                pass
        await asyncio.sleep(0.05)
        try:
            await self.stop(force=True)
        except (OSError, subprocess.TimeoutExpired):
            pass


@pytest.fixture
async def running_gateway(test_sandbox: IsolatedPaths) -> AsyncIterator[RunningGateway]:
    """Launch the production CLI, Uvicorn server, and Service lifespan."""
    port = _reserve_port()
    command = [
        sys.executable,
        "-m",
        "src",
        "server",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]
    environment = _process_environment(test_sandbox)

    runtime_file = test_sandbox.app_home / "runtime.json"
    log_file = test_sandbox.root / "gateway.log"
    launched_at = time.perf_counter()
    with log_file.open("wb") as log_handle:
        process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )

    runtime: dict[str, Any] | None = None
    deadline = launched_at + STARTUP_TIMEOUT_SECONDS
    while time.perf_counter() < deadline:
        if process.poll() is not None:
            pytest.fail(
                f"Gateway exited with code {process.returncode} during startup:\n"
                f"{log_file.read_text(encoding='utf-8', errors='replace')}"
            )
        try:
            candidate = json.loads(runtime_file.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            candidate = None
        if isinstance(candidate, dict) and candidate.get("pid") == process.pid:
            runtime = candidate
            break
        await asyncio.sleep(0.025)

    if runtime is None:
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, 3)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait, 3)
        pytest.fail(
            f"Gateway did not publish runtime.json within {STARTUP_TIMEOUT_SECONDS:.0f}s:\n"
            f"{log_file.read_text(encoding='utf-8', errors='replace')}"
        )

    gateway = RunningGateway(
        process=process,
        command=command,
        environment=environment,
        runtime_file=runtime_file,
        runtime=runtime,
        log_file=log_file,
    )
    try:
        yield gateway
    finally:
        await gateway.shutdown(require_graceful=False)


@pytest.fixture
async def gateway_cli(test_sandbox: IsolatedPaths) -> AsyncIterator[GatewayCLI]:
    """Expose isolated production lifecycle commands without starting a daemon."""
    gateway = GatewayCLI(
        environment=_process_environment(test_sandbox),
        runtime_file=test_sandbox.app_home / "runtime.json",
        port=_reserve_port(),
    )
    try:
        yield gateway
    finally:
        await gateway.cleanup()


__all__ = ["GatewayCLI", "RunningGateway"]
