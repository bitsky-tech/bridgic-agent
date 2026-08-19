"""The bundled interpreter must never write bytecode into the app bundle.

macOS seals every file under a signed .app. CPython writing `__pycache__/*.pyc`
next to the standard library it just imported adds files the seal does not
cover, and `codesign --verify` then reports "a sealed resource is missing or
invalid" for an app that shipped perfectly signed. Observed on a real install:
170 .pyc files across 24 directories under
Contents/Resources/python_runtime/.../lib/python3.13/.

`BundledUPythonRuntime.apply()` already redirects PYTHONPYCACHEPREFIX for user
commands, but that does not cover this: the probes below run the interpreter
with `-I`, which implies `-E` and therefore discards every PYTHON* variable.
Only the command-line switch survives isolated mode.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from src.amphi_agent.runtime._python_env import (
    BundledUPythonRuntime,
    BundledUvRuntime,
    isolated_python_command,
    no_bytecode_environment,
)
from src.amphi_agent.runtime._resources import BundledRuntimeResources


def test_isolated_probes_refuse_to_write_bytecode() -> None:
    """`-I` discards PYTHONPYCACHEPREFIX, so the switch has to be on the command."""
    command = isolated_python_command(Path("/opt/py/bin/python"), "-c", "import pip")

    assert command[0] == "/opt/py/bin/python"
    assert "-I" in command
    assert "-B" in command
    # The trailing arguments must stay in order and stay last.
    assert command[-2:] == ["-c", "import pip"]


def test_bytecode_switch_precedes_the_script_arguments() -> None:
    """`-B` after `-c` would be read as an argument to the script, not a flag."""
    command = isolated_python_command(Path("/opt/py/bin/python"), "-m", "ensurepip")

    assert command.index("-B") < command.index("-m")


def test_environment_stops_interpreters_we_cannot_pass_flags_to() -> None:
    """uv spawns the interpreter itself, so the only lever left is the env."""
    environment = no_bytecode_environment({"PATH": "/usr/bin"})

    assert environment["PYTHONDONTWRITEBYTECODE"] == "1"
    assert environment["PATH"] == "/usr/bin", "must not disturb the rest of the env"


def test_environment_helper_does_not_mutate_the_caller_mapping() -> None:
    """Callers build one env dict and reuse it; silent mutation would leak."""
    original = {"PATH": "/usr/bin"}
    no_bytecode_environment(original)

    assert "PYTHONDONTWRITEBYTECODE" not in original


def test_every_bundled_interpreter_probe_is_protected(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Whole-class sweep: no probe may reach the interpreter unprotected.

    Asserted over captured argv rather than per call site, so a probe added
    later fails here instead of silently re-breaking the signature.
    """
    resources = BundledRuntimeResources(source_root=tmp_path)
    runtime = BundledUPythonRuntime(
        uv_runtime=BundledUvRuntime(resources=resources, data_home=tmp_path),
        resources=resources,
        data_home=tmp_path,
    )
    python = runtime.python_executable
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text("", encoding="utf-8")

    captured: list[tuple[list[str], dict[str, str] | None]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured.append((command, kwargs.get("env")))  # type: ignore[arg-type]
        return subprocess.CompletedProcess(command, 0, "/tmp/site-packages\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(runtime, "executable", lambda: python)

    runtime._site_packages()
    runtime._pip_imports()
    runtime.version()

    # Guard against a vacuous pass: if a probe stopped invoking the interpreter
    # the loop below would assert nothing at all.
    interpreter_calls = [c for c in captured if str(python) in c[0][0]]
    assert len(interpreter_calls) == 3, f"expected all three probes, got {captured}"

    for command, environment in interpreter_calls:
        protected = "-B" in command or (environment or {}).get("PYTHONDONTWRITEBYTECODE") == "1"
        assert protected, f"unprotected interpreter call: {command}"


def test_ensurepip_is_not_isolated_because_isolation_propagates(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """ensurepip must not get `-I`, or it hands isolation to a child with no `-B`.

    CPython's ensurepip runs pip through a subprocess and forwards the flag
    itself (`if sys.flags.isolated: cmd.insert(1, '-I')`), but never adds `-B`
    to that command. The grandchild then compiles pip's whole dependency tree
    into the signed bundle -- 164 files, measured on a packaged build. Dropping
    `-I` is what lets PYTHONDONTWRITEBYTECODE reach it.
    """
    resources = BundledRuntimeResources(source_root=tmp_path)
    runtime = BundledUPythonRuntime(
        uv_runtime=BundledUvRuntime(resources=resources, data_home=tmp_path),
        resources=resources,
        data_home=tmp_path,
    )
    runtime.python_executable.parent.mkdir(parents=True, exist_ok=True)
    runtime.python_executable.write_text("", encoding="utf-8")

    captured: list[tuple[list[str], dict[str, str] | None]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured.append((command, kwargs.get("env")))  # type: ignore[arg-type]
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    # Absent on the way in (so the install runs), present on the way out (so the
    # post-check passes) -- exactly the transition a real install makes.
    availability = iter([False, True, True])
    monkeypatch.setattr(runtime, "_pip_available", lambda: next(availability, True))
    monkeypatch.setattr(runtime, "_pip_imports", lambda: False)

    runtime._ensure_pip()

    ensurepip = [c for c in captured if "ensurepip" in c[0]]
    assert ensurepip, f"expected an ensurepip invocation, got {captured}"
    command, environment = ensurepip[0]
    assert "-I" not in command, "isolation would propagate to the pip subprocess"
    assert "-B" in command
    assert (environment or {}).get("PYTHONDONTWRITEBYTECODE") == "1"
    # `-m` puts the CWD on sys.path[0], and the CWD here is the writable shared
    # base. `-I` used to close that; `-P` closes it without also discarding the
    # environment we need PYTHONDONTWRITEBYTECODE to travel through.
    assert "-P" in command, "dropping -I without -P reopens CWD injection"


def test_probe_environment_strips_interpreter_hooks() -> None:
    """The env is the only isolation left for ensurepip, so it must be scrubbed.

    Without `-E` (which `-I` implied) the caller's PYTHON* variables reach both
    ensurepip and the pip subprocess it spawns. PYTHONBREAKPOINT is the sharp
    one: it names an importable callable that the interpreter will run.
    """
    scrubbed = no_bytecode_environment(
        {"PATH": "/usr/bin", "PYTHONBREAKPOINT": "evil.module:run"}
    )

    assert scrubbed["PYTHONDONTWRITEBYTECODE"] == "1"
    assert "PYTHONBREAKPOINT" not in scrubbed
    assert scrubbed["PATH"] == "/usr/bin", "must not disturb the rest of the env"
