/**
 * Dev orchestrator: vite dev + esbuild --watch for main/preload + spawn Electron.
 *
 *   bun run dev
 *
 * Layout:
 *   1. Read .env (for VITE_DEV_SERVER_URL, APP_*).
 *   2. Resolve the Vite port — reclaim it only from OUR OWN stale dev session.
 *   3. ONE esbuild context per bundle: rebuild() → verify → watch().
 *   4. Spawn vite dev (renderer) and wait until it actually serves.
 *   5. Spawn electron pointing at apps/electron.
 *   6. Clean up everything once, on SIGINT / any process exiting.
 *
 * Ordering invariant (the whole reason this file is shaped like this):
 * Electron MUST NOT be spawned until `main.cjs` + `bootstrap-preload.cjs` are
 * complete on disk and Vite is serving. Violating either produces failures
 * that look like source bugs but aren't:
 *
 *   - Two writers, one file. This used to run a one-shot `esbuild.build()` and
 *     THEN create a watch context over the same `outfile`. `context.watch()`
 *     resolves once watching is REGISTERED, not once its first build is done —
 *     so the watcher immediately rebuilt the same path while Electron was
 *     starting. Electron `require()`ing a half-written bundle throws
 *     `SyntaxError: Invalid or unexpected token` pointing at whatever line the
 *     truncation landed on. The line is innocent; the file was just cut short.
 *     Fix: one context per bundle, `rebuild()` awaited before `watch()`.
 *   - Electron used to spawn immediately after Vite was spawned, so the
 *     renderer could load before the dev server listened. Fix: poll until it
 *     serves, and fail fast if Vite dies first.
 *
 * Non-obvious: main/preload are NOT hot-reloaded. A watch rebuild only updates
 * the bundle on disk — the running Electron keeps the old one until restarted.
 * That is why a rebuild logs a "restart to apply" hint rather than pretending
 * the change is live.
 */

import { spawn, type Subprocess } from 'bun'
import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntimeResources } from './ensure-runtime-resources'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')
const DIST_DIR = join(ELECTRON_DIR, 'dist')
const RESOURCES_DIR = join(ELECTRON_DIR, 'resources')
const BIN_EXT = process.platform === 'win32' ? '.exe' : ''
const VITE_BIN = join(ROOT_DIR, `node_modules/.bin/vite${BIN_EXT}`)
const ELECTRON_BIN = join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`)

const BUILD_TIME_ENV_VARS = [
  'APP_NAME',
  'APP_DEEPLINK_SCHEME',
  'APP_UPDATE_URL',
  'APP_DEBUG',
  'POSTHOG_PROJECT_TOKEN',
]

/** Desktop dir for the dev channel — sibling of production's `~/.bridgic/amphi`. */
const DEV_USER_DIR = join(homedir(), '.bridgic', 'amphi-dev')

/**
 * Give this run a development identity, so it can coexist with an installed
 * production Amphi instead of being killed by its single-instance lock.
 *
 * Called before `getDefines()` on purpose: `APP_DEEPLINK_SCHEME` is a
 * BUILD-time value (esbuild `define` bakes it into the bundle), so setting it
 * after the defines are computed would silently have no effect and the dev
 * build would keep registering the production `amphi://` scheme — on Windows
 * that steals the OS association from the installed app and sends OAuth
 * callbacks to the wrong client.
 *
 * `AMPHI_DEEPLINK_SCHEME_DEV` overrides the dev scheme; the production
 * `APP_DEEPLINK_SCHEME` from `.env` is deliberately NOT honored here — an
 * `.env` copy carrying the production value would defeat the whole point.
 */
function applyDevChannelEnv(): void {
  process.env.AMPHI_DESKTOP_CHANNEL = 'development'
  process.env.AMPHI_USER_DIR ||= DEV_USER_DIR
  process.env.APP_DEEPLINK_SCHEME = process.env.AMPHI_DEEPLINK_SCHEME_DEV || 'amphi-dev'
  console.log(`🏷️  channel: development · data: ${process.env.AMPHI_USER_DIR}`)
  console.log(`   deep link: ${process.env.APP_DEEPLINK_SCHEME}://`)
}

function loadEnvFile(): void {
  const envPath = join(ROOT_DIR, '.env')
  if (!existsSync(envPath)) return
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
  console.log('📄 loaded .env')
}

function getDefines(): Record<string, string> {
  const d: Record<string, string> = {}
  for (const k of BUILD_TIME_ENV_VARS) d[`process.env.${k}`] = JSON.stringify(process.env[k] ?? '')
  return d
}

