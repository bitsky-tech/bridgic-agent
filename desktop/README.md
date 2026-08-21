# Bridgic Agent — desktop

Electron GUI client for the Bridgic Agent Python daemon.

> Two of the daemon's identifiers do not spell the product name: the CLI is
> `amphi` and its runtime directory is `~/.bridgic/AmphiAgent/`. Both are
> contracts rather than alternative product names —
> `apps/electron/src/shared/app-meta.ts` has the full mapping.

The Python service is a long-lived daemon — multiple clients (this GUI,
the `amphi` CLI, future IDE extensions) share it. The GUI talks
directly to the daemon over REST and a multiplexed WebSocket; Electron `main` only
manages window state, native dialogs, and daemon lifecycle coordination
via the `amphi server` CLI.

> See the repository [`README`](../README.md) for the product and architecture overview. HTTP routes are defined in `../src/amphi_service/_app.py` and `../src/amphi_service/handler/`; WebSocket frames are defined in `../src/amphi_service/protocol/` and mirrored in `apps/electron/src/shared/ws-protocol.ts`.
> Pseudonymous desktop usage telemetry is implemented in
> [`apps/electron/src/main/telemetry/`](apps/electron/src/main/telemetry/).

## Repo layout

```
desktop/                     (sub-project of the Bridgic Agent repository)
├── apps/electron/          Electron app (main + preload + renderer)
│   ├── src/main/
│   │   ├── python-client/  PythonClient — discover/spawn daemon via `amphi server`
│   │   ├── settings/       Sync-loadable GuiSettings (theme/font/window/locale)
│   │   ├── handlers/       IPC: app/backend/dialog/permissions/settings/shell/system/window
│   │   └── ...             window-manager · auto-update · deep-link · etc.
│   ├── src/preload/        Inject window.api + window.__initialSettings__
│   ├── src/renderer/
│   │   ├── atoms/          Jotai: backend / chat / settings / permissions / window-close
│   │   ├── components/     App shell, chat, composer, settings, schedules, and shared UI
│   │   ├── lib/            AmphiClient (HTTP), WebSocket client, i18n, logger, api-stub
│   │   └── ...
│   ├── src/shared/         IPC channel constants + ElectronAPI types + app-meta
│   ├── build/              electron-builder hooks (after-pack, pkg/deb/nsis scripts)
│   └── resources/          icons, entitlements.mac.plist, systemd unit
├── packages/               Workspace deps (shared, ui)
└── scripts/                Build orchestrators + prebuild-fetch-amphi
```

> The root README is the overview; executable contracts live in source and
> tests.

## Prerequisites

- **Bun** ≥ 1.3 — `curl -fsSL https://bun.sh/install | bash`
- **The backend** — `desktop/` is a sub-project of this repository, so the
  backend is already the parent directory (no separate clone). Build its dev
  `amphi` CLI:
  ```
  cd .. && uv sync   # at the repository root → produces the dev-mode `amphi` CLI
  ```

The Electron `main` process locates the `amphi` binary in this priority
order (`apps/electron/src/main/python-client/path-resolver.ts`):
1. `$AMPHI_BIN` env override
2. Production: `<.app>/Contents/Resources/bin/amphi` (bundled by installer)
3. Development CLI: `../.venv/bin/amphi` at the repository root (`.venv/Scripts/amphi.exe` on Windows)

## Quick start (dev)

```bash
bun install
bun run dev
```

`bun run dev` first validates the pinned uv, Python, and Node resources under
`apps/electron/resources/`, fetching only a missing or stale runtime. It then
launches Vite + Electron with HMR and injects that absolute Resources path into
the development backend. Electron starts the daemon when necessary or adopts
an already-running one.

To run the daemon in the foreground, prepare the resources before starting it:

```bash
# Terminal 1 — desktop/
bun run dev:resources
cd .. && ./.venv/bin/amphi server serve

# Terminal 2 — desktop/
bun run dev
```

The project `.venv` only runs the daemon. Agent Bash commands still use the
bundled uv/Python/Node and the shared app-level bases. A source daemon fails at
startup if those resources are incomplete; it never falls back to `.venv`,
Homebrew, nvm, or another host runtime.

The GUI's top bar shows a live status pill (idle / discovering /
spawning / ready / unhealthy / unavailable). With the daemon already
running, you should land in **ready** in well under 200 ms — the
PythonClient just probes `amphi server status` and adopts the
endpoint. Click "New Session", optionally pick a workspace, then chat.

## Common commands

