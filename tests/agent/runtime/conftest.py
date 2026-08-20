import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from src.amphi_agent.runtime._node_env import BundledNodeBaseRuntime, BundledNodeRuntime
from tests._support.sandbox import IsolatedPaths


@dataclass(frozen=True, slots=True)
class _NodeCommandHarness:
    root: Path
    node: Path
    runtime: BundledNodeBaseRuntime
    environment: dict[str, str]
    commonjs: Path
    esm: Path

    def run(self, command: list[str], environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            command,
            cwd=self.root,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=True,
        )

    def shim_command(self, name: str, *args: str) -> list[str]:
        shim = self.runtime.shim_dir / (f"{name}.cmd" if os.name == "nt" else name)
        if os.name != "nt":
            return [str(shim), *args]
        command = subprocess.list2cmdline([str(shim), *args])
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", command]


@pytest.fixture
def node_commands(test_sandbox: IsolatedPaths) -> _NodeCommandHarness:
    """Build one isolated generated-command surface around an available Node runtime."""
    repository = Path(__file__).resolve().parents[3]
    runtime_resources = repository / "desktop" / "apps" / "electron" / "resources" / "node_runtime"
    bundled_candidate = runtime_resources / "node.exe" if os.name == "nt" else runtime_resources / "bin" / "node"
    candidates = [bundled_candidate]
    system_node = shutil.which("node")
    if system_node is not None:
        candidates.append(Path(system_node))

    node: Path | None = None
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            version_result = subprocess.run(
                [str(candidate), "-p", "process.versions.node"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=True,
            )
            version = tuple(int(part) for part in version_result.stdout.strip().split(".")[:2])
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
        if version >= BundledNodeRuntime.RESOLVER_MIN_VERSION:
            node = candidate.resolve()
            break
    if node is None:
        required = ".".join(str(part) for part in BundledNodeRuntime.RESOLVER_MIN_VERSION)
        pytest.skip(f"Node {required} or newer is required for the generated-command smoke test")

    bundle = test_sandbox.root / "node-command-bundle"
    npm_bin = bundle / "node_modules" / "npm" / "bin" if os.name == "nt" else bundle / "lib" / "node_modules" / "npm" / "bin"
    npm_cli = npm_bin / "npm-cli.js"
    npx_cli = npm_bin / "npx-cli.js"
    npm_bin.mkdir(parents=True)
    private_dependency = npm_bin.parent / "node_modules" / "npm-private-dependency"
    private_dependency.mkdir(parents=True)
    (private_dependency / "index.js").write_text(
        "module.exports = 'bundled-private-dependency';\n",
        encoding="utf-8",
    )
    capture_source = """'use strict';
const fs = require('node:fs');
const privateDependency = require('npm-private-dependency');
const args = process.argv.slice(2);
const installCapture = process.env.AMPHI_TEST_NPM_INSTALL_CAPTURE;
const capture = installCapture && args.includes('install')
  ? installCapture
  : process.env.AMPHI_TEST_CAPTURE;
fs.writeFileSync(capture, JSON.stringify({
  args,
  privateDependency,
  prefix: process.env.npm_config_prefix,
  cache: process.env.npm_config_cache,
  global: process.env.npm_config_global,
  npxCache: process.env.npm_config_npx_cache,
}));
"""
    npm_cli.write_text(capture_source, encoding="utf-8")
    npx_cli.write_text(capture_source, encoding="utf-8")

    class NodeRuntime:
        MANIFEST_NAME = "runtime.json"
        RESOLVER_MIN_VERSION = BundledNodeRuntime.RESOLVER_MIN_VERSION

        def executable(self) -> Path:
            assert node is not None
            return node

        def npm_cli(self) -> Path:
            return npm_cli

        def npx_cli(self) -> Path:
            return npx_cli

        def runtime_dir(self) -> Path:
            return bundle

        def bin_dir(self) -> Path:
            assert node is not None
            return node.parent

    runtime = BundledNodeBaseRuntime(
        node_runtime=NodeRuntime(),  # type: ignore[arg-type]
        data_home=test_sandbox.app_home,
    )
    runtime.ensure()
    package = runtime.modules_dir / "shared-package"
    package.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps({
            "bin": {"shared-command": "cli.cjs", "shared-package": "cli.cjs"},
            "name": "shared-package",
            "version": "1.0.0",
            "main": "index.cjs",
            "exports": "./index.cjs",
        }),
        encoding="utf-8",
    )
    (package / "index.cjs").write_text("module.exports = 'shared-value';\n", encoding="utf-8")
    (package / "cli.cjs").write_text("console.log(process.argv.slice(2));\n", encoding="utf-8")
    commonjs = test_sandbox.root / "consumer.cjs"
    commonjs.write_text("console.log(require('shared-package'));\n", encoding="utf-8")
    esm = test_sandbox.root / "consumer.mjs"
    esm.write_text("import value from 'shared-package'; console.log(value);\n", encoding="utf-8")
    environment = os.environ.copy()
    runtime.apply(environment)
    return _NodeCommandHarness(test_sandbox.root, node, runtime, environment, commonjs, esm)
