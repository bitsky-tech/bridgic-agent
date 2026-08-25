"""Packaged Node discovery and the app-wide writable Node dependency base."""

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from functools import cache
from pathlib import Path
from typing import MutableMapping, Optional

from filelock import FileLock, Timeout as FileLockTimeout

from ._errors import BundledRuntimeUnavailable, EnvNotReady
from ._probe import (
    BaseProbe,
    is_directory,
    is_regular_file,
    probe_base,
)
from ._resources import BundledRuntimeResources

logger = logging.getLogger(__name__)


class BundledNodeRuntime:
    """Read-only discovery and injection for the app-packaged Node.js runtime.

    Two consumers, two deliberately different injection styles:

    - **Playwright** gets an absolute ``PLAYWRIGHT_NODEJS_PATH`` (honoured by
      ``playwright._impl._driver.compute_driver_executable``), so the driver
      always runs on a known version regardless of PATH.
    - **Skills and user commands** get the bundle's bin directory prepended to
      PATH so packaged behavior is deterministic across launchd, scheduled
      tasks, and developer shells. The npm/npx-dependent Skills (docx, pptx,
      remotion, hyperframes) therefore see the supported Node version first.

    Discovery accessors return ``None`` when the bundle is absent. The product
    command boundary treats that as a startup error; only low-level browser
    discovery and isolated tests may continue without it.
    """

    RUNTIME_DIR_NAME = "node_runtime"
    MANIFEST_NAME = "runtime.json"

    MIN_MAJOR = 18
    """Hard floor: Playwright's driver refuses to start below this."""

    SKILL_MAJOR = 22
    """Floor for the bundled Skills (``hyperframes`` declares ``engines>=22``).
    Only warned about — a lower Node still drives the browser fine."""

    RESOLVER_MIN_VERSION = (22, 15)
    """First Node release exposing synchronous ``module.registerHooks``."""

    def __init__(self, *, resources: Optional[BundledRuntimeResources] = None) -> None:
        self.resources = resources or BundledRuntimeResources()

    @cache
    def runtime_dir(self) -> Optional[Path]:
        override = os.environ.get("AMPHI_BUNDLED_NODE_RUNTIME_DIR")
        if override:
            candidate = Path(override)
            return candidate if candidate.is_dir() else None

        resources_dir = self.resources.directory()
        if resources_dir is None:
            return None
        candidate = resources_dir / self.RUNTIME_DIR_NAME
        return candidate if candidate.is_dir() else None

    @cache
    def bin_dir(self) -> Optional[Path]:
        """Directory holding ``node``/``npm``/``npx``.

        POSIX archives nest everything under ``bin/``; Windows archives keep
        ``node.exe`` at the runtime root. The layout is *probed* rather than
        derived from ``os.name`` so that inspecting a bundle built for another
        platform (CI cross-checks, tests) still resolves correctly.
        """
        root = self.runtime_dir()
        if root is None:
            return None
        for candidate in (root / "bin", root):
            if self._node_in(candidate) is not None:
                return candidate
        return None

    @cache
    def executable(self) -> Optional[Path]:
        bin_dir = self.bin_dir()
        executable = self._node_in(bin_dir) if bin_dir is not None else None
        return executable.expanduser().resolve() if executable is not None else None

    @cache
    def npm_cli(self) -> Optional[Path]:
        """Return npm's packaged JavaScript entry point."""
        root = self.runtime_dir()
        if root is None:
            return None
        return self._first_file(
            root / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js",
            root / "node_modules" / "npm" / "bin" / "npm-cli.js",
        )

    @cache
    def npx_cli(self) -> Optional[Path]:
        """Return npx's packaged JavaScript entry point."""
        root = self.runtime_dir()
        if root is None:
            return None
        return self._first_file(
            root / "lib" / "node_modules" / "npm" / "bin" / "npx-cli.js",
            root / "node_modules" / "npm" / "bin" / "npx-cli.js",
        )

    @staticmethod
    def _first_file(*candidates: Path) -> Optional[Path]:
        return next(
            (candidate.expanduser().resolve() for candidate in candidates if candidate.is_file()),
            None,
        )

    @staticmethod
    def _node_in(directory: Path) -> Optional[Path]:
        """The node executable directly inside ``directory``, if any."""
        for name in ("node", "node.exe"):
            candidate = directory / name
            if candidate.is_file():
                return candidate
        return None

    @cache
    def version(self) -> Optional[str]:
        """Pinned Node version from the bundle manifest, e.g. ``v22.23.1``.

        Read from ``runtime.json`` (written by
        ``desktop/scripts/prebuild-fetch-node.ts``, mirroring the Python
        runtime's manifest) rather than spawning ``node --version``: this feeds
        the agent's ``<Workspace>`` block, which is rebuilt every turn.
        """
        root = self.runtime_dir()
        if root is None:
            return None
        try:
            manifest = json.loads(
                (root / self.MANIFEST_NAME).read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            logger.warning("Node runtime manifest is missing or invalid under %s", root)
            return None
        value = manifest.get("nodeVersion")
        return value if isinstance(value, str) and value else None

    @cache
    def executable_version(self) -> Optional[str]:
        """Probe the packaged executable version once for strict startup checks."""
        executable = self.executable()
        if executable is None:
            return None
        try:
            completed = subprocess.run(
                [str(executable), "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=True,
                **self._subprocess_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return None
        value = completed.stdout.strip()
        return value if re.fullmatch(r"v\d+\.\d+\.\d+", value) else None

    def apply_path(self, env: MutableMapping[str, str]) -> None:
        """Put the bundled Node on PATH (idempotent).

        Prepended, not appended, for two reasons:

        - **Platform parity.** macOS starts the daemon from launchd, whose PATH
          carries no user toolchain, so the bundle already wins there. Windows
          starts it from a login launcher that *does* inherit the user's
          environment. Appending would therefore mean the same Skill runs on the
          bundled Node 22 on macOS but on whatever the user has on Windows —
          `hyperframes` alone declares ``engines>=22``.
        - **Consistency.** uv and the Python runtime already prepend; Node was
          the only bundled runtime yielding to the host.

        The trade-off is that a user project pinning an older Node via
        ``.nvmrc`` is not honoured. That is accepted: a Skill failing on a stale
        Node surfaces as "generating the deck failed" with nowhere to go, while
        a version mismatch in a user's own build surfaces as ``EBADENGINE`` in
        output the agent can read and act on.
        """
        bin_dir = self.bin_dir()
        if bin_dir is None:
            return
        self._prepend_path(env, str(bin_dir))

    def reset_cache(self) -> None:
        """Discard stable runtime discovery, primarily for tests."""
        self.runtime_dir.cache_clear()
        self.bin_dir.cache_clear()
        self.executable.cache_clear()
        self.npm_cli.cache_clear()
        self.npx_cli.cache_clear()
        self.version.cache_clear()
        self.executable_version.cache_clear()

    def apply_playwright_env(self) -> None:
        """Point Playwright's driver at a usable Node, when one needs pointing at.

        Resolution order, first hit wins:

        1. ``PLAYWRIGHT_NODEJS_PATH`` already set — user or test override, kept.
        2. The packaged bundle — the normal path in a shipped app.
        3. Playwright's own vendored ``driver/node`` — the normal path in a dev
           checkout, where ``resources/`` does not exist.  Left untouched so
           Playwright's default resolution applies.
        4. A system ``node`` new enough to drive the browser.

        Writes into ``os.environ`` because Playwright builds the driver's
        environment from ``os.environ.copy()`` deep inside bridgic-browser,
        where no explicit env can be threaded through.
        """
        if os.environ.get("PLAYWRIGHT_NODEJS_PATH"):
            return

        bundled = self.executable()
        if bundled is not None:
            os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(bundled)
            return

        if self._playwright_vendored_node_exists():
            return

        system = self._system_node()
        if system is not None:
            os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(system)
            return

        logger.warning(
            "No Node.js runtime found (bundle, Playwright vendor copy, and PATH "
            "all came up empty); browser automation and npm-based Skills will fail."
        )

    @staticmethod
    def _playwright_vendored_node_exists() -> bool:
        try:
            from playwright._impl._driver import compute_driver_executable

            executable, _cli = compute_driver_executable()
            return os.path.isfile(executable)
        except Exception:  # noqa: BLE001 — absence is the only thing we test for
            return False

    @classmethod
    def _system_node(cls) -> Optional[Path]:
        found = shutil.which("node")
        if not found:
            return None
        major = cls._major_version(found)
        if major is None:
            logger.warning("System Node at %s did not report a version; ignoring", found)
            return None
        if major < cls.MIN_MAJOR:
            logger.warning(
                "System Node at %s is v%d, below the v%d Playwright requires; ignoring",
                found, major, cls.MIN_MAJOR,
            )
            return None
        if major < cls.SKILL_MAJOR:
            logger.warning(
                "Using system Node v%d from %s; bundled Skills expect v%d or newer, "
                "so npm-based Skills may fail.",
                major, found, cls.SKILL_MAJOR,
            )
        return Path(found)

    @staticmethod
    def _major_version(executable: str) -> Optional[int]:
        try:
            completed = subprocess.run(
                [executable, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=True,
                **BundledNodeRuntime._subprocess_kwargs(),
            )
        except Exception:  # noqa: BLE001 — an unusable node is simply not a candidate
            return None
        match = re.match(r"v?(\d+)\.", completed.stdout.strip())
        return int(match.group(1)) if match else None

    @staticmethod
    def _prepend_path(target: MutableMapping[str, str], directory: str) -> None:
        path = target.get("PATH", "")
        if directory in path.split(os.pathsep):
            return
        target["PATH"] = f"{directory}{os.pathsep}{path}" if path else directory

    @staticmethod
    def _subprocess_kwargs() -> dict[str, int]:
        if sys.platform != "win32":
            return {}
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


class BundledNodeBaseRuntime:
    """The single writable Node dependency base shared by all app commands.

    The packaged Node runtime is immutable. npm packages, package executables,
    and npm's cache instead live below ``~/.bridgic/AmphiAgent/node``. This
    class owns that writable state and the environment contract that makes it
    the only dependency environment seen by Session, Build, Workflow Run, and
    child-Agent commands.

    Parameters
    ----------
    node_runtime : BundledNodeRuntime
        Read-only packaged Node and npm discovery.
    data_home : Path, optional
        Writable application data root.
    """

    FORMAT_VERSION = 1
    MANIFEST_NAME = ".amphi-base.json"
    PREPARE_TIMEOUT_SEC = 300

    def __init__(
        self,
        *,
        node_runtime: BundledNodeRuntime,
        data_home: Optional[Path] = None,
    ) -> None:
        self.node_runtime = node_runtime
        self.data_home = Path(
            data_home or Path.home() / ".bridgic" / "AmphiAgent"
        ).expanduser().resolve()
        self.root = self.data_home / "node" / "base"
        self.cache = self.data_home / "node" / "cache"
        self._process_lock = threading.Lock()
        self._node_fingerprint: Optional[tuple[Path, str]] = None
        self._ready = False

    @property
    def modules_dir(self) -> Path:
        """Return npm's shared global package directory."""
        if self._is_windows():
            return self.root / "node_modules"
        return self.root / "lib" / "node_modules"

    @property
    def bin_dir(self) -> Path:
        """Return the directory containing shared package executables."""
        return self.root if self._is_windows() else self.root / "bin"

    @property
    def shim_dir(self) -> Path:
        """Return the private directory containing serialized npm/npx shims."""
        return self.root / ".amphi" / "bin"

    @property
    def resolver_path(self) -> Path:
        """Return the Node preload that forces shared-package resolution."""
        return self.root / ".amphi" / "resolver.cjs"

    def ensure(self) -> Optional[Path]:
        """Prepare the shared base and return its root.

        The product command boundary validates packaged Node/npm before calling
        this method. Low-level permissive callers may receive ``None`` but must
        not execute Agent commands with a host Node runtime.

        Returns
        -------
        Path, optional
            Shared base root, or ``None`` when no packaged Node exists.

        Existing package directories are never replaced to answer a runtime
        update. Identity, resolver, and npm shims are refreshed in place while
        node_modules and package commands remain untouched.
        """
        node = self.node_runtime.executable()
        if node is None:
            if getattr(sys, "frozen", False):
                raise BundledRuntimeUnavailable(
                    "Bundled Node is unavailable; the shared Node base cannot be prepared"
                )
            return None
        npm_cli = self.node_runtime.npm_cli()
        npx_cli = self.node_runtime.npx_cli()
        if npm_cli is None or npx_cli is None:
            raise BundledRuntimeUnavailable(
                "Bundled npm is unavailable; the shared Node base cannot be prepared"
            )
        identity = self._runtime_identity(node)
        expected_files = self._expected_files(npm_cli, npx_cli)

        with self._process_lock:
            if (
                self._ready
                and not self.cache.is_symlink()
                and self.cache.is_dir()
                and self._probe_available(self.root, identity, expected_files).usable
            ):
                return self.root
            parent = self._prepare_parent()
            try:
                with FileLock(parent / ".base.lock", timeout=self.PREPARE_TIMEOUT_SEC):
                    self._recover_interrupted_install()
                    self._prepare_base(identity, expected_files)
            except FileLockTimeout as exc:
                raise RuntimeError(
                    "Timed out waiting for the shared Node base"
                ) from exc
            self._ready = True
            return self.root

    def _prepare_base(
        self,
        identity: dict[str, object],
        expected_files: dict[Path, str],
    ) -> None:
        """Bring the base up to ``identity`` and ``expected_files`` in place."""
        compatible = self._probe_compatible(self.root, identity)
        if compatible.unreadable:
            raise EnvNotReady(compatible.path, compatible.error)
        if not compatible.usable:
            self._ensure_layout()
            self._refresh_support_files(expected_files)
            self._write_manifest(identity)
            if not self._probe_available(self.root, identity, expected_files).usable:
                raise RuntimeError("Failed to prepare the shared Node base")
            return
        support = self._probe_support_files(self.root, expected_files)
        if support.unreadable:
            raise EnvNotReady(support.path, support.error)
        if not support.usable:
            self._refresh_support_files(expected_files)

    def apply(self, target: MutableMapping[str, str]) -> None:
        """Inject packaged Node and the shared dependency base into a command."""
        root = self.ensure()
        if root is None:
            self.node_runtime.apply_path(target)
            return

        self._replace_env(target, "npm_config_prefix", str(root))
        self._replace_env(target, "npm_config_cache", str(self.cache))
        self._replace_env(target, "npm_config_global", "true")
        self._replace_env(target, "npm_config_npx_cache", str(root / ".amphi" / "npx"))

        self._replace_env(target, "NODE_PATH", str(self.modules_dir))

        resolver = self.resolver_path.resolve().as_posix()
        resolver_option = f"--require {json.dumps(resolver, ensure_ascii=False)}"
        self._replace_env(target, "NODE_OPTIONS", resolver_option)

        self._set_path_prefix(
            target,
            self.shim_dir,
            self.node_runtime.bin_dir(),
            self.bin_dir,
        )

    def reset(self) -> None:
        """Forget process-local readiness without deleting the shared base."""
        self._node_fingerprint = None
        self._ready = False

    def _ensure_layout(self) -> None:
        directories = (
            self.root,
            self.root / ".amphi",
            self.shim_dir,
            self.modules_dir,
            self.bin_dir,
        )
        for directory in directories:
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise RuntimeError(
                    f"Cannot repair the shared Node base at {directory}; preserving existing files"
                ) from exc
            if not is_directory(directory):
                raise RuntimeError(
                    f"The shared Node path at {directory} is not a directory; preserving it unchanged"
                )

    def _refresh_support_files(self, expected_files: dict[Path, str]) -> None:
        for relative, content in expected_files.items():
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(
                f".{destination.name}.tmp.{os.getpid()}.{threading.get_ident()}"
            )
            try:
                temporary.write_text(content, encoding="utf-8", newline="")
                if not self._is_windows() and relative.parent.name == "bin":
                    temporary.chmod(0o755)
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)

    def _write_manifest(self, identity: dict[str, object]) -> None:
        destination = self.root / self.MANIFEST_NAME
        temporary = destination.with_name(
            f".{destination.name}.tmp.{os.getpid()}.{threading.get_ident()}"
        )
        try:
            temporary.write_text(
                json.dumps(identity, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

    def _runtime_identity(self, node: Path) -> dict[str, object]:
        resolved_node = node.expanduser().resolve()
        cached = self._node_fingerprint
        if cached is None or cached[0] != resolved_node:
            digest = hashlib.sha256()
            try:
                with resolved_node.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError as exc:
                raise RuntimeError("Bundled Node is unreadable") from exc
            cached = (resolved_node, digest.hexdigest())
            self._node_fingerprint = cached
        identity: dict[str, object] = {
            "baseFormatVersion": self.FORMAT_VERSION,
            "node": str(resolved_node),
            "nodeSha256": cached[1],
        }
        runtime_dir = self.node_runtime.runtime_dir()
        if runtime_dir is None:
            return identity
        try:
            manifest = json.loads(
                (runtime_dir / self.node_runtime.MANIFEST_NAME).read_text(encoding="utf-8")
            )
        except (OSError, ValueError, TypeError):
            return identity
        for name in ("nodeVersion", "npmVersion", "target"):
            value = manifest.get(name)
            if isinstance(value, str) and value:
                identity[name] = value
        return identity

    def _expected_files(self, npm_cli: Path, npx_cli: Path) -> dict[Path, str]:
        proxy_relative = Path(".amphi/npm-proxy.cjs")
        files = {
            Path(".amphi/resolver.cjs"): self._resolver_source(npm_cli, npx_cli),
            proxy_relative: self._proxy_source(npm_cli, npx_cli),
        }
        if self._is_windows():
            files[Path(".amphi/bin/npm.cmd")] = self._windows_shim("npm")
            files[Path(".amphi/bin/npx.cmd")] = self._windows_shim("npx")
        else:
            files[Path(".amphi/bin/npm")] = self._posix_shim("npm")
            files[Path(".amphi/bin/npx")] = self._posix_shim("npx")
        return files

    def _resolver_source(self, npm_cli: Path, npx_cli: Path) -> str:
        runtime_dir = self.node_runtime.runtime_dir()
        protected_paths = {
            npm_cli.parent.parent,
            npx_cli.parent.parent,
        }
        if runtime_dir is not None:
            protected_paths.add(runtime_dir.expanduser().resolve())
        ordered_protected_paths = sorted(str(path) for path in protected_paths)
        protected_urls = [
            f"{Path(path).as_uri().rstrip('/')}/" for path in ordered_protected_paths
        ]
        modules_url = f"{self.modules_dir.as_uri().rstrip('/')}/"
        anchor_url = (self.modules_dir.parent / ".amphi-entry.mjs").as_uri()
        return f"""'use strict';

const Module = require('node:module');
const {{ createRequire, isBuiltin, registerHooks }} = Module;
const {{ isAbsolute, relative }} = require('node:path');

const BASE_ANCHOR_URL = {json.dumps(anchor_url)};
const BASE_MODULES_PATH = {json.dumps(str(self.modules_dir))};
const BASE_MODULES_URL = {json.dumps(modules_url)};
const PROTECTED_RUNTIME_PATHS = {json.dumps(ordered_protected_paths)};
const PROTECTED_RUNTIME_URLS = {json.dumps(protected_urls)};
const baseRequire = createRequire(BASE_ANCHOR_URL);
let resolvingFromBase = false;

function isBarePackage(specifier) {{
  return !isBuiltin(specifier) &&
    !specifier.startsWith('node:') &&
    !specifier.startsWith('#') &&
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('\\\\') &&
    !/^[A-Za-z]:[\\\\/]/.test(specifier) &&
    !/^[A-Za-z][A-Za-z+.-]*:/.test(specifier);
}}

function isWithin(filename, root) {{
  if (!filename || !root) return false;
  const nested = relative(root, filename);
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested));
}}

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveFromSharedBase(specifier, parent, isMain, options) {{
  const parentFilename = parent && parent.filename ? parent.filename : '';
  const protectedParent = isWithin(parentFilename, BASE_MODULES_PATH) ||
    PROTECTED_RUNTIME_PATHS.some((root) => isWithin(parentFilename, root));
  if (resolvingFromBase || !isBarePackage(specifier) || protectedParent) {{
    return originalResolveFilename.call(this, specifier, parent, isMain, options);
  }}
  resolvingFromBase = true;
  try {{
    return baseRequire.resolve(specifier);
  }} finally {{
    resolvingFromBase = false;
  }}
}};

registerHooks({{
  resolve(specifier, context, nextResolve) {{
    const parentURL = context.parentURL || '';
    const protectedParent = parentURL.startsWith(BASE_MODULES_URL) ||
      PROTECTED_RUNTIME_URLS.some((root) => parentURL.startsWith(root));
    if (!isBarePackage(specifier) || protectedParent) {{
      return nextResolve(specifier, context);
    }}
    return nextResolve(specifier, {{ ...context, parentURL: BASE_ANCHOR_URL }});
  }},
}});
"""

    def _proxy_source(self, npm_cli: Path, npx_cli: Path) -> str:
        lock_dir = self.root.parent / ".install.lock"
        return f"""'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const BASE = {json.dumps(str(self.root))};
const CACHE = {json.dumps(str(self.cache))};
const MODULES = {json.dumps(str(self.modules_dir))};
const LOCK_DIR = {json.dumps(str(lock_dir))};
const NPM_CLI = {json.dumps(str(npm_cli))};
const NPX_CLI = {json.dumps(str(npx_cli))};
const LOCK_TOKEN = 'AMPHI_NODE_BASE_LOCK_TOKEN';
const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

function commandEnvironment(token) {{
  const environment = {{ ...process.env }};
  for (const key of Object.keys(environment)) {{
    const normalized = key.toLowerCase();
    if (normalized === 'npm_config_prefix' || normalized === 'npm_config_cache' ||
        normalized === 'npm_config_global' || normalized === 'npm_config_npx_cache') {{
      delete environment[key];
    }}
  }}
  environment.npm_config_prefix = BASE;
  environment.npm_config_cache = CACHE;
  environment.npm_config_global = 'true';
  environment.npm_config_npx_cache = path.join(BASE, '.amphi', 'npx');
  if (token) environment[LOCK_TOKEN] = token;
  return environment;
}}

function sleep(milliseconds) {{
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}}

function processIsAlive(pid) {{
  try {{
    process.kill(pid, 0);
    return true;
  }} catch (error) {{
    return error && error.code === 'EPERM';
  }}
}}

function clearAbandonedLock() {{
  let owner;
  try {{
    owner = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'owner.json'), 'utf8'));
  }} catch {{
    try {{
      const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (age < 30000) return false;
    }} catch {{
      return true;
    }}
  }}
  if (owner && Number.isInteger(owner.pid) && processIsAlive(owner.pid)) return false;
  try {{
    fs.rmSync(LOCK_DIR, {{ recursive: true, force: true }});
    return true;
  }} catch {{
    return false;
  }}
}}

function acquireLock() {{
  if (process.env[LOCK_TOKEN]) return null;
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {{
    try {{
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(
        path.join(LOCK_DIR, 'owner.json'),
        JSON.stringify({{ pid: process.pid, token, createdAt: Date.now() }}),
        {{ encoding: 'utf8', flag: 'wx' }}
      );
      return token;
    }} catch (error) {{
      if (!error || error.code !== 'EEXIST') {{
        try {{ fs.rmSync(LOCK_DIR, {{ recursive: true, force: true }}); }} catch {{}}
        throw error;
      }}
      if (!clearAbandonedLock()) sleep(100);
    }}
  }}
  throw new Error('Timed out waiting for the shared Node base');
}}

function releaseLock(token) {{
  if (!token) return;
  try {{
    const owner = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'owner.json'), 'utf8'));
    if (owner.token === token) fs.rmSync(LOCK_DIR, {{ recursive: true, force: true }});
  }} catch {{}}
}}

function runCli(cli, args, environment) {{
  const result = childProcess.spawnSync(process.execPath, [cli, ...args], {{
    env: environment,
    stdio: 'inherit',
  }});
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}}

function packageName(specifier) {{
  if (!specifier || specifier.startsWith('-')) return null;
  if (specifier.startsWith('@')) {{
    const slash = specifier.indexOf('/');
    if (slash < 0) return null;
    const version = specifier.indexOf('@', slash);
    return version < 0 ? specifier : specifier.slice(0, version);
  }}
  const version = specifier.indexOf('@');
  return version < 0 ? specifier : specifier.slice(0, version);
}}

function requestedPackages(args, stopAtCommand = false) {{
  const explicit = [];
  let command = null;
  for (let index = 0; index < args.length; index += 1) {{
    const argument = args[index];
    if (argument === '--') {{
      if (command === null && index + 1 < args.length) command = args[index + 1];
      break;
    }}
    if (argument === '--package' || argument === '-p') {{
      if (index + 1 < args.length) explicit.push(args[++index]);
      continue;
    }}
    if (argument.startsWith('--package=')) {{
      explicit.push(argument.slice('--package='.length));
      continue;
    }}
    if (argument === '--call' || argument === '-c' || argument === '--shell') {{
      index += 1;
      continue;
    }}
    if (!argument.startsWith('-')) {{
      if (command === null) command = argument;
      if (stopAtCommand) break;
    }}
  }}
  return explicit.length ? explicit : (command ? [command] : []);
}}

function withoutExecPackages(args, stopAtCommand = false) {{
  const filtered = [];
  for (let index = 0; index < args.length; index += 1) {{
    const argument = args[index];
    if (argument === '--') {{
      filtered.push(...args.slice(index));
      break;
    }}
    if (argument === '--package' || argument === '-p') {{
      index += 1;
      continue;
    }}
    if (argument.startsWith('--package=')) continue;
    filtered.push(argument);
    if (argument === '--call' || argument === '-c' || argument === '--shell') {{
      if (index + 1 < args.length) filtered.push(args[++index]);
      continue;
    }}
    if (!argument.startsWith('-') && stopAtCommand) {{
      filtered.push(...args.slice(index + 1));
      break;
    }}
  }}
  return filtered;
}}

function isInstalled(specifier) {{
  const name = packageName(specifier);
  if (!name) return false;
  const manifestPath = path.join(MODULES, ...name.split('/'), 'package.json');
  let manifest;
  try {{
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }} catch {{
    return false;
  }}
  const requested = specifier.slice(name.length).replace(/^@/, '');
  return !requested || requested === '*' || requested === manifest.version;
}}

function installForExec(args, environment, stopAtCommand = false) {{
  const missing = requestedPackages(args, stopAtCommand)
    .filter((specifier) => !isInstalled(specifier));
  if (!missing.length) return 0;
  return runCli(NPM_CLI, ['install', '--global', '--no-save', ...missing], environment);
}}

function enforcedNpmArgs(args, includePrefix = true) {{
  const filtered = [];
  for (let index = 0; index < args.length; index += 1) {{
    const argument = args[index];
    if (argument === '--') {{
      filtered.push(...args.slice(index));
      break;
    }}
    if (argument === '--prefix' || argument === '--cache' || argument === '--location') {{
      index += 1;
      continue;
    }}
    if (argument === '-g' || argument === '--global' || argument === '--no-global' ||
        argument.startsWith('--global=') || argument.startsWith('--prefix=') ||
        argument.startsWith('--cache=') || argument.startsWith('--location=')) {{
      continue;
    }}
    filtered.push(argument);
  }}
  const enforced = ['--global'];
  if (includePrefix) enforced.push(`--prefix=${{BASE}}`);
  enforced.push(`--cache=${{CACHE}}`);
  return [...enforced, ...filtered];
}}

function npmCommand(args) {{
  for (let index = 0; index < args.length; index += 1) {{
    const argument = args[index];
    if (argument === '--package' || argument === '-p' || argument === '--call' ||
        argument === '-c' || argument === '--shell') {{
      index += 1;
      continue;
    }}
    if (!argument.startsWith('-')) return argument;
  }}
  return '';
}}

function withInstallLock(operation) {{
  let token = null;
  try {{
    token = acquireLock();
    const environment = commandEnvironment(token || process.env[LOCK_TOKEN]);
    return operation(environment);
  }} finally {{
    releaseLock(token);
  }}
}}

function run(mode, args) {{
  if (mode === 'npx') {{
    const installStatus = withInstallLock((environment) =>
      installForExec(args, environment, true));
    if (installStatus !== 0) return installStatus;
    return runCli(NPX_CLI, withoutExecPackages(args, true), commandEnvironment(null));
  }}

  let npmArgs = enforcedNpmArgs(args);
  const command = npmCommand(npmArgs);
  if (command === 'exec' || command === 'x') {{
    npmArgs = enforcedNpmArgs(args, false);
    const commandIndex = npmArgs.indexOf(command);
    const execArgs = [
      ...npmArgs.slice(0, commandIndex),
      ...npmArgs.slice(commandIndex + 1),
    ];
    const installStatus = withInstallLock((environment) =>
      installForExec(execArgs, environment));
    if (installStatus !== 0) return installStatus;
    const forwardedArgs = withoutExecPackages(npmArgs);
    return runCli(NPM_CLI, forwardedArgs, commandEnvironment(null));
  }}

  const serializedCommands = new Set([
    'add', 'ci', 'dedupe', 'i', 'install', 'link', 'list', 'ls', 'prune',
    'rebuild', 'remove', 'rm', 'root', 'un', 'uninstall', 'unlink', 'up',
    'update', 'upgrade',
  ]);
  if (serializedCommands.has(command)) {{
    return withInstallLock((environment) => runCli(NPM_CLI, npmArgs, environment));
  }}
  return runCli(NPM_CLI, npmArgs, commandEnvironment(null));
}}

module.exports = {{ run }};
if (require.main === module) {{
  try {{
    process.exitCode = run(process.argv[2], process.argv.slice(3));
  }} catch (error) {{
    console.error(`amphi npm: ${{error && error.message ? error.message : error}}`);
    process.exitCode = 1;
  }}
}}
"""

    @staticmethod
    def _posix_shim(mode: str) -> str:
        return (
            "#!/usr/bin/env node\n"
            f"process.exitCode = require('../npm-proxy.cjs').run('{mode}', "
            "process.argv.slice(2));\n"
        )

    @staticmethod
    def _windows_shim(mode: str) -> str:
        return f'@node "%~dp0\\..\\npm-proxy.cjs" {mode} %*\n'

    def _prepare_parent(self) -> Path:
        parent = self.root.parent
        if parent.is_symlink():
            raise RuntimeError("The app-level Node directory must not be a symlink")
        parent.mkdir(parents=True, exist_ok=True)
        if parent.is_symlink() or not parent.is_dir():
            raise RuntimeError("The app-level Node directory is unavailable")
        if self.cache.is_symlink():
            raise RuntimeError("The app-level npm cache must not be a symlink")
        self.cache.mkdir(parents=True, exist_ok=True)
        if self.cache.is_symlink() or not self.cache.is_dir():
            raise RuntimeError("The app-level npm cache is unavailable")
        return parent

    def _recover_interrupted_install(self) -> None:
        """Recover the last complete base without deleting any saved environment."""
        for stage in self.root.parent.glob(".base.stage.*"):
            self._remove(stage)
        backups = sorted(self.root.parent.glob(".base.backup.*"), reverse=True)
        try:
            self.root.lstat()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise EnvNotReady(self.root, exc) from exc
        else:
            return
        blocked_backup: Optional[tuple[Path, OSError]] = None
        for backup in backups:
            try:
                if not is_directory(backup):
                    continue
                os.replace(backup, self.root)
            except OSError as exc:
                blocked_backup = (backup, exc)
                continue
            logger.warning(
                "Restored the preserved Node base from %s; it will be migrated in place",
                backup,
            )
            return
        if blocked_backup is not None:
            raise EnvNotReady(*blocked_backup)

    def _probe_available(
        self,
        root: Path,
        identity: dict[str, object],
        expected_files: dict[Path, str],
    ) -> BaseProbe:
        """Return a tri-state verdict covering identity and support files."""
        return probe_base(
            root,
            lambda: self._inspect_compatible(root, identity)
            and self._inspect_support_files(root, expected_files),
        )

    def _probe_compatible(self, root: Path, identity: dict[str, object]) -> BaseProbe:
        """Return a tri-state verdict for one candidate base.

        A directory whose DACL stopped granting the running user denies every
        read inside it, so an intact base reads as missing. The probe reports
        that as unreadable rather than folding it into "broken". Callers wait
        for access to return; they never quarantine or replace the directory.
        """
        return probe_base(root, lambda: self._inspect_compatible(root, identity))

    def _probe_support_files(
        self,
        root: Path,
        expected_files: dict[Path, str],
    ) -> BaseProbe:
        """Return a tri-state verdict for the serialized shims and resolver."""
        return probe_base(
            root,
            lambda: self._inspect_support_files(root, expected_files),
        )

    def _inspect_compatible(self, root: Path, identity: dict[str, object]) -> bool:
        """Return whether ``root`` matches ``identity``, letting OSError escape."""
        directories = (
            root,
            root / ".amphi",
            root / self.shim_dir.relative_to(self.root),
            root / self.modules_dir.relative_to(self.root),
            root / self.bin_dir.relative_to(self.root),
        )
        if not all(is_directory(directory) for directory in directories):
            return False
        manifest_path = root / self.MANIFEST_NAME
        if not is_regular_file(manifest_path):
            return False
        return json.loads(manifest_path.read_text(encoding="utf-8")) == identity

    @staticmethod
    def _inspect_support_files(root: Path, expected_files: dict[Path, str]) -> bool:
        """Return whether every shim is current, letting OSError escape."""
        return all(
            is_regular_file(root / relative)
            and (root / relative).read_text(encoding="utf-8") == content
            for relative, content in expected_files.items()
        )

    @staticmethod
    def _replace_env(target: MutableMapping[str, str], name: str, value: str) -> None:
        normalized = name.lower()
        for existing in list(target):
            if existing.lower() == normalized:
                target.pop(existing, None)
        target[name] = value

    @staticmethod
    def _set_path_prefix(
        target: MutableMapping[str, str],
        *directories: Optional[Path],
    ) -> None:
        selected = [
            str(directory) for directory in directories if directory is not None
        ]
        normalized = {os.path.normcase(directory) for directory in selected}
        inherited = [
            entry
            for entry in target.get("PATH", "").split(os.pathsep)
            if entry and os.path.normcase(entry) not in normalized
        ]
        target["PATH"] = os.pathsep.join([*selected, *inherited])

    @staticmethod
    def _is_windows() -> bool:
        return os.name == "nt"

    @staticmethod
    def _remove(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        elif path.exists() or path.is_symlink():
            path.unlink(missing_ok=True)
