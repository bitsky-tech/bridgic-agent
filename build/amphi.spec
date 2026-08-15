# PyInstaller spec for the `amphi` CLI binary.
#
# Produces a ONEDIR bundle embedding Python + the runtime dependencies declared
# by pyproject.toml, so amphi-desktop can ship a self-contained daemon without
# requiring users to install Python.
#
# Run from the repo root:
#   bash build/build-pyinstaller.sh     (POSIX)
#   .\build\build-pyinstaller.ps1       (Windows)
#
# Output: dist/amphi/amphi(.exe)  +  dist/amphi/_internal/
# Windows additionally emits dist/amphi/amphi-autostart.exe, a GUI-subsystem
# login shim that starts the console CLI without opening a console window.
#
# Why onedir and not onefile
# --------------------------
# onefile re-extracts the ENTIRE archive into a temp dir on every single launch.
# Measured on Windows 11 (2026-07-28): `amphi --version` alone took 22.6 s,
# unpacking 137 MB into %TEMP%\_MEIxxxx with Defender scanning each file on the
# way out. The desktop app's CLI timeout is 15 s, so every call the GUI made
# timed out and the daemon could neither be started nor probed — that single
# fact accounted for most of the "cannot connect to gateway" reports. Crashed
# runs additionally leak their _MEI dir (312 MB of leftovers on the test box).
#
# onedir keeps the payload next to the executable, making startup an ordinary
# process spawn. The bundle's CONTENTS are copied into the app's Resources/bin/
# (see desktop/scripts/prebuild-fetch-amphi.ts), so `resources/bin/amphi(.exe)`
# stays exactly where every downstream consumer already looks for it:
# path-resolver.ts, installer.nsh's PATH injection, and deb-scripts/postinst.

# ruff: noqa
import importlib.metadata as metadata
import sys
import tomllib
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from PyInstaller.utils.hooks import collect_all, copy_metadata

PROJECT_ROOT = Path('.').resolve()
PYPROJECT = PROJECT_ROOT / 'pyproject.toml'

# Distribution names do not always match their import roots. These are generic
# package-name/import-name mappings plus namespace roots that are too broad if
# inferred from metadata alone.
DIST_IMPORT_OVERRIDES = {
    'bridgic-amphibious': ['bridgic'],
    'bridgic-browser': ['bridgic'],
    'bridgic-core': ['bridgic'],
    'bridgic-llms-openai': ['bridgic'],
    'bridgic-llms-openai-like': ['bridgic'],
    'google-auth': ['google.auth'],
    'google-genai': ['google.genai'],
    'googleapis-common-protos': ['google.api'],
    'protobuf': ['google.protobuf'],
    'python-dotenv': ['dotenv'],
    'python-multipart': ['multipart', 'python_multipart'],
    'pyyaml': ['yaml'],
    'typing-extensions': ['typing_extensions'],
}

# Optional extras that import missing optional dependencies while being scanned.
# Filtering these keeps the build deterministic without affecting runtime paths
# used by Bridgic Agent.
OPTIONAL_SUBMODULE_PREFIXES = (
    'authlib.integrations.flask_oauth2',
    'key_value.aio.stores.windows_registry',
    'mcp.cli',
    'openai.helpers',
    'urllib3.contrib.emscripten',
)


def _is_vendored_playwright_node(entry_path):
    """True for Playwright's vendored Node binary (``.../driver/node[.exe]``).

    That single file is ~118 MB raw / 37 MB compressed — 35% of the whole
    binary. The app ships its own Node 22 in ``Resources/node_runtime`` and
    points Playwright at it through ``PLAYWRIGHT_NODEJS_PATH``
    (see ``src/amphi_agent/runtime/_node_env.py::BundledNodeRuntime``), so embedding a
    second copy here is pure weight.

    Matching on path shape rather than an exact string keeps it correct for both
    the archive name (``playwright/driver/node``) and the on-disk source path,
    and covers ``node.exe`` on Windows. The ``playwright/`` parent is part of the
    match so an unrelated ``<pkg>/driver/node.py`` can never be silently dropped
    from the shipped binary.
    """
    path = Path(entry_path)
    return (
        path.stem == 'node'
        and path.parent.name == 'driver'
        and path.parent.parent.name == 'playwright'
    )


def _extend_unique(target, values):
    seen = set(target)
    for value in values:
        if value not in seen:
            target.append(value)
            seen.add(value)


def _load_project_requirements():
    # encoding="utf-8" is load-bearing, not tidiness. `read_text()` without it
    # uses the process locale encoding, which is cp1252 on the Windows runner —
    # and pyproject.toml carries a non-ASCII `authors` entry, so the build died
    # with `UnicodeDecodeError: 'charmap' codec can't decode byte 0x90` before
    # PyInstaller had analysed a single module. TOML is defined as UTF-8, so the
    # locale never had a say here in the first place.
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    return [Requirement(item) for item in data['project']['dependencies']]


def _requirement_marker_applies(requirement, envs):
    return requirement.marker is None or any(
        requirement.marker.evaluate(env) for env in envs
    )


