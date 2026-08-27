import json
import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

import src.amphi_agent.runtime._python_env as python_env_module
from src.amphi_agent.runtime._errors import BundledRuntimeUnavailable, EnvNotReady
from src.amphi_agent.runtime._node_env import BundledNodeBaseRuntime, BundledNodeRuntime
from src.amphi_agent.runtime._probe import BaseProbe, ProbeResult
from src.amphi_agent.runtime._python_env import BundledUPythonRuntime, BundledUvRuntime
from src.amphi_agent.runtime._resources import BundledRuntimeResources
from tests._support.sandbox import IsolatedPaths


_PythonBaseSetup = tuple[Path, list[list[str]], Callable[[], BundledUPythonRuntime]]
_NodeBaseSetup = tuple[Path, Callable[[], BundledNodeBaseRuntime]]


def _python_base(paths: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> _PythonBaseSetup:
    bundle = paths.root / "python-bundle"
    uv_bin = bundle / "uv" / "bin"
    uv_bin.mkdir(parents=True)
    (uv_bin / ("uv.exe" if os.name == "nt" else "uv")).write_text(
        "uv-v1",
        encoding="utf-8",
    )
    bundled_python = bundle / ("python.exe" if os.name == "nt" else "python3")
    bundled_python.write_text("python-v1", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_UV_BIN_DIR", str(uv_bin))
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON", str(bundled_python))
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        argv = [str(part) for part in command]
        commands.append(argv)
        if len(argv) > 1 and argv[1] == "venv":
            base = Path(argv[-1])
            bin_dir = base / ("Scripts" if os.name == "nt" else "bin")
            bin_dir.mkdir(parents=True, exist_ok=True)
            (bin_dir / ("python.exe" if os.name == "nt" else "python")).write_text(
                "shared-python",
                encoding="utf-8",
            )
            (bin_dir / ("pip.exe" if os.name == "nt" else "pip")).write_text(
                "shared-pip",
                encoding="utf-8",
            )
            (base / "pyvenv.cfg").write_text("home = bundled\n", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "", "")
        if "import pip" in argv:
            return subprocess.CompletedProcess(command, 0, "", "")
        raise AssertionError(f"Unexpected Python base subprocess: {argv}")

    monkeypatch.setattr(python_env_module.subprocess, "run", fake_run)

    def make_runtime() -> BundledUPythonRuntime:
        resources = BundledRuntimeResources(source_root=paths.root / "no-source-runtime")
        uv_runtime = BundledUvRuntime(
            resources=resources,
            data_home=paths.app_home,
        )
        return BundledUPythonRuntime(
            uv_runtime=uv_runtime,
            resources=resources,
            data_home=paths.app_home,
        )

    return bundled_python, commands, make_runtime


def _node_base(paths: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> _NodeBaseSetup:
    runtime_root = paths.root / "node-bundle"
    if os.name == "nt":
        bin_dir = runtime_root
        npm_dir = runtime_root / "node_modules" / "npm" / "bin"
        node_name = "node.exe"
    else:
        bin_dir = runtime_root / "bin"
        npm_dir = runtime_root / "lib" / "node_modules" / "npm" / "bin"
        node_name = "node"
    bin_dir.mkdir(parents=True)
    npm_dir.mkdir(parents=True)
    node = bin_dir / node_name
    node.write_text("node-v1", encoding="utf-8")
    (npm_dir / "npm-cli.js").write_text("npm", encoding="utf-8")
    (npm_dir / "npx-cli.js").write_text("npx", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(runtime_root))

    def make_runtime() -> BundledNodeBaseRuntime:
        resources = BundledRuntimeResources(source_root=paths.root / "no-source-runtime")
        return BundledNodeBaseRuntime(
            node_runtime=BundledNodeRuntime(resources=resources),
            data_home=paths.app_home,
        )

    return node, make_runtime


def _venv_calls(commands: list[list[str]]) -> int:
    return sum(len(command) > 1 and command[1] == "venv" for command in commands)


def test_resource_resolution(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final runtime Resources locations:

    {
      "operator_override": "/override/Resources",
      "source_checkout": "desktop/apps/electron/resources",
      "frozen_app": "<executable>/../.."
    }

    Checks:
    1. The explicit Resources override wins over every inferred application location.
    2. A source checkout resolves Electron's existing development Resources directory.
    3. A frozen executable resolves the Resources root two levels above its launcher.
    """
    override = test_sandbox.root / "override" / "Resources"
    monkeypatch.setenv("AMPHI_BUNDLED_RESOURCES_DIR", str(override))
    monkeypatch.setenv("AMPHI_BUNDLED_BIN_DIR", str(test_sandbox.root / "other" / "bin"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)

    # Check 1: An operator-selected root has absolute precedence and is normalized.
    selected = BundledRuntimeResources(source_root=test_sandbox.root / "missing")
    assert selected.directory() == override.resolve()

    monkeypatch.delenv("AMPHI_BUNDLED_RESOURCES_DIR")
    monkeypatch.delenv("AMPHI_BUNDLED_BIN_DIR")
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    source = test_sandbox.root / "checkout"
    (source / "pyproject.toml").parent.mkdir(parents=True)
    (source / "pyproject.toml").write_text("[project]\nname='runtime-test'\n", encoding="utf-8")
    source_resources = source / "desktop" / "apps" / "electron" / "resources"
    source_resources.mkdir(parents=True)

    # Check 2: Editable development discovers only the repository's actual Resources tree.
    assert BundledRuntimeResources(source_root=source).directory() == source_resources.resolve()

    frozen_resources = test_sandbox.root / "Frozen.app" / "Contents" / "Resources"
    executable = frozen_resources / "bin" / "amphi"
    executable.parent.mkdir(parents=True)
    executable.write_text("launcher", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))

    # Check 3: Frozen discovery stays adjacent to the executable instead of using source paths.
    assert BundledRuntimeResources(source_root=source).directory() == frozen_resources.resolve()


def test_runtime_validation(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final packaged-runtime validation:

    {
      "python_manifest_escape": "rejected",
      "contained_python": "accepted",
      "node_without_npm": "rejected before base creation"
    }

    Checks:
    1. Python discovery accepts a contained manifest executable and rejects a path escape.
    2. Node base preparation fails closed when the bundle omits npm or npx.
    """
    python_root = test_sandbox.root / "python-runtime"
    python_root.mkdir()
    outside = test_sandbox.root / "outside-python"
    outside.write_text("outside", encoding="utf-8")
    manifest = python_root / "runtime.json"
    manifest.write_text(json.dumps({"executable": "../outside-python"}), encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_PYTHON_RUNTIME_DIR", str(python_root))
    resources = BundledRuntimeResources(source_root=test_sandbox.root / "missing")
    uv_runtime = BundledUvRuntime(resources=resources, data_home=test_sandbox.app_home)

    # Check 1: Manifest paths cannot escape the read-only runtime directory.
    assert BundledUPythonRuntime(
        uv_runtime=uv_runtime,
        resources=resources,
        data_home=test_sandbox.app_home,
    ).bundled_executable() is None
    contained = python_root / "bin" / "python3"
    contained.parent.mkdir()
    contained.write_text("contained", encoding="utf-8")
    manifest.write_text(json.dumps({"executable": "bin/python3"}), encoding="utf-8")
    assert BundledUPythonRuntime(
        uv_runtime=uv_runtime,
        resources=resources,
        data_home=test_sandbox.app_home,
    ).bundled_executable() == contained.resolve()

    node_root = test_sandbox.root / "incomplete-node"
    (node_root / "bin").mkdir(parents=True)
    (node_root / "bin" / "node").write_text("node", encoding="utf-8")
    monkeypatch.setenv("AMPHI_BUNDLED_NODE_RUNTIME_DIR", str(node_root))
    node_base = BundledNodeBaseRuntime(
        node_runtime=BundledNodeRuntime(resources=resources),
        data_home=test_sandbox.app_home,
    )

    # Check 2: An incomplete Node package cannot manufacture a writable base.
    with pytest.raises(BundledRuntimeUnavailable, match="Bundled npm is unavailable"):
        node_base.ensure()
    assert not node_base.root.exists()


@pytest.mark.windows_runtime
def test_python_lifecycle(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final shared Python base:

    {
      "first_prepare": {"uv_venv_calls": 1},
      "same_identity": {"reused": true, "installed_files": "preserved"},
      "new_identity": {"migrated_in_place": true, "installed_files": "preserved"}
    }

    Checks:
    1. First preparation publishes one valid base without invoking a real runtime or network.
    2. A new runtime object reuses the compatible base and preserves installed files.
    3. A changed packaged interpreter refreshes the venv without replacing its files.
    """
    bundled_python, commands, make_runtime = _python_base(test_sandbox, monkeypatch)
    first = make_runtime()

    # Check 1: The isolated uv boundary publishes a valid app-owned Python base once.
    assert first.ensure() == first.python_executable
    assert first.python_executable.is_file()
    assert _venv_calls(commands) == 1
    old_manifest = (first.root / first.MANIFEST_NAME).read_text(encoding="utf-8")
    installed = first.root / "installed-package.txt"
    installed.write_text("keep", encoding="utf-8")

    second = make_runtime()

    # Check 2: Matching identity reuses the existing base rather than recreating it.
    assert second.ensure() == second.python_executable
    assert installed.read_text(encoding="utf-8") == "keep"
    assert _venv_calls(commands) == 1

    bundled_python.write_text("python-v2", encoding="utf-8")
    replacement = make_runtime()

    # Check 3: Identity drift rebinds the venv without deleting installed files.
    assert replacement.ensure() == replacement.python_executable
    assert installed.read_text(encoding="utf-8") == "keep"
    assert (replacement.root / replacement.MANIFEST_NAME).read_text(encoding="utf-8") != old_manifest
    assert _venv_calls(commands) == 2
    assert "--allow-existing" in next(
        command for command in reversed(commands) if len(command) > 1 and command[1] == "venv"
    )
    assert list(replacement.root.parent.glob(".base.stage.*")) == []
    assert list(replacement.root.parent.glob(".base.backup.*")) == []


@pytest.mark.windows_runtime
def test_python_invalid_metadata_is_repaired_in_place(
    test_sandbox: IsolatedPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A damaged identity is repaired without discarding installed files."""
    _bundled_python, commands, make_runtime = _python_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.root / "installed-package.txt"
    installed.write_text("keep", encoding="utf-8")
    (first.root / first.MANIFEST_NAME).write_text("{", encoding="utf-8")

    repaired = make_runtime()
    assert repaired.ensure() == repaired.python_executable
    assert installed.read_text(encoding="utf-8") == "keep"
    assert json.loads((repaired.root / repaired.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert _venv_calls(commands) == 2


@pytest.mark.windows_runtime
def test_python_apply(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Python command environment:

    {
      "PATH": ["shared-python-bin", "user-bin"],
      "interpreter": "shared Python base",
      "package_and_bytecode_state": "app-owned directories",
      "host_python_bindings": "removed"
    }

    Checks:
    1. Applying the real runtime replaces inherited interpreter and package bindings.
    2. Python package lookup and bytecode output stay inside app-owned state.
    3. Repeated application keeps the shared Python bin first without duplicating it.
    """
    _bundled_python, _commands, make_runtime = _python_base(test_sandbox, monkeypatch)
    runtime = make_runtime()
    user_bin = test_sandbox.root / "user-bin"
    environment = {
        "PATH": str(user_bin),
        "PyThOnPaTh": "/host/packages",
        "PYTHONHOME": "/host/python",
        "pythonstartup": "/host/startup.py",
        "PythonUserBase": "/host/user-base",
        "UV_PROJECT": "/host/project",
        "virtual_env": "/host/venv",
        "Uv_Project_Environment": "/host/project-env",
        "pip_prefix": "/host/prefix",
        "PIP_TARGET": "/host/target",
        "Pip_User": "1",
    }

    # Check 1: The shared base becomes the only interpreter and pip destination.
    runtime.apply(environment)
    assert environment["VIRTUAL_ENV"] == str(runtime.root)
    assert environment["UV_PROJECT_ENVIRONMENT"] == str(runtime.root)
    assert environment["UV_PYTHON"] == str(runtime.python_executable)
    assert environment["UV_PYTHON_DOWNLOADS"] == "never"
    assert environment["UV_PYTHON_PREFERENCE"] == "only-managed"
    assert environment["PIP_CONFIG_FILE"] == os.devnull
    assert environment["PIP_USER"] == "0"
    removed = {
        "pythonhome",
        "pythonpath",
        "pythonstartup",
        "pythonuserbase",
        "pip_prefix",
        "pip_target",
        "uv_project",
    }
    assert removed.isdisjoint(name.casefold() for name in environment)
    for name in ("virtual_env", "uv_project_environment", "pip_user"):
        assert sum(key.casefold() == name for key in environment) == 1

    # Check 2: Imports and generated bytecode cannot escape into host Python state.
    assert environment["PYTHONNOUSERSITE"] == "1"
    assert environment["PYTHONPYCACHEPREFIX"] == str(test_sandbox.app_home / "python" / "pycache")

    # Check 3: Reapplication is stable and leaves user commands behind the managed Python.
    runtime.apply(environment)
    assert environment["PATH"].split(os.pathsep) == [str(runtime.bin_dir), str(user_bin)]


@pytest.mark.windows_runtime
def test_python_recovery(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final interrupted Python installation:

    {
      "backup": "restored as base",
      "installed_files": "preserved",
      "partial_stage": "removed",
      "runtime_update": "migrated in place"
    }

    Checks:
    1. An interrupted backup remains the reusable authority when the active base is absent.
    2. A new runtime restores and migrates that backup without discarding its files.
    """
    bundled_python, commands, make_runtime = _python_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.root / "installed-package.txt"
    installed.write_text("keep", encoding="utf-8")
    installed_relative = installed.relative_to(first.root)
    backup = first.root.parent / ".base.backup.interrupted"
    stage = first.root.parent / ".base.stage.interrupted"
    first.root.replace(backup)
    stage.mkdir()
    (stage / "partial.txt").write_text("partial", encoding="utf-8")

    # Check 1: The interrupted state has one complete backup and no active base.
    assert not first.root.exists()
    assert (backup / first.MANIFEST_NAME).is_file()
    assert (backup / installed_relative).read_text(encoding="utf-8") == "keep"
    assert (stage / "partial.txt").is_file()

    bundled_python.write_text("python-v2", encoding="utf-8")
    recovered = make_runtime()
    assert recovered.ensure() == recovered.python_executable

    # Check 2: Recovery reinstalls and migrates the backup without losing its files.
    assert (recovered.root / installed_relative).read_text(encoding="utf-8") == "keep"
    assert _venv_calls(commands) == 2
    assert not backup.exists()
    assert not stage.exists()


@pytest.mark.windows_runtime
def test_python_migration_failure(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final failed Python in-place migration:

    {
      "replacement": "failed",
      "previous_base": "left in place with its identity and installed files",
      "installed_files": "preserved",
      "swap_debris": []
    }

    Checks:
    1. A uv refresh error propagates without replacing the previous base.
    2. The existing manifest and installed files remain intact.
    """
    bundled_python, _commands, make_runtime = _python_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.root / "installed-package.txt"
    installed.write_text("keep", encoding="utf-8")
    old_manifest = (first.root / first.MANIFEST_NAME).read_text(encoding="utf-8")
    bundled_python.write_text("python-v2", encoding="utf-8")
    replacement = make_runtime()
    normal_run = python_env_module.subprocess.run

    def fail_refresh(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        argv = [str(part) for part in command]
        if len(argv) > 1 and argv[1] == "venv":
            return subprocess.CompletedProcess(command, 1, "", "refresh blocked")
        return normal_run(command, **kwargs)

    monkeypatch.setattr(python_env_module.subprocess, "run", fail_refresh)

    # Check 1: A failed refresh leaves the previous root active.
    with pytest.raises(RuntimeError, match="refresh blocked"):
        replacement.ensure()
    assert (replacement.root / replacement.MANIFEST_NAME).read_text(encoding="utf-8") == old_manifest
    assert installed.read_text(encoding="utf-8") == "keep"

    # Check 2: No swap transaction is created around a user-owned environment.
    assert list(replacement.root.parent.glob(".base.stage.*")) == []
    assert list(replacement.root.parent.glob(".base.backup.*")) == []


@pytest.mark.windows_runtime
def test_node_lifecycle(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final shared Node base:

    {
      "first_prepare": {"resolver": true, "npm_shims": true},
      "same_identity": {"reused": true, "installed_packages": "preserved"},
      "new_identity": {"migrated_in_place": true, "installed_packages": "preserved"}
    }

    Checks:
    1. First preparation publishes the resolver, npm shims, and package directories.
    2. A matching packaged Node reuses the base and retains installed packages.
    3. A changed Node identity refreshes metadata without replacing packages.
    """
    bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    first = make_runtime()

    # Check 1: The first ensure creates every support file needed by shared npm commands.
    assert first.ensure() == first.root
    assert first.modules_dir.is_dir()
    assert first.bin_dir.is_dir()
    assert first.resolver_path.is_file()
    shim_suffix = ".cmd" if os.name == "nt" else ""
    assert (first.shim_dir / f"npm{shim_suffix}").is_file()
    assert (first.shim_dir / f"npx{shim_suffix}").is_file()
    installed = first.modules_dir / "kept-package" / "index.js"
    installed.parent.mkdir(parents=True)
    installed.write_text("keep", encoding="utf-8")
    old_manifest = (first.root / first.MANIFEST_NAME).read_text(encoding="utf-8")

    second = make_runtime()

    # Check 2: A compatible base survives process-local cache loss with packages intact.
    assert second.ensure() == second.root
    assert installed.read_text(encoding="utf-8") == "keep"

    bundled_node.write_text("node-v2", encoding="utf-8")
    replacement = make_runtime()

    # Check 3: Identity drift updates metadata without deleting installed packages.
    assert replacement.ensure() == replacement.root
    assert installed.read_text(encoding="utf-8") == "keep"
    assert (replacement.root / replacement.MANIFEST_NAME).read_text(encoding="utf-8") != old_manifest
    assert list(replacement.root.parent.glob(".base.stage.*")) == []
    assert list(replacement.root.parent.glob(".base.backup.*")) == []


@pytest.mark.windows_runtime
def test_node_invalid_metadata_is_repaired_in_place(
    test_sandbox: IsolatedPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Damaged app support files are repaired without discarding npm packages."""
    bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.modules_dir / "kept-package" / "index.js"
    installed.parent.mkdir(parents=True)
    installed.write_text("keep", encoding="utf-8")
    (first.root / first.MANIFEST_NAME).write_text("{", encoding="utf-8")
    first.resolver_path.unlink()

    repaired = make_runtime()
    assert repaired.ensure() == repaired.root
    assert installed.read_text(encoding="utf-8") == "keep"
    assert repaired.resolver_path.is_file()
    assert json.loads((repaired.root / repaired.MANIFEST_NAME).read_text(encoding="utf-8"))


@pytest.mark.windows_runtime
def test_unreadable_runtime_bases_are_never_quarantined(
    test_sandbox: IsolatedPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Repeated read failures leave both installed environments at their paths."""
    _bundled_python, _commands, make_python = _python_base(test_sandbox, monkeypatch)
    _bundled_node, make_node = _node_base(test_sandbox, monkeypatch)
    python = make_python()
    node = make_node()
    python.ensure()
    node.ensure()
    python_installed = python.root / "installed-package.txt"
    node_installed = node.modules_dir / "kept-package" / "index.js"
    python_installed.write_text("keep", encoding="utf-8")
    node_installed.parent.mkdir(parents=True)
    node_installed.write_text("keep", encoding="utf-8")

    denied = PermissionError("base access denied")
    unreadable_python = make_python()
    unreadable_node = make_node()
    monkeypatch.setattr(
        unreadable_python,
        "_probe",
        lambda root, _identity: BaseProbe(ProbeResult.UNREADABLE, root, denied),
    )
    monkeypatch.setattr(
        unreadable_node,
        "_probe_compatible",
        lambda root, _identity: BaseProbe(ProbeResult.UNREADABLE, root, denied),
    )

    for _attempt in range(5):
        with pytest.raises(EnvNotReady, match="base access denied"):
            unreadable_python.ensure()
        with pytest.raises(EnvNotReady, match="base access denied"):
            unreadable_node.ensure()

    assert python_installed.read_text(encoding="utf-8") == "keep"
    assert node_installed.read_text(encoding="utf-8") == "keep"
    assert list(python.root.parent.glob(".base.backup.*")) == []
    assert list(node.root.parent.glob(".base.backup.*")) == []


@pytest.mark.windows_runtime
def test_node_apply(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Node command environment:

    {
      "PATH": ["npm-shims", "bundled-node", "shared-package-bin", "user-bin"],
      "npm_storage": "shared app-owned base and cache",
      "module_resolution": "shared modules through the app resolver",
      "host_node_bindings": "replaced"
    }

    Checks:
    1. Applying the real runtime replaces inherited npm and module bindings.
    2. Node, npm, npx, and installed package commands resolve in managed order.
    3. Repeated application preserves one stable managed PATH prefix.
    """
    _bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    runtime = make_runtime()
    bundled_bin = runtime.node_runtime.bin_dir()
    assert bundled_bin is not None
    user_bin = test_sandbox.root / "user-bin"
    environment = {
        "PATH": os.pathsep.join((str(runtime.bin_dir), str(user_bin), str(bundled_bin))),
        "NPM_CONFIG_PREFIX": "/host/prefix",
        "Npm_Config_Cache": "/host/cache",
        "npm_config_global": "false",
        "NPM_CONFIG_NPX_CACHE": "/host/npx",
        "node_path": "/host/modules",
        "Node_Options": "--inspect",
    }

    # Check 1: Every package and module binding points at the shared app-owned base.
    runtime.apply(environment)
    assert environment["npm_config_prefix"] == str(runtime.root)
    assert environment["npm_config_cache"] == str(runtime.cache)
    assert environment["npm_config_global"] == "true"
    assert environment["npm_config_npx_cache"] == str(runtime.root / ".amphi" / "npx")
    assert environment["NODE_PATH"] == str(runtime.modules_dir)
    resolver = runtime.resolver_path.resolve().as_posix()
    assert environment["NODE_OPTIONS"] == f"--require {json.dumps(resolver, ensure_ascii=False)}"
    managed_names = {
        "npm_config_prefix",
        "npm_config_cache",
        "npm_config_global",
        "npm_config_npx_cache",
        "node_path",
        "node_options",
    }
    for name in managed_names:
        assert sum(key.casefold() == name for key in environment) == 1

    # Check 2: Tool commands resolve through app shims, bundled Node, and shared packages.
    expected_prefix = [str(runtime.shim_dir), str(bundled_bin), str(runtime.bin_dir)]
    assert environment["PATH"].split(os.pathsep) == [*expected_prefix, str(user_bin)]

    # Check 3: Reapplication cannot duplicate or reorder managed command directories.
    runtime.apply(environment)
    assert environment["PATH"].split(os.pathsep) == [*expected_prefix, str(user_bin)]


@pytest.mark.windows_runtime
def test_node_module_resolver(node_commands) -> None:
    """The generated resolver serves the shared package to CommonJS and ESM callers."""
    commonjs = node_commands.run(
        [str(node_commands.node), str(node_commands.commonjs)],
        node_commands.environment,
    )
    esm = node_commands.run(
        [str(node_commands.node), str(node_commands.esm)],
        node_commands.environment,
    )
    assert commonjs.stdout.strip() == "shared-value"
    assert esm.stdout.strip() == "shared-value"


@pytest.mark.windows_runtime
def test_npm_command_proxy(node_commands) -> None:
    """The npm shim removes caller storage overrides and enforces app-owned storage."""
    test_sandbox = node_commands
    runtime = node_commands.runtime
    environment = node_commands.environment
    run = node_commands.run
    shim_command = node_commands.shim_command

    npm_capture = test_sandbox.root / "npm-capture.json"
    npm_environment = {**environment, "AMPHI_TEST_CAPTURE": str(npm_capture)}
    run(
        shim_command(
            "npm",
            "view",
            "shared-package",
            "--prefix=/host-prefix",
            "--cache=/host-cache",
        ),
        npm_environment,
    )
    npm_result = json.loads(npm_capture.read_text(encoding="utf-8"))

    # npm receives only the proxy's app-owned storage bindings.
    assert npm_result["args"] == [
        "--global",
        f"--prefix={runtime.root}",
        f"--cache={runtime.cache}",
        "view",
        "shared-package",
    ]
    assert npm_result == {
        "args": npm_result["args"],
        "privateDependency": "bundled-private-dependency",
        "prefix": str(runtime.root),
        "cache": str(runtime.cache),
        "global": "true",
        "npxCache": str(runtime.root / ".amphi" / "npx"),
    }


@pytest.mark.windows_runtime
def test_installed_node_package_commands(node_commands) -> None:
    """npx and npm exec reuse installed shared packages without installing again."""
    test_sandbox = node_commands
    runtime = node_commands.runtime
    environment = node_commands.environment
    run = node_commands.run
    shim_command = node_commands.shim_command
    npm_install_capture = test_sandbox.root / "unexpected-npm-install.json"
    npx_cases = {
        "implicit": (
            ["shared-package", "--flag"],
            ["shared-package", "--flag"],
        ),
        "explicit": (
            ["--package=shared-package", "shared-command", "--package", "output"],
            ["shared-command", "--package", "output"],
        ),
    }
    # npx supports its common implicit form and strips only outer package requests.
    for label, (arguments, forwarded) in npx_cases.items():
        npx_capture = test_sandbox.root / f"npx-{label}-capture.json"
        npx_environment = {
            **environment,
            "AMPHI_TEST_CAPTURE": str(npx_capture),
            "AMPHI_TEST_NPM_INSTALL_CAPTURE": str(npm_install_capture),
        }
        run(shim_command("npx", *arguments), npx_environment)
        npx_result = json.loads(npx_capture.read_text(encoding="utf-8"))
        assert not npm_install_capture.exists()
        assert npx_result == {
            "args": forwarded,
            "privateDependency": "bundled-private-dependency",
            "prefix": str(runtime.root),
            "cache": str(runtime.cache),
            "global": "true",
            "npxCache": str(runtime.root / ".amphi" / "npx"),
        }

    # npm exec aliases reuse implicit and explicit packages without hiding command arguments.
    exec_cases = {
        "exec": (
            ["exec", "--", "shared-package", "--flag"],
            ["exec", "--", "shared-package", "--flag"],
        ),
        "x-before-command": (
            [
                "--package",
                "shared-package",
                "x",
                "shared-command",
                "--",
                "--package",
                "output",
            ],
            ["x", "shared-command", "--", "--package", "output"],
        ),
        "x-after-command": (
            ["x", "shared-command", "--package=shared-package", "--", "--flag"],
            ["x", "shared-command", "--", "--flag"],
        ),
    }
    for alias, (arguments, forwarded) in exec_cases.items():
        exec_capture = test_sandbox.root / f"npm-{alias}-capture.json"
        install_capture = test_sandbox.root / f"unexpected-{alias}-install.json"
        exec_environment = {
            **environment,
            "AMPHI_TEST_CAPTURE": str(exec_capture),
            "AMPHI_TEST_NPM_INSTALL_CAPTURE": str(install_capture),
        }
        run(
            shim_command(
                "npm",
                "--prefix=/host-prefix",
                "--cache=/host-cache",
                *arguments,
            ),
            exec_environment,
        )
        assert not install_capture.exists()
        exec_result = json.loads(exec_capture.read_text(encoding="utf-8"))
        assert exec_result == {
            "args": ["--global", f"--cache={runtime.cache}", *forwarded],
            "privateDependency": "bundled-private-dependency",
            "prefix": str(runtime.root),
            "cache": str(runtime.cache),
            "global": "true",
            "npxCache": str(runtime.root / ".amphi" / "npx"),
        }


def test_playwright_node(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final Playwright driver selection:

    {
      "explicit_override": "preserved",
      "default_packaged_app": "bundled Node executable"
    }

    Checks:
    1. An explicit Playwright Node selection has priority over packaged discovery.
    2. Without an override, the real selector binds Playwright to packaged Node.
    """
    bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    runtime = make_runtime().node_runtime
    override = test_sandbox.root / "operator-node"
    monkeypatch.setenv("PLAYWRIGHT_NODEJS_PATH", str(override))

    # Check 1: Caller intent remains untouched even when a packaged executable exists.
    runtime.apply_playwright_env()
    assert os.environ["PLAYWRIGHT_NODEJS_PATH"] == str(override)

    # Check 2: The normal packaged-app path selects the bundled executable directly.
    monkeypatch.delenv("PLAYWRIGHT_NODEJS_PATH")
    runtime.apply_playwright_env()
    assert os.environ["PLAYWRIGHT_NODEJS_PATH"] == str(bundled_node.resolve())


@pytest.mark.windows_runtime
def test_node_recovery(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final interrupted Node installation:

    {
      "backup": "restored as base",
      "installed_packages": "preserved",
      "partial_stage": "removed"
    }

    Checks:
    1. A complete backup remains distinguishable from an abandoned partial stage.
    2. Ensure restores the backup and preserves the shared package tree.
    """
    bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.modules_dir / "kept-package" / "index.js"
    installed.parent.mkdir(parents=True)
    installed.write_text("keep", encoding="utf-8")
    backup = first.root.parent / ".base.backup.interrupted"
    stage = first.root.parent / ".base.stage.interrupted"
    first.root.replace(backup)
    stage.mkdir()
    (stage / "partial.txt").write_text("partial", encoding="utf-8")

    # Check 1: Only the backup contains a complete shared-base identity and package tree.
    assert not first.root.exists()
    assert (backup / first.MANIFEST_NAME).is_file()
    assert (backup / installed.relative_to(first.root)).read_text(encoding="utf-8") == "keep"
    assert (stage / "partial.txt").is_file()

    bundled_node.write_text("node-v2", encoding="utf-8")
    recovered = make_runtime()
    assert recovered.ensure() == recovered.root

    # Check 2: Recovery makes the backup active and removes both interrupted directories.
    assert (recovered.root / installed.relative_to(first.root)).read_text(encoding="utf-8") == "keep"
    assert not backup.exists()
    assert not stage.exists()


@pytest.mark.windows_runtime
def test_node_migration_failure(test_sandbox: IsolatedPaths, monkeypatch: pytest.MonkeyPatch) -> None:
    """Final failed Node in-place migration:

    {
      "replacement": "failed",
      "previous_base": "left in place",
      "installed_packages": "preserved",
      "swap_debris": []
    }

    Checks:
    1. A manifest refresh error propagates without replacing the previous Node base.
    2. The existing manifest and installed packages remain intact.
    """
    bundled_node, make_runtime = _node_base(test_sandbox, monkeypatch)
    first = make_runtime()
    first.ensure()
    installed = first.modules_dir / "kept-package" / "index.js"
    installed.parent.mkdir(parents=True)
    installed.write_text("keep", encoding="utf-8")
    old_manifest = (first.root / first.MANIFEST_NAME).read_text(encoding="utf-8")
    bundled_node.write_text("node-v2", encoding="utf-8")
    replacement = make_runtime()

    def fail_manifest(_self: BundledNodeBaseRuntime, _identity: dict[str, object]) -> None:
        raise OSError("manifest refresh blocked")

    monkeypatch.setattr(BundledNodeBaseRuntime, "_write_manifest", fail_manifest)

    # Check 1: A failed refresh leaves the previous package tree active.
    with pytest.raises(OSError, match="manifest refresh blocked"):
        replacement.ensure()
    assert (replacement.root / replacement.MANIFEST_NAME).read_text(encoding="utf-8") == old_manifest
    assert installed.read_text(encoding="utf-8") == "keep"

    # Check 2: No swap transaction is created around a user-owned environment.
    assert list(replacement.root.parent.glob(".base.stage.*")) == []
    assert list(replacement.root.parent.glob(".base.backup.*")) == []
