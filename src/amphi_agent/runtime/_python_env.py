"""App-packaged uv, Python, and the shared writable Python base."""

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
from typing import Mapping, MutableMapping, Optional

from filelock import FileLock, Timeout as FileLockTimeout

from ._errors import BundledRuntimeUnavailable, EnvNotReady
from ._probe import (
    BaseProbe,
    is_directory,
    is_regular_file,
    probe_base,
    resolves_to_file,
)
from ._resources import BundledRuntimeResources

logger = logging.getLogger(__name__)


def isolated_python_command(executable: Path, *args: str) -> list[str]:
    """Build an isolated interpreter call that leaves no bytecode behind.

    macOS seals every file inside a signed ``.app``. CPython writing
    ``__pycache__/*.pyc`` beside the standard library it just imported adds
    files the seal does not cover, and ``codesign --verify`` then reports
    "a sealed resource is missing or invalid" for an app that shipped
    correctly signed. A real install accumulated 170 stray ``.pyc`` files
    under ``Contents/Resources/python_runtime/`` this way.

    ``apply()`` already redirects ``PYTHONPYCACHEPREFIX`` for user commands,
    which is not enough here: these probes run the interpreter with ``-I``,
    and isolated mode implies ``-E`` — every ``PYTHON*`` variable is
    discarded. Only a command-line switch survives it.
    """
    return [str(executable), "-I", "-B", *args]


def no_bytecode_environment(base: Mapping[str, str]) -> dict[str, str]:
    """Copy ``base`` with bytecode writing disabled and interpreter hooks removed.

    For interpreters whose argv we never see — uv spawns its own while creating
    the base, and ensurepip spawns one to run pip — the environment is the only
    lever left. Returns a copy so a caller reusing one env mapping does not
    inherit this silently.

    ``PYTHONBREAKPOINT`` is dropped rather than merely ignored: it names an
    importable callable the interpreter will run, and the ensurepip call below
    cannot use ``-I`` (which would imply ``-E``) without also discarding the
    variable this function exists to set.
    """
    environment = dict(base)
    environment.pop("PYTHONBREAKPOINT", None)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