def _runtime_dependency_closure(seed_requirements):
    """Resolve the installed runtime distribution closure from pyproject deps."""
    base_env = default_environment()
    queue = list(seed_requirements)
    included = []
    included_names = set()
    processed_requirement_shapes = set()

    index = 0
    while index < len(queue):
        requirement = queue[index]
        index += 1

        dist_name = canonicalize_name(requirement.name)
        requirement_shape = (dist_name, tuple(sorted(requirement.extras)))
        if requirement_shape in processed_requirement_shapes:
            continue
        processed_requirement_shapes.add(requirement_shape)

        if dist_name not in included_names:
            included.append(dist_name)
            included_names.add(dist_name)

        try:
            dist = metadata.distribution(dist_name)
        except metadata.PackageNotFoundError:
            print(f'[amphi.spec] warning: distribution not installed: {dist_name}')
            continue

        envs = [base_env]
        envs += [{**base_env, 'extra': extra} for extra in requirement.extras]
        for child_text in dist.requires or []:
            child = Requirement(child_text)
            if _requirement_marker_applies(child, envs):
                queue.append(child)

    return included


def _packages_by_distribution():
    result = {}
    for package_name, distribution_names in metadata.packages_distributions().items():
        for distribution_name in distribution_names:
            normalized = canonicalize_name(distribution_name)
            result.setdefault(normalized, set()).add(package_name)
    return result


PACKAGES_BY_DISTRIBUTION = _packages_by_distribution()


def _import_roots_for_distribution(distribution_name):
    normalized = canonicalize_name(distribution_name)
    if normalized in DIST_IMPORT_OVERRIDES:
        return DIST_IMPORT_OVERRIDES[normalized]
    return sorted(PACKAGES_BY_DISTRIBUTION.get(normalized, ()))


def _should_collect_submodule(module_name):
    parts = module_name.split('.')
    if 'tests' in parts or 'testing' in parts:
        return False

    return not any(
        module_name == prefix or module_name.startswith(prefix + '.')
        for prefix in OPTIONAL_SUBMODULE_PREFIXES
    )


def _collect_distribution(
    distribution_name,
    datas,
    binaries,
    hiddenimports,
    collected_import_roots,
):
    try:
        _extend_unique(datas, copy_metadata(distribution_name))
    except Exception as exc:
        print(
            f'[amphi.spec] warning: metadata not collected for '
            f'{distribution_name}: {exc}'
        )

    for import_root in _import_roots_for_distribution(distribution_name):
        if import_root in collected_import_roots:
            continue
        collected_import_roots.add(import_root)

        try:
            package_datas, package_binaries, package_hiddenimports = collect_all(
                import_root,
                # PyInstaller's two collectors disagree on this default:
                # collect_data_files() is False, collect_all() is True. Leaving it
                # at the default duplicated every dependency's .py SOURCE into the
                # bundle as data — 6741 files / 76 MB, 81% of all files — while the
                # modules themselves already live compiled inside the PYZ archive
                # (the bundle contains zero .pyc, confirming nothing loads from
                # these copies). That dead weight is paid three times over: NSIS
                # compression, Apple notarization's per-file scan, and the
                # installer's CopyFiles stage (the visibly slow second pass of the
                # progress bar).
                #
                # Anything that genuinely must exist as a real file on disk has to
                # be declared explicitly — see BUILTIN_SKILLS_DATAS below.
                include_py_files=False,
                filter_submodules=_should_collect_submodule,
                on_error='warn once',
            )
        except Exception as exc:
            print(
                f'[amphi.spec] warning: package not collected for '
                f'{distribution_name} ({import_root}): {exc}'
            )
            continue

        _extend_unique(datas, package_datas)
        _extend_unique(binaries, package_binaries)
        _extend_unique(hiddenimports, package_hiddenimports)


def _builtin_skills_datas():
    """The product's built-in Skills, declared EXPLICITLY rather than collected.

    These are content, not code: ``_skills.py`` walks the directory to discover
    Skills, reads each ``SKILL.md``, and the agent executes ``scripts/*.py`` as
    standalone files. They must therefore exist as real files on disk — being
    importable is not enough.

    Declared here instead of relying on ``collect_all`` for two reasons:

    1. ``include_py_files=False`` (see ``_collect_distribution``) would otherwise
       strip ``scripts/*.py`` and the daemon would die at startup with
       ``FileNotFoundError: .../builtin_skills``.
    2. Implicit collection silently depends on how the project was installed.
       With an editable install ``packages_distributions()`` does not report
       ``bridgic-agent`` at all, so ``collect_all`` was never called for it and
       ``_internal/src/`` was missing from the bundle entirely — verified
       2026-07-28. CI happens to use ``uv sync --no-editable`` and got away with
       it; any other install mode shipped a broken bundle.

    The destination path must stay ``src/amphi_agent/builtin_skills``: frozen
    modules keep a virtual ``__file__`` under ``sys._MEIPASS``, and
    ``_skills.py`` resolves ``Path(__file__).parent / "builtin_skills"``.
    ``security/_registry.py::APP_BUILTIN_ROOTS`` derives the trust boundary from
    the same location, so moving it would also move a security boundary.
    """
    root = PROJECT_ROOT / 'src' / 'amphi_agent' / 'builtin_skills'
    if not root.is_dir():
        raise SystemExit(f'[amphi.spec] built-in Skills missing: {root}')
    entries = []
    for path in root.rglob('*'):
        if not path.is_file():
            continue
        # Preserve the tree shape: dest is the file's parent, relative to src/.
        dest = path.parent.relative_to(PROJECT_ROOT).as_posix()
        entries.append((str(path), dest))
    if not entries:
        raise SystemExit(f'[amphi.spec] built-in Skills directory is empty: {root}')
    print(f'[amphi.spec] built-in Skills: {len(entries)} files declared explicitly')
    return entries


