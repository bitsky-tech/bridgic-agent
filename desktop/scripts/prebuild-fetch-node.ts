/**
 * Download the pinned Node.js runtime for the build target and drop it into
 * apps/electron/resources/node_runtime/ so electron-builder's `extraResources`
 * ships it as a standalone runtime next to the app.
 *
 * Two runtime consumers depend on this copy
 * (see ../../src/amphi_agent/runtime/_node_env.py):
 *   - Playwright — driven via an absolute `PLAYWRIGHT_NODEJS_PATH`, so the driver
 *     always runs on a known Node version regardless of PATH.
 *   - Skills — `bin/` is PREPENDED to PATH, so this bundle beats whatever
 *     `node` the host has. That keeps macOS (launchd, no user PATH) and Windows
 *     (Run key → detached, inherits the user's PATH) on the same Node version; see
 *     `BundledNodeRuntime.apply_path` for the trade-off it accepts.
 *
 * Runs from the `dist:*` scripts BEFORE electron-builder, right after
 * prebuild-fetch-uv. Failure is fatal: the packaged `docx` / `pptx` /
 * `remotion` / `hyperframes` Skills shell out to npm/npx, and the daemon's
 * launchd PATH contains no user Node, so an app without this bundle silently
 * loses those Skills.
 *
 * Target selection:
 *   - platform = the build host's OS (electron-builder never cross-builds OS)
 *   - arch     = first positional arg, then `$AMPHI_NODE_ARCH`, else host arch
 * Source priority:
 *   1. `$AMPHI_NODE_DIR` — an already-extracted Node dir (offline / CI mirrors)
 *   2. a per-target cache under the OS temp dir (avoids re-downloading)
 *   3. the fastest of several CDNs, probed at run time (see pickFastestBase)
 *
 * Non-obvious: this is a BUILD-TIME script. End users never download Node — it
 * ships inside the app — so the mirror probing here optimises release builds,
 * not user experience.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NODE_VERSION } from './runtime-resource-spec'

const HERE = path.resolve(import.meta.dir ?? __dirname)
const REPO_ROOT = path.resolve(HERE, '..')
const TARGET_DIR = path.join(
  REPO_ROOT,
  'apps',
  'electron',
  'resources',
  'node_runtime',
)

/** Release archive name keyed by `${platform}-${arch}`. */
const ASSETS: Record<string, string> = {
  'darwin-arm64': `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
  'darwin-x64': `node-${NODE_VERSION}-darwin-x64.tar.gz`,
  'linux-arm64': `node-${NODE_VERSION}-linux-arm64.tar.gz`,
  'linux-x64': `node-${NODE_VERSION}-linux-x64.tar.gz`,
  'win32-x64': `node-${NODE_VERSION}-win-x64.zip`,
}

/**
 * Download bases probed for throughput, official first.
 *
 * This source set is deliberately Node-specific. Mirror choice has to be
 * measured per artifact rather than copied from an unrelated large download;
 * a fast host for one artifact can be slower or stale for another.
 */
const SOURCE_BASES: readonly string[] = [
  'https://nodejs.org/dist',
  'https://mirrors.huaweicloud.com/nodejs',
  'https://mirrors.tencent.com/nodejs-release',
  'https://mirrors.ustc.edu.cn/node',
]

/** Range-request size per probe: large enough to measure throughput rather
 *  than latency, small enough that probing every base stays ~1 second. */
const PROBE_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 8000

/** A mirror must beat upstream by this factor to be chosen — switching hosts
 *  is not free (mirrors may lag or throttle), so a coin-flip margin isn't
 *  worth it. Mirrors that lag behind this release simply 404 and lose. */
const MIN_SPEEDUP = 1.2

/**
 * Paths inside the extracted Node dir that the app never reads.
 *
 * `include/` is pruned despite being node-gyp's header source: 61 of its 62 MB
 * is OpenSSL headers, and it carries 2725 files on its own. node-gyp defaults
 * to DOWNLOADING headers from nodejs.org rather than reading a local `include/`
 * (only an explicit `--nodedir` uses it), and every bundled Skill's native dep
 * (sharp et al.) ships prebuilt binaries instead of compiling. Meanwhile
 * electron-builder.yml documents that this repo's notarization stall was
 * "driven by file count" — so shipping 2725 unread headers costs real release
 * time for no runtime benefit.
 */
const PRUNABLE = [
  'CHANGELOG.md',
  'include',
  path.join('share', 'doc'),
  path.join('share', 'man'),
  // npm's bundled docs live under a DIFFERENT root per platform: POSIX nests
  // them in lib/node_modules, Windows keeps node_modules at the archive root
  // (verified against node-v22.23.1-win-x64.zip — 2.6 MB there). Listing both
  // is why pruning is `force: true`: the absent one is simply a no-op.
  path.join('lib', 'node_modules', 'npm', 'docs'),
  path.join('lib', 'node_modules', 'npm', 'man'),
  path.join('node_modules', 'npm', 'docs'),
  path.join('node_modules', 'npm', 'man'),
]

/** Shape of `node_runtime/runtime.json`, read by BundledNodeRuntime. */
interface NodeRuntimeManifest {
  version: 1
  nodeVersion: string
  target: string
  executable: string
}

function buildUrl(base: string, asset: string): string {
  return `${base}/${NODE_VERSION}/${asset}`
}

/** Measure a base's throughput in bytes/sec, or null when unusable. */
async function probeBase(base: string, asset: string): Promise<number | null> {
  const started = performance.now()
  try {
    const res = await fetch(buildUrl(base, asset), {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const payload = await res.arrayBuffer()
    const elapsed = (performance.now() - started) / 1000
    // A mirror that answers a Range request with the whole file (or a stub)
    // tells us nothing about sustained throughput — require exactly the slice
    // we asked for. Anything else is a base we cannot measure, so it loses.
    if (elapsed <= 0 || payload.byteLength !== PROBE_BYTES) return null
    return payload.byteLength / elapsed
  } catch {
    return null
  }
}

/**
 * Pick the fastest reachable base for `asset`, falling back to official.
 *
 * Never throws: mirror selection is an optimisation, never a dependency.
 */
async function pickFastestBase(asset: string): Promise<string> {
  const official = SOURCE_BASES[0]!
  const override = process.env.AMPHI_NODE_MIRROR
  if (override) {
    console.log(`[prebuild-fetch-node] using $AMPHI_NODE_MIRROR ${override}`)
    return override.replace(/\/+$/, '')
  }

  const speeds = await Promise.all(
    SOURCE_BASES.map((base) => probeBase(base, asset)),
  )
  const reachable = SOURCE_BASES.map((base, i) => ({ base, speed: speeds[i] }))
    .filter((entry): entry is { base: string; speed: number } => entry.speed !== null)

  for (const { base, speed } of reachable) {
    console.log(`[prebuild-fetch-node]   probe ${(speed / 1e6).toFixed(2)} MB/s  ${base}`)
  }

  if (reachable.length === 0) {
    console.warn('[prebuild-fetch-node] no source reachable, trying official anyway')
    return official
  }

  const best = reachable.reduce((a, b) => (b.speed > a.speed ? b : a))
  const officialSpeed = reachable.find((e) => e.base === official)?.speed
  if (officialSpeed !== undefined && best.speed < officialSpeed * MIN_SPEEDUP) {
    console.log('[prebuild-fetch-node] official CDN fast enough, keeping it')
    return official
  }
  return best.base
}

/** The single top-level directory a Node archive extracts into. */
function findExtractedRoot(workDir: string): string {
  const entries = readdirSync(workDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(workDir, e.name))
  if (entries.length !== 1) {
    throw new Error(
      `expected exactly 1 top-level dir in the archive, found ${entries.length}`,
    )
  }
  return entries[0]!
}

/** Drop documentation trees the app never reads (~5 MB). */
function pruneRuntime(root: string): void {
  for (const relative of PRUNABLE) {
    rmSync(path.join(root, relative), { recursive: true, force: true })
  }
}

/** Resolve the extracted Node dir for the target into a per-target cache. */
async function resolveCachedRuntime(asset: string): Promise<string> {
  const cacheDir = path.join(os.tmpdir(), 'amphi-node-cache', `${NODE_VERSION}-${asset}`)
  const cacheRoot = path.join(cacheDir, 'runtime')
  if (existsSync(cacheRoot)) return cacheRoot
  mkdirSync(cacheDir, { recursive: true })

  const base = await pickFastestBase(asset)
  const url = buildUrl(base, asset)
  console.log(`[prebuild-fetch-node] downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`)
  }
  const archive = path.join(cacheDir, asset)
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))

  const workDir = path.join(cacheDir, 'unpack')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  // bsdtar ships on both macOS and Windows 10+ and auto-detects .tar.gz / .zip,
  // so one invocation covers every target (same trick as prebuild-fetch-uv.ts).
  execFileSync('tar', ['-xf', archive, '-C', workDir], { stdio: 'inherit' })

  // The cache keeps the pristine tree; pruning happens on the copy in
  // TARGET_DIR so that editing PRUNABLE takes effect without clearing caches.
  //
  // Staged then renamed: `existsSync(cacheRoot)` above is the only
  // completeness check, so a run interrupted mid-copy would otherwise leave a
  // truncated tree that every later build silently ships. `bin/node` is copied
  // before `lib/`, so the post-copy executable check cannot catch that.
  //
  // verbatimSymlinks: Node's `cpSync` resolves relative symlinks to ABSOLUTE
  // paths by default, which would turn `bin/npm -> ../lib/.../npm-cli.js` into
  // a link into this build machine's temp dir — dangling on every user's disk.
  const extracted = findExtractedRoot(workDir)
  const staging = `${cacheRoot}.partial`
  rmSync(staging, { recursive: true, force: true })
  cpSync(extracted, staging, { recursive: true, verbatimSymlinks: true })
  rmSync(workDir, { recursive: true, force: true })
  rmSync(archive, { force: true })
  renameSync(staging, cacheRoot)
  return cacheRoot
}

/** Absolute path of the `node` executable inside an extracted runtime. */
function nodeExecutable(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, 'node.exe')
    : path.join(root, 'bin', 'node')
}

/**
 * Absolute path of npm's REAL entry point — the file `npm` / `npm.cmd` delegates
 * to. Windows keeps `node_modules/` at the archive root; POSIX nests it under
 * `lib/` (the same split `PRUNABLE` already accounts for).
 */
function npmCliJs(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/** Recursive file count. Cheap enough for a ~2000-entry tree. */
function countFiles(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return total
}

/**
 * Floor for the post-prune file count. Windows ships ~2032 entries, macOS ~1768
 * after `PRUNABLE` removes docs/man/include. A truncated copy lands in the tens,
 * so this threshold separates the two without being brittle across Node releases.
 */
const MIN_RUNTIME_FILES = 1000

async function main(): Promise<void> {
  try {
    const platform = process.platform
    const arch = process.argv[2] || process.env.AMPHI_NODE_ARCH || process.arch

    // 1. Explicit local override — offline builds / CI mirrors.
    const override = process.env.AMPHI_NODE_DIR
    let source: string
    if (override) {
      if (!existsSync(override) || !statSync(override).isDirectory()) {
        throw new Error(`AMPHI_NODE_DIR is not a directory: ${override}`)
      }
      source = override
    } else {
      // 2/3. Cached, or freshly downloaded from the fastest reachable source.
      const asset = ASSETS[`${platform}-${arch}`]
      if (!asset) {
        throw new Error(`no Node release mapped for ${platform}-${arch}`)
      }
      source = await resolveCachedRuntime(asset)
    }

    // Replace wholesale: a stale runtime from another version would otherwise
    // leave orphaned files behind and ship a mixed tree.
    rmSync(TARGET_DIR, { recursive: true, force: true })
    mkdirSync(path.dirname(TARGET_DIR), { recursive: true })
    // verbatimSymlinks: keep `bin/npm` / `bin/npx` / `bin/corepack` pointing at
    // their relative `../lib/node_modules/...` targets. Without it Node rewrites
    // them to absolute paths inside `source`, which ship as dangling links.
    cpSync(source, TARGET_DIR, { recursive: true, verbatimSymlinks: true })
    pruneRuntime(TARGET_DIR)

    const exe = nodeExecutable(TARGET_DIR)
    if (!existsSync(exe)) {
      throw new Error(`node executable missing after copy: ${exe}`)
    }

    // The executable alone does NOT prove a usable runtime. `npm` and `npx` are
    // thin shims that require npm's implementation tree; a copy that drops it
    // still satisfies the check above and ships an app where every npm-based
    // Skill dies with MODULE_NOT_FOUND. That is exactly what reached Windows
    // users on 2026-07-28 — 14 files instead of ~2000, and the build printed
    // "bundled Node v22.23.1" and exited 0.
    const cli = npmCliJs(TARGET_DIR)
    const fileCount = countFiles(TARGET_DIR)
    const cliPresent = existsSync(cli)
    console.log(
      `[prebuild-fetch-node] verify: ${fileCount} files, npm entry ${cliPresent ? 'present' : 'MISSING'}`,
    )
    if (!cliPresent || fileCount < MIN_RUNTIME_FILES) {
      throw new Error(
        `node_runtime is incomplete after copy — refusing to ship it.\n` +
          `  files      : ${fileCount} (expected >= ${MIN_RUNTIME_FILES})\n` +
          `  npm entry  : ${cliPresent ? 'present' : `MISSING (${cli})`}\n` +
          `  target     : ${TARGET_DIR}\n` +
          `  source     : ${source}\n` +
          `  Windows note: deep npm paths exceed MAX_PATH (260) unless\n` +
          `  HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled = 1.`,
      )
    }

    // Mirrors prebuild-fetch-python.ts's runtime.json. The daemon reports the
    // Node version to the agent in its <Workspace> block, and reading it from a
    // manifest keeps that a single pinned source of truth — no spawning `node
    // --version` on a hot path just to build a prompt.
    const manifest: NodeRuntimeManifest = {
      version: 1,
      nodeVersion: NODE_VERSION,
      target: `${platform}-${arch}`,
      executable: path.relative(TARGET_DIR, exe).split(path.sep).join('/'),
    }
    writeFileSync(
      path.join(TARGET_DIR, 'runtime.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    console.log(`[prebuild-fetch-node] bundled Node ${NODE_VERSION} -> ${TARGET_DIR}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[prebuild-fetch-node] failed: ${message}`)
    console.error('  Set AMPHI_NODE_DIR to an extracted Node runtime for offline builds,')
    console.error('  or AMPHI_NODE_MIRROR to an internal CDN base URL.')
    process.exitCode = 1
  }
}

void main()