class BundledUvRuntime:
    """App-packaged uv runtime discovery and environment injection."""

    RUNTIME_DIR_NAME = "uv_runtime"

    def __init__(
        self,
        *,
        data_home: Optional[Path] = None,
        resources: Optional[BundledRuntimeResources] = None,
    ) -> None:
        self.data_home = Path(
            data_home or Path.home() / ".bridgic" / "AmphiAgent"
        ).expanduser()
        self.resources = resources or BundledRuntimeResources()
        self._warned_no_bundled_runtime = False

    @cache
    def bundled_bin_dir(self) -> Optional[str]:
        override = os.environ.get("AMPHI_BUNDLED_BIN_DIR")
        if override:
            return override
        if getattr(sys, "frozen", False):
            return os.path.dirname(sys.executable)
        return None

    @cache
    def bin_dir(self) -> Optional[str]:
        override = os.environ.get("AMPHI_BUNDLED_UV_BIN_DIR")
        if override:
            return override

        runtime_override = os.environ.get("AMPHI_BUNDLED_UV_RUNTIME_DIR")
        if runtime_override:
            return str(Path(runtime_override) / "bin")

        resources_dir = self.resources.directory()
        if resources_dir is not None:
            candidate = resources_dir / self.RUNTIME_DIR_NAME / "bin"
            if candidate.is_dir():
                return str(candidate)

        legacy = self.bundled_bin_dir()
        if legacy and os.path.isdir(legacy):
            uv_path = Path(legacy) / self._binary_name()
            if uv_path.is_file():
                return legacy
        return None

    @cache
    def bundled_executable(self) -> Optional[Path]:
        """Resolve uv from the packaged runtime without a host fallback."""
        bin_dir = self.bin_dir()
        if bin_dir is not None:
            bundled = Path(bin_dir) / self._binary_name()
            if bundled.is_file():
                return bundled.expanduser().resolve()
        return None

    @cache
    def executable(self) -> Optional[Path]:
        """Resolve the packaged uv, falling back to the service ``PATH``."""
        bundled = self.bundled_executable()
        if bundled is not None:
            return bundled
        resolved = shutil.which("uv", path=os.environ.get("PATH", os.defpath))
        return Path(resolved).expanduser().resolve() if resolved else None

    @cache
    def version(self) -> Optional[str]:
        """Return the PATH-selected uv version for permissive discovery callers."""
        return self._probe_version(self.executable())

    @cache
    def bundled_version(self) -> Optional[str]:
        """Return only the app-packaged uv version, never a host fallback."""
        return self._probe_version(self.bundled_executable())

    @staticmethod
    def _probe_version(executable: Optional[Path]) -> Optional[str]:
        if executable is None:
            return None
        try:
            result = subprocess.run(
                [str(executable), "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                **BundledUvRuntime._subprocess_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        match = re.match(r"^uv\s+(\S+)", result.stdout.strip())
        return match.group(1) if match is not None else None

    def bootstrap_env(self, env: Optional[MutableMapping[str, str]] = None) -> None:
        target = os.environ if env is None else env
        bin_dir = self.bin_dir()
        if not bin_dir or not os.path.isdir(bin_dir):
            self._warn_once_no_bundled_runtime()
            return

        self._prepend_path(target, bin_dir)
        uv_home = self.data_home / "uv"
        self._replace_env(target, "UV_CACHE_DIR", str(uv_home / "cache"))
        self._replace_env(target, "UV_PYTHON_INSTALL_DIR", str(uv_home / "python"))
        self._replace_env(target, "UV_PYTHON_PREFERENCE", "only-managed")

    def _warn_once_no_bundled_runtime(self) -> None:
        """Log the missing-bundled-runtime notice at most once per process."""
        if self._warned_no_bundled_runtime:
            return
        self._warned_no_bundled_runtime = True
        logger.warning(
            "No bundled uv runtime found for a permissive discovery caller "
            "(resources_dir=%s). App command startup will reject this state. "
            "Set AMPHI_BUNDLED_UV_RUNTIME_DIR to point at one.",
            self.resources.directory(),
        )

    def reset_cache(self) -> None:
        """Discard stable runtime discovery, primarily for tests."""
        self._warned_no_bundled_runtime = False
        self.resources.reset_cache()
        self.bundled_bin_dir.cache_clear()
        self.bin_dir.cache_clear()
        self.bundled_executable.cache_clear()
        self.executable.cache_clear()
        self.version.cache_clear()
        self.bundled_version.cache_clear()

    @staticmethod
    def _prepend_path(target: MutableMapping[str, str], directory: str) -> None:
        path = target.get("PATH", "")
        if directory in path.split(os.pathsep):
            return
        target["PATH"] = f"{directory}{os.pathsep}{path}" if path else directory

    @staticmethod
    def _replace_env(target: MutableMapping[str, str], name: str, value: str) -> None:
        """Replace an environment key case-insensitively for Windows parity."""
        normalized = name.casefold()
        for existing in list(target):
            if existing.casefold() == normalized:
                del target[existing]
        target[name] = value

    @staticmethod
    def _binary_name() -> str:
        return "uv.exe" if os.name == "nt" else "uv"

    @staticmethod
    def _subprocess_kwargs() -> dict[str, int]:
        if sys.platform != "win32":
            return {}
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


class BundledUPythonRuntime:
    """The single writable Python environment shared by all app commands.

    Parameters
    ----------
    uv_runtime : BundledUvRuntime
        Packaged uv runtime used to create the base.
    resources : BundledRuntimeResources, optional
        Read-only Resources root used to discover packaged Python.
    data_home : Path, optional
        Writable application data root. The environment is always stored under
        ``python/base`` below this directory, never inside the signed app.
    """

    MANIFEST_NAME = ".amphi-base.json"
    RUNTIME_DIR_NAME = "python_runtime"
    RUNTIME_MANIFEST_NAME = "runtime.json"
    PREPARE_TIMEOUT_SEC = 300

    def __init__(
        self,
        *,
        uv_runtime: BundledUvRuntime,
        resources: Optional[BundledRuntimeResources] = None,
        data_home: Optional[Path] = None,
    ) -> None:
        self.uv_runtime = uv_runtime
        self.resources = resources or uv_runtime.resources
        self.data_home = Path(
            data_home or Path.home() / ".bridgic" / "AmphiAgent"
        ).expanduser()
        self.root = self.data_home / "python" / "base"
        self._process_lock = threading.Lock()
        self._python_fingerprint: Optional[tuple[Path, str]] = None
        self._ready = False

    @property
    def python_executable(self) -> Path:
        """Return the interpreter inside the shared base."""
        relative = Path("Scripts/python.exe") if os.name == "nt" else Path("bin/python")
        return self.root / relative

    @property
    def bin_dir(self) -> Path:
        """Return the executable directory inside the shared base."""
        return self.root / ("Scripts" if os.name == "nt" else "bin")

    @cache
    def bundled_runtime_dir(self) -> Optional[Path]:
        """Resolve the packaged read-only Python runtime directory."""
        override = os.environ.get("AMPHI_BUNDLED_PYTHON_RUNTIME_DIR")
        if override:
            candidate = Path(override)
            return candidate if candidate.is_dir() else None

        resources_dir = self.resources.directory()
        if resources_dir is None:
            return None
        candidate = resources_dir / self.RUNTIME_DIR_NAME
        return candidate if candidate.is_dir() else None

    @cache
    def bundled_executable(self) -> Optional[Path]:
        """Resolve the interpreter in the packaged read-only Python runtime."""
        override = os.environ.get("AMPHI_BUNDLED_PYTHON")
        if override:
            candidate = Path(override)
            return candidate.expanduser().resolve() if candidate.is_file() else None

        runtime_dir = self.bundled_runtime_dir()
        if runtime_dir is None:
            return None
        manifest_path = runtime_dir / self.RUNTIME_MANIFEST_NAME
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            relative = manifest.get("executable")
            if isinstance(relative, str):
                candidate = (runtime_dir / relative).resolve()
                if (
                    candidate.is_relative_to(runtime_dir.resolve())
                    and candidate.is_file()
                ):
                    return candidate
        except (OSError, ValueError, TypeError):
            logger.warning(
                "Bundled Python manifest is missing or invalid: %s",
                manifest_path,
            )

        names = ("python.exe",) if os.name == "nt" else ("python3", "python")
        for name in names:
            for candidate in sorted(runtime_dir.glob(f"**/{name}")):
                if candidate.is_file():
                    return candidate.resolve()
        return None

    def ensure(self) -> Optional[Path]:
        """Create the shared base once and return its interpreter.

        The product command boundary validates bundled Python before calling
        this method. Low-level permissive callers may still receive ``None``;
        they must not execute Agent commands with a host interpreter.

        Returns
        -------
        Path, optional
            Shared base interpreter, or ``None`` when no bundled Python exists.

        Existing files are never removed to answer a runtime update. When the
        packaged interpreter changes, uv refreshes the venv metadata and
        launchers in place while preserving site-packages and every other
        user-installed file.
        """
        bundled_python = self.bundled_executable()
        if bundled_python is None:
            if getattr(sys, "frozen", False):
                raise BundledRuntimeUnavailable(
                    "Bundled Python is unavailable; the shared Python base cannot be prepared"
                )
            return None
        uv_executable = self.uv_runtime.bundled_executable()
        if uv_executable is None:
            raise BundledRuntimeUnavailable(
                "Bundled uv is unavailable; the shared Python base cannot be prepared"
            )
        identity = self._runtime_identity(bundled_python)

        with self._process_lock:
            if self._ready and self._probe(self.root, identity).usable:
                return self.python_executable
            parent = self._prepare_parent()
            try:
                with FileLock(parent / ".base.lock", timeout=self.PREPARE_TIMEOUT_SEC):
                    self._recover_interrupted_install()
                    self._prepare_base(uv_executable, bundled_python, identity)
                    self._ensure_pip()
            except FileLockTimeout as exc:
                raise RuntimeError(
                    "Timed out waiting for the shared Python base"
                ) from exc
            self._ready = True
            return self.python_executable

    def executable(self) -> Optional[Path]:
        """Return the interpreter exposed to app-managed commands."""
        return self.ensure()

    @cache
    def version(self) -> Optional[str]:
        """Return the shared interpreter version without raising on probe failure."""
        executable = self.executable()
        if executable is None:
            return None
        try:
            result = subprocess.run(
                # `-B` for the same reason as the isolated probes below: this
                # starts a real interpreter, and whatever it compiles would land
                # inside the signed bundle. `--version` prints before any user
                # code or sys.path lookup happens, so it needs none of the rest
                # of the isolation the probes below carry.
                [str(executable), "-B", "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                **self._subprocess_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        match = re.match(r"^Python\s+(\S+)", (result.stdout or result.stderr).strip())
        return match.group(1) if match is not None else None

    def apply(self, target: MutableMapping[str, str]) -> None:
        """Inject the shared base into one user-command environment."""
        for name in (
            "UV_PROJECT",
            "PYTHONHOME",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "PIP_PREFIX",
            "PIP_TARGET",
            "PIP_USER",
        ):
            self._remove_env(target, name)
        python = self.ensure()
        if python is None:
            self._remove_env(target, "VIRTUAL_ENV")
            self._remove_env(target, "UV_PROJECT_ENVIRONMENT")
            return
        self._prepend_path(target, str(self.bin_dir))
        self._replace_env(target, "VIRTUAL_ENV", str(self.root))
        self._replace_env(target, "UV_PROJECT_ENVIRONMENT", str(self.root))
        self._replace_env(target, "UV_PYTHON", str(python))
        self._replace_env(target, "UV_PYTHON_DOWNLOADS", "never")
        self._replace_env(target, "UV_PYTHON_PREFERENCE", "only-managed")
        self._replace_env(target, "PYTHONNOUSERSITE", "1")
        self._replace_env(
            target,
            "PYTHONPYCACHEPREFIX",
            str(self.data_home / "python" / "pycache"),
        )
        self._replace_env(target, "PIP_CONFIG_FILE", os.devnull)
        self._replace_env(target, "PIP_USER", "0")

    def reset(self) -> None:
        """Forget process-local readiness without deleting the shared base."""
        self._python_fingerprint = None
        self._ready = False
        self.bundled_runtime_dir.cache_clear()
        self.bundled_executable.cache_clear()
        self.version.cache_clear()

    @staticmethod
    def _remove_env(target: MutableMapping[str, str], name: str) -> None:
        normalized = name.casefold()
        for existing in list(target):
            if existing.casefold() == normalized:
                del target[existing]

    @classmethod
    def _replace_env(
        cls,
        target: MutableMapping[str, str],
        name: str,
        value: str,
    ) -> None:
        cls._remove_env(target, name)
        target[name] = value

    @staticmethod
    def _prepend_path(target: MutableMapping[str, str], directory: str) -> None:
        path = target.get("PATH", "")
        if directory in path.split(os.pathsep):
            return
        target["PATH"] = f"{directory}{os.pathsep}{path}" if path else directory

    def _prepare_base(self, uv_executable: Path, bundled_python: Path, identity: dict[str, str]) -> None:
        probe = self._probe(self.root, identity)
        if probe.usable:
            return
        if probe.unreadable:
            raise EnvNotReady(probe.path, probe.error)
        try:
            self.root.lstat()
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise EnvNotReady(self.root, exc) from exc
        else:
            if not is_directory(self.root):
                raise RuntimeError(
                    f"The shared Python base at {self.root} is not a directory; preserving it unchanged"
                )
        self._prepare_venv(uv_executable, bundled_python, identity)

    def _prepare_venv(self, uv_executable: Path, bundled_python: Path, identity: dict[str, str]) -> None:
        environment = os.environ.copy()
        self.uv_runtime.bootstrap_env(environment)
        for name in ("VIRTUAL_ENV", "UV_PROJECT", "UV_PROJECT_ENVIRONMENT"):
            environment.pop(name, None)
        environment["UV_PYTHON"] = str(bundled_python)
        # uv spawns the packaged interpreter itself while seeding the base, so
        # there is no argv of ours to put `-B` on. Without this, creating the
        # base leaves bytecode inside the signed bundle.
        environment = no_bytecode_environment(environment)
        try:
            result = subprocess.run(
                [
                    str(uv_executable),
                    "venv",
                    "--no-project",
                    "--no-config",
                    "--python",
                    str(bundled_python),
                    "--relocatable",
                    "--allow-existing",
                    str(self.root),
                ],
                cwd=self.root.parent,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.PREPARE_TIMEOUT_SEC,
                **self._subprocess_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Timed out preparing the shared Python base") from exc
        if result.returncode != 0:
            detail = (
                result.stderr.strip()
                or result.stdout.strip()
                or "uv created no usable environment"
            )
            raise RuntimeError(f"Failed to prepare the shared Python base: {detail}")
        self._write_manifest(identity)
        if not self._probe(self.root, identity).usable:
            raise RuntimeError("Failed to prepare the shared Python base: uv created no usable environment")

    def _write_manifest(self, identity: dict[str, str]) -> None:
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

    def _runtime_identity(self, bundled_python: Path) -> dict[str, str]:
        resolved_python = bundled_python.expanduser().resolve()
        cached = self._python_fingerprint
        if cached is None or cached[0] != resolved_python:
            digest = hashlib.sha256()
            try:
                with resolved_python.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError as exc:
                raise RuntimeError("Bundled Python is unreadable") from exc
            cached = (resolved_python, digest.hexdigest())
            self._python_fingerprint = cached
        identity = {"python": str(resolved_python), "pythonSha256": cached[1]}
        runtime_dir = self.bundled_runtime_dir()
        if runtime_dir is None:
            return identity
        try:
            manifest = json.loads(
                (runtime_dir / self.RUNTIME_MANIFEST_NAME).read_text(
                    encoding="utf-8"
                )
            )
        except (OSError, ValueError, TypeError):
            return identity
        for name in ("pythonVersion", "target"):
            value = manifest.get(name)
            if isinstance(value, str) and value:
                identity[name] = value
        return identity

    def _ensure_pip(self) -> None:
        """Install pip from Python's bundled ensurepip wheel without network access."""
        if self._pip_available():
            return
        if self._pip_imports():
            # Importable but not usable is the one shape ensurepip cannot fix,
            # and the only one worth touching site-packages over. Every other
            # way this check says no -- no pip at all, a probe that timed out,
            # a launcher that could not be stat-ed -- must not be answered by
            # deleting from an environment the user has been installing into.
            self._retract_pip_metadata()
        environment = os.environ.copy()
        for name in (
            "PYTHONHOME",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "PIP_PREFIX",
            "PIP_TARGET",
            "PIP_USER",
            "VIRTUAL_ENV",
        ):
            self._remove_env(environment, name)
        environment["VIRTUAL_ENV"] = str(self.root)
        environment["PYTHONNOUSERSITE"] = "1"
        environment["PIP_CONFIG_FILE"] = os.devnull
        try:
            result = subprocess.run(
                # Deliberately NOT isolated_python_command: ensurepip runs pip in
                # a subprocess and copies our isolation into it --
                # `if sys.flags.isolated: cmd.insert(1, '-I')` in CPython's
                # ensurepip -- while giving that subprocess no `-B` of its own.
                # It then compiles pip's whole dependency tree (importlib, email,
                # urllib, http, zipfile, ...) into the signed bundle: 164 files
                # measured. Dropping `-I` is what lets PYTHONDONTWRITEBYTECODE
                # reach the grandchild.
                #
                # `-P` replaces the half of `-I` that still matters here. `-m`
                # puts the CWD on sys.path[0], and the CWD is the writable shared
                # base -- a .py dropped there shadowing anything ensurepip
                # imports would execute during the pip bootstrap. `-P` closes
                # that without implying `-E`. The rest of the isolation is the
                # environment: it strips PYTHONHOME/PYTHONPATH/PYTHONUSERBASE
                # and PYTHONBREAKPOINT, and pins PYTHONNOUSERSITE.
                [
                    str(self.python_executable),
                    "-P",
                    "-B",
                    "-m",
                    "ensurepip",
                    "--upgrade",
                    "--default-pip",
                ],
                cwd=self.root,
                env=no_bytecode_environment(environment),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.PREPARE_TIMEOUT_SEC,
                **self._subprocess_kwargs(),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Timed out installing pip into the shared Python base") from exc
        if result.returncode != 0 or not self._pip_available():
            detail = (
                result.stderr.strip()
                or result.stdout.strip()
                or "ensurepip did not create an importable pip module"
            )
            if result.returncode == 0:
                # Quoting ensurepip alone here is how this failure read as
                # "Failed to install pip: Successfully installed pip" -- a
                # sentence that tells a user nothing about which half is lying.
                detail = f"ensurepip reported success and pip is still unusable: {detail}"
            raise RuntimeError(f"Failed to install pip into the shared Python base: {detail}")

    def _retract_pip_metadata(self) -> None:
        """Withdraw the claim that pip is installed, so ensurepip installs it.

        ``--upgrade`` installs nothing when a ``pip-*.dist-info`` already
        records the version ensurepip bundles -- and so writes no launcher. A
        pip that arrived without one therefore imports fine, satisfies the
        upgrade, and can never be repaired: every attempt reports success while
        the launcher stays missing.

        Only the metadata goes. Removing the package directory as well is both
        unnecessary and dangerous: ensurepip reinstalls over it either way,
        while a delete that lands there and not on the metadata leaves a base
        where pip no longer imports *and* the upgrade is still satisfied --
        strictly worse than the state being repaired, and just as permanent.
        Measured against the packaged interpreter, both ways round.
        """
        site = self._site_packages()
        if site is None:
            logger.warning(
                "Cannot locate site-packages in %s to repair pip", self.root
            )
            return
        for metadata in sorted(site.glob("pip-*.dist-info")):
            logger.warning("Reinstalling a pip that has no launcher: %s", metadata)
            self._remove(metadata)

    def _site_packages(self) -> Optional[Path]:
        """Ask the base's own interpreter where installed packages live.

        Hand-rolling the layout means one branch per platform, each dead on
        the platform its author is working from. The interpreter answers for
        whatever it actually is, and it has just proved it runs.
        """
        try:
            result = subprocess.run(
                isolated_python_command(
                    self.python_executable,
                    "-c",
                    "import sysconfig; print(sysconfig.get_path('purelib'))",
                ),
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                **self._subprocess_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.returncode != 0:
            return None
        site = Path(result.stdout.strip())
        return site if site.is_dir() else None

    def _pip_available(self) -> bool:
        launcher = self.bin_dir / ("pip.exe" if os.name == "nt" else "pip")
        return launcher.is_file() and self._pip_imports()

    def _pip_imports(self) -> bool:
        """Return whether pip imports in the base, ignoring the launcher."""
        try:
            result = subprocess.run(
                isolated_python_command(self.python_executable, "-c", "import pip"),
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                **self._subprocess_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == 0

    def _prepare_parent(self) -> Path:
        parent = self.root.parent
        if parent.is_symlink():
            raise RuntimeError("The app-level Python directory must not be a symlink")
        parent.mkdir(parents=True, exist_ok=True)
        if parent.is_symlink() or not parent.is_dir():
            raise RuntimeError("The app-level Python directory is unavailable")
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
                "Restored the preserved Python base from %s; it will be migrated in place",
                backup,
            )
            return
        if blocked_backup is not None:
            raise EnvNotReady(*blocked_backup)

    def _probe(self, root: Path, identity: dict[str, str]) -> BaseProbe:
        """Return a tri-state verdict for one candidate base.

        A directory whose DACL stopped granting the running user denies every
        read inside it, so an intact base reads as missing. The probe reports
        that as unreadable rather than folding it into "broken". Callers wait
        for access to return; they never quarantine or replace the directory.
        """
        return probe_base(root, lambda: self._inspect(root, identity))

    def _inspect(self, root: Path, identity: dict[str, str]) -> bool:
        """Return whether ``root`` is usable, letting ``OSError`` escape."""
        python = root / (
            Path("Scripts/python.exe") if os.name == "nt" else Path("bin/python")
        )
        manifest_path = root / self.MANIFEST_NAME
        if not is_directory(root) or not is_regular_file(root / "pyvenv.cfg"):
            return False
        # The interpreter follows links on purpose: a relocatable venv points
        # ``bin/python`` at the packaged runtime rather than copying it.
        if not resolves_to_file(python) or not is_regular_file(manifest_path):
            return False
        return json.loads(manifest_path.read_text(encoding="utf-8")) == identity

    @staticmethod
    def _remove(path: Path) -> bool:
        """Delete a path, reporting whether it is actually gone.

        Silent failures used to strand whole venvs under ``python/``; callers
        that go on to write over the path need to know the delete did not land.
        """
        try:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            elif path.exists() or path.is_symlink():
                path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Failed to remove %s", path, exc_info=True)
            return False
        return True

    @staticmethod
    def _subprocess_kwargs() -> dict[str, int]:
        if sys.platform != "win32":
            return {}
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