datas = _builtin_skills_datas()
binaries = []
hiddenimports = []
collected_import_roots = set()

runtime_distributions = ['bridgic-agent']
runtime_distributions += _runtime_dependency_closure(_load_project_requirements())

for distribution_name in runtime_distributions:
    _collect_distribution(
        distribution_name,
        datas,
        binaries,
        hiddenimports,
        collected_import_roots,
    )

a = Analysis(
    # NOT src/__main__.py: that file uses `from .amphi_cli import dispatch`
    # which requires `__package__ == 'src'`. PyInstaller runs the entry as
    # a top-level `__main__`, so the relative import fails at runtime with
    # `ImportError: attempted relative import with no known parent package`.
    # build/amphi_entry.py is a thin launcher that does the same dispatch
    # via absolute import.
    [str(PROJECT_ROOT / 'build' / 'amphi_entry.py')],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    # rthook_certifi: export SSL_CERT_FILE -> bundled cacert.pem so httpx/ssl
    # can build a default SSL context in the frozen binary.
    runtime_hooks=[str(PROJECT_ROOT / 'build' / 'rthook_certifi.py')],
    excludes=[
        # Build/test tooling should not leak into the runtime binary.
        # `_pytest` is a separate top-level package: excluding only 'pytest'
        # still left it (plus setuptools) in the archive, ~1.3 MB compressed.
        'pytest',
        '_pytest',
        'setuptools',
        # The daemon is headless; Tk is pulled in only because tqdm ships a
        # tqdm/tk.py. ~1.9 MB compressed across libtcl, libtk and _tcl_data.
        'tkinter',
        '_tkinter',
    ],
    noarchive=False,
)

# Drop Playwright's vendored Node AFTER Analysis, not during collection:
# Playwright registers its own PyInstaller hook (playwright/_impl/__pyinstaller/,
# auto-discovered via entry point) that re-collects the whole package with
# collect_data_files, so anything filtered earlier simply comes back. Analysis is
# the one choke point every collection path funnels into.
#
# Both lists are filtered because PyInstaller reclassifies the Mach-O/PE `node`
# out of datas and into binaries; it was verified present as a binary entry.
a.datas = [entry for entry in a.datas if not _is_vendored_playwright_node(entry[0])]
a.binaries = [entry for entry in a.binaries if not _is_vendored_playwright_node(entry[0])]

pyz = PYZ(a.pure)

# exclude_binaries=True moves binaries/datas out of the executable and into the
# COLLECT tree below — this is what makes the build onedir rather than onefile.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='amphi',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,  # macOS: amphi-desktop's afterPack hook signs us.
    entitlements_file=None,
)

# A console executable cannot guarantee a zero-flash login launch. Build a
# second, deliberately tiny GUI-subsystem executable on Windows and keep the
# ordinary amphi.exe console-enabled for terminal output. Both executables share
# this onedir tree; the shim forwards only `server start` to its sibling with
# CREATE_NO_WINDOW.
autostart_analysis = None
autostart_exe = None
if sys.platform == 'win32':
    autostart_analysis = Analysis(
        [str(PROJECT_ROOT / 'build' / 'amphi_autostart_entry.py')],
        pathex=[str(PROJECT_ROOT)],
        binaries=[],
        datas=[],
        hiddenimports=[],
        hookspath=[],
        runtime_hooks=[],
        excludes=[
            'pytest',
            '_pytest',
            'setuptools',
            'tkinter',
            '_tkinter',
        ],
        noarchive=False,
    )
    autostart_pyz = PYZ(autostart_analysis.pure)
    autostart_exe = EXE(
        autostart_pyz,
        autostart_analysis.scripts,
        [],
        exclude_binaries=True,
        name='amphi-autostart',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=True,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    )

collect_inputs = [exe, a.binaries, a.datas]
if autostart_exe is not None:
    collect_inputs.extend(
        [
            autostart_exe,
            autostart_analysis.binaries,
            autostart_analysis.datas,
        ]
    )

# Lays out dist/amphi/: launcher(s) plus the shared _internal/ payload.
coll = COLLECT(
    *collect_inputs,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='amphi',
)