/** Capture a command's stdout, or '' if it fails. Never throws. */
async function captureOutput(cmd: string[]): Promise<string> {
  try {
    const p = spawn({ cmd, stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out
  } catch {
    return ''
  }
}

/**
 * PIDs *listening* on `port`. Empty when the port is free.
 *
 * LISTEN-only is the whole point: a bare `lsof -ti:<port>` also returns every
 * client with an open connection to it. A browser tab or an editor that ever
 * previewed the dev server would be reported as holding the port — blocking
 * startup (or, with the previous unconditional kill, getting shot). Verified
 * on macOS: Cursor's network-service process shows up that way.
 */
async function findPidsOnPort(port: number): Promise<string[]> {
  const pids = new Set<string>()
  if (process.platform === 'win32') {
    const out = await captureOutput(['cmd', '/c', `netstat -ano | findstr :${port}`])
    for (const line of out.split('\n')) {
      // TCP  <local>  <remote>  LISTENING  <pid>
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const [, local, , state] = parts
      const pid = parts[parts.length - 1]
      if (state !== 'LISTENING') continue
      if (!local?.endsWith(`:${port}`)) continue
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
    }
  } else {
    const out = await captureOutput(['sh', '-c', `lsof -ti:${port} -sTCP:LISTEN || true`])
    for (const line of out.split('\n')) {
      const pid = line.trim()
      if (/^\d+$/.test(pid)) pids.add(pid)
    }
  }
  return [...pids]
}

/** A process's full command line, or '' when it can't be read. */
async function readCommandLine(pid: string): Promise<string> {
  if (process.platform === 'win32') {
    // wmic is deprecated on current Windows builds — use CIM.
    const out = await captureOutput([
      'powershell', '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ])
    return out.trim()
  }
  return (await captureOutput(['ps', '-p', pid, '-o', 'command='])).trim()
}

/**
 * Free the Vite port, but ONLY from a stale dev session of THIS repo.
 *
 * Ownership is decided by whether the holder's command line mentions our repo
 * root — our Vite is always spawned with `--config <ROOT_DIR>/apps/electron/
 * vite.config.ts`, so a real sibling process never matches by accident.
 *
 * Throws (rather than killing) for anything else, INCLUDING processes whose
 * command line can't be read. Killing blind is how a sibling Electron+Vite
 * project silently murders this one's dev server — we have been on the
 * receiving end of exactly that. When in doubt the user gets a PID and two
 * ways out, not a dead process.
 */
async function reclaimVitePort(port: number): Promise<void> {
  const pids = await findPidsOnPort(port)
  if (pids.length === 0) return

  const foreign: string[] = []
  for (const pid of pids) {
    const cmdline = await readCommandLine(pid)
    const isOurs = cmdline.toLowerCase().includes(ROOT_DIR.toLowerCase())
    if (isOurs) {
      console.log(`♻️  reclaiming port ${port} from our own stale dev session (pid ${pid})`)
      const killCmd = process.platform === 'win32'
        ? ['taskkill', '/PID', pid, '/T', '/F']
        : ['kill', '-9', pid]
      await captureOutput(killCmd)
    } else {
      foreign.push(`  pid ${pid}: ${cmdline || '(command line unavailable)'}`)
    }
  }

  if (foreign.length > 0) {
    throw new Error(
      `port ${port} is held by a process that is not ours:\n${foreign.join('\n')}\n\n` +
        `Either stop it, or run this dev server on another port:\n` +
        `  APP_VITE_PORT=${port + 1} bun run dev`,
    )
  }
}

/** esbuild options for a bundle — shared by the initial build and the watcher. */
function buildOptionsFor(entry: string, outfile: string, defines: Record<string, string>): esbuild.BuildOptions {
  return {
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron', 'electron-updater', 'electron-log'],
    define: defines,
    sourcemap: true,
    logLevel: 'warning',
  }
}

/** Guard against handing Electron an empty or missing bundle. */
function verifyBundle(outfile: string): void {
  if (!existsSync(outfile) || statSync(outfile).size === 0) {
    throw new Error(`build did not produce ${outfile}`)
  }
}

/**
 * Block until Vite actually serves, or reject.
 *
 * Races the poll against `vite.exited` so a Vite that dies on startup (bad
 * config, strictPort conflict) fails in a second instead of burning the whole
 * timeout — and, critically, before Electron is spawned against a dead server.
 */
async function waitForViteReady(port: number, vite: Subprocess, timeoutMs = 30_000): Promise<void> {
  // MUST be the same origin we hand Electron. Vite binds `localhost`, which on
  // macOS resolves to ::1 only — probing 127.0.0.1 times out against a server
  // that came up in 195ms, because nothing is listening on IPv4.
  const url = `http://localhost:${port}/`
  const deadline = Date.now() + timeoutMs
  let died = false
  void vite.exited.then(() => { died = true })

  while (Date.now() < deadline) {
    if (died) throw new Error('vite exited before it started serving (see its output above)')
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok || res.status === 404) return
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(150)
  }
  throw new Error(`vite did not start serving ${url} within ${timeoutMs / 1000}s`)
}

async function main(): Promise<void> {
  console.log('🚀 starting electron dev environment\n')

  loadEnvFile()
  ensureRuntimeResources()

  if (existsSync(join(ELECTRON_DIR, 'node_modules/.vite'))) {
    rmSync(join(ELECTRON_DIR, 'node_modules/.vite'), { recursive: true, force: true })
  }
  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true })

  applyDevChannelEnv()

  const vitePort = Number(process.env.APP_VITE_PORT) || 5173
  await reclaimVitePort(vitePort)

  const defines = getDefines()
  const mainEntry = join(ELECTRON_DIR, 'src/main/index.ts')
  const mainOut = join(DIST_DIR, 'main.cjs')
  const preloadEntry = join(ELECTRON_DIR, 'src/preload/bootstrap.ts')
  const preloadOut = join(DIST_DIR, 'bootstrap-preload.cjs')

  const procs: Subprocess[] = []
  const contexts: esbuild.BuildContext[] = []
  let electronProcess: Subprocess | null = null

  // Idempotent: SIGINT twice, or Electron exiting while a signal is in flight,
  // must not run the teardown concurrently with itself.
  let cleanupPromise: Promise<void> | null = null
  const cleanupOnce = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      console.log('\n🛑 shutting down')
      if (electronProcess) {
        try { electronProcess.kill('SIGTERM') } catch { /* dead */ }
        await Promise.race([electronProcess.exited, Bun.sleep(5_000)])
      }
      for (const ctx of contexts) {
        try { await ctx.dispose() } catch { /* already disposed */ }
      }
      for (const p of procs) {
        try { p.kill() } catch { /* dead */ }
      }
    })()
    return cleanupPromise
  }
  const shutdown = async (code: number): Promise<never> => {
    await cleanupOnce()
    process.exit(code)
  }
  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  try {
    // ONE context per bundle. `rebuild()` is awaited to completion before
    // `watch()` registers, so nothing else is writing these files while
    // Electron boots — see the ordering invariant in the file header.
    console.log('🔨 building main + preload...')
    const mainCtx = await esbuild.context(buildOptionsFor(mainEntry, mainOut, defines))
    contexts.push(mainCtx)
    const preloadCtx = await esbuild.context({
      ...buildOptionsFor(preloadEntry, preloadOut, {}),
      external: ['electron'],
    })
    contexts.push(preloadCtx)

    await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()])
    verifyBundle(mainOut)
    verifyBundle(preloadOut)
    console.log('✔ main/preload bundle verified')

    await Promise.all([mainCtx.watch(), preloadCtx.watch()])
    console.log('👀 watching main + preload (restart to apply their changes)\n')

    console.log('📡 starting vite...')
    const vite = spawn({
      cmd: [VITE_BIN, 'dev', '--config', join(ELECTRON_DIR, 'vite.config.ts'), '--port', String(vitePort), '--strictPort'],
      cwd: ROOT_DIR,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env as Record<string, string>,
    })
    procs.push(vite)
    await waitForViteReady(vitePort, vite)
    console.log(`✔ vite listening at http://localhost:${vitePort}\n`)

    const electron = spawn({
      cmd: [ELECTRON_BIN, ELECTRON_DIR],
      cwd: ROOT_DIR,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...(process.env as Record<string, string>),
        // From `feat: centralize app runtimes` on main (a19e3e3): in dev mode,
        // point the main process at the packaged resources directory. At merge time
        // this line landed inside the spawn block this PR rewrote, so it is one of
        // the parts that had to be carried over by hand.
        AMPHI_BUNDLED_RESOURCES_DIR: RESOURCES_DIR,
        VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
      },
    })
    electronProcess = electron
    procs.push(electron)
    console.log(`🚀 electron started (pid ${electron.pid})`)
    console.log('   closing the window may only hide it to the tray — Ctrl+C here ends the dev session\n')

    // Whichever dies first ends the session. Without racing Vite, a crashed
    // dev server would leave Electron up against a dead renderer origin.
    await Promise.race([electron.exited, vite.exited])
  } finally {
    await cleanupOnce()
  }
}

main().catch((err) => {
  console.error('❌', err)
  process.exit(1)
})