| Command | What it does |
|---|---|
| `bun run dev` | Start the app in dev mode (Vite + Electron + HMR). |
| `bun run dev:resources` | Validate/fetch host uv, Python, and Node resources without starting Electron. |
| `bun run typecheck` | Strict TS check across all workspaces. |
| `bun run lint` | ESLint over apps/packages/scripts. |
| `bun run test` | bun:test unit tests (scoped to apps/packages/scripts). |
| `bun run start` | Build + run the production-bundled Electron. |
| `bun run dist:mac` | Run prebuild + electron-builder → arm64 .pkg + updater .zip. |
| `bun run dist:mac:x64` | The same for Intel; a release carries both architectures. |
| `bun run dist:win` | Run prebuild + electron-builder → .exe (NSIS). |
| `bun run dist:linux` | Run prebuild + electron-builder → .deb. |

## Packaging the full installer (rare; CI / release path)

The installer bundles the backend daemon as a PyInstaller onedir bundle,
plus pinned uv, Python, and Node runtimes. Agent commands therefore do not
depend on host Python/Node or download an interpreter on first use.

```bash
# 1. macOS/Linux: build the standalone bundle (launcher → ../dist/amphi/amphi)
cd .. && bash build/build-pyinstaller.sh

# Windows PowerShell equivalent (CLI + windowless login shim → ..\dist\amphi\):
# cd ..; .\build\build-pyinstaller.ps1

# 2. Back in desktop/, run the platform target. `prebuild:fetch-amphi`
#    copies the daemon into apps/electron/resources/bin/, and
#    the remaining prebuild steps prepare uv_runtime/, python_runtime/,
#    and node_runtime/.
cd desktop && bun run dist:mac
```

Output lands in `apps/electron/release/`. The `.pkg` installer's
`postinstall` script registers a launchd user agent and symlinks
`/usr/local/bin/amphi` so the daemon starts at every login and the CLI
is on every user's `PATH`.

Note: PyInstaller's first-run on a new machine often surfaces missing
`hiddenimports` — fix them in `../build/amphi.spec` and rebuild.

Note: step 1 is **not optional and not automatic** — `prebuild:fetch-amphi`
only *copies* an existing `../dist/amphi/` bundle; it never builds one. Skipping it
fails the run immediately.

The steps above are the local path. Shipping goes through the `Package`
workflow instead — see [Releasing](../README.md#releasing) in the repository
README for its triggers, the platform matrix, and which builds reach existing
users. The short version: a bare-semver tag publishes a normal release, and a
normal release is delivered to every installed client on its next update check.

## macOS code signing & notarization

Signing is already wired end-to-end (`hardenedRuntime` + `resources/entitlements.mac.plist`
+ the `build/after-pack.cjs` hook that signs the bundled `amphi`, `uv`, Python,
and Node runtime binaries). You only need credentials — no code changes.

**1. Two certificates, not one.** `mac.target` includes `pkg`, and
electron-builder signs it with a *different* cert than the app
(`targets/pkg.js` hardcodes `certType = "Developer ID Installer"`):

| Certificate | Signs |
|---|---|
| `Developer ID Application` | `.app` / dmg / zip / bundled binaries |
| `Developer ID Installer` | `.pkg` |

Create both in Xcode → Settings → Accounts → Manage Certificates → `+`.
Verify with `security find-identity -v` — note the bare form: **`-p codesigning`
hides the Installer cert** (it's a productsign-policy cert, not a codesigning one).

**2. Fill `.env`** (see `.env.example`). `APPLE_SIGNING_IDENTITY` **must be
quoted** — unquoted, the parentheses are shell syntax, the var silently becomes
empty, and the build downgrades to unsigned with no error.

**3. Verify credentials BEFORE building** — notarization is the last step of a
~40min pipeline, so a wrong password costs the whole run:

```bash
source .env && xcrun notarytool history --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
# valid → prints history (empty list is fine); invalid → HTTP 401
```

**4. After building, confirm Gatekeeper accepts it** (signing ≠ notarized):

```bash
spctl -a -vvv -t exec "apps/electron/release/mac-arm64/Bridgic Agent.app"
# want: accepted / source=Notarized Developer ID
```

### Known failure modes

- **`Failed to notarize via notarytool. Failed with unexpected result:`** with an
  empty message — electron-notarize runs `submit --wait --output-format json`,
  which only emits JSON on completion, so an early exit yields `JSON.parse('')`
  (`notarytool.js:135-141`). **Apple most likely accepted the submission anyway.**
  Check before rebuilding:

  ```bash
  source .env && xcrun notarytool history --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
  # Accepted → just staple; no rebuild needed:
  xcrun stapler staple "apps/electron/release/Bridgic-Agent-0.1.0-arm64.pkg"
  ```

- **pkg notarization is slow** — the large pkg and its onedir runtime tree can sit `In Progress`
  for an hour or more. Not an error. Poll with `notarytool info <submission-id>`.

- **Re-running `build-dmg.sh` deletes `release/`** (`rm -rf release`). Don't run
  it while an earlier artifact is still awaiting notarization — you'll have
  nothing left to staple the ticket onto.
