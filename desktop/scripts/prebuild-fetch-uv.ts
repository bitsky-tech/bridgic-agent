/**
 * Download the pinned `uv` binary for the build target and drop it into
 * apps/electron/resources/uv_runtime/bin/ so electron-builder's
 * `extraResources` ships it as a standalone runtime next to the app. At
 * runtime the daemon prepends that dir to PATH (see
 * ../../src/amphi_agent/runtime/_python_env.py), so the agent's `uv` calls
 * hit this copy.
 *
 * Runs from the `dist:*` scripts BEFORE electron-builder, right after
 * prebuild-fetch-amphi. Failure is fatal: the shared app-level Python base and
 * all package installation commands depend on this uv in packaged builds, so
 * producing an app without it is worse than stopping the release build.
 *
 * Target selection:
 *   - platform = the build host's OS (electron-builder never cross-builds OS)
 *   - arch     = first positional arg, then `$AMPHI_UV_ARCH`, else host arch
 * Source priority:
 *   1. `$AMPHI_UV_BIN` — a local uv binary (offline / CI mirrors)
 *   2. a per-target cache under the OS temp dir (avoids re-downloading)
 *   3. download from the astral-sh/uv GitHub release for `UV_VERSION`
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UV_VERSION } from './runtime-resource-spec'

const HERE = path.resolve(import.meta.dir ?? __dirname)
const REPO_ROOT = path.resolve(HERE, '..')
const TARGET_DIR = path.join(
  REPO_ROOT,
  'apps',
  'electron',
  'resources',
  'uv_runtime',
  'bin',
)
const RUNTIME_DIR = path.dirname(TARGET_DIR)

interface UvRuntimeManifest {
  version: 1
  uvVersion: string
  target: string
  executable: string
}

/** uv release asset name keyed by `${platform}-${arch}`. */
const ASSETS: Record<string, string> = {
  'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  'win32-x64': 'uv-x86_64-pc-windows-msvc.zip',
}

/** Recursively find a file named `name` under `dir`; null if absent. */
function findBinary(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findBinary(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return null
}

/** Extract the `uv` binary from a downloaded archive into `cacheBin`. */
function extract(archive: string, binName: string, cacheBin: string): void {
  const workDir = path.join(path.dirname(cacheBin), 'unpack')
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  // bsdtar (macOS/Windows) and GNU tar (Linux) all extract .tar.gz; bsdtar
  // also handles the Windows .zip — `tar -xf` auto-detects either.
  execFileSync('tar', ['-xf', archive, '-C', workDir], { stdio: 'inherit' })
  const found = findBinary(workDir, binName)
  if (!found) {
    throw new Error(`'${binName}' not found inside ${path.basename(archive)}`)
  }
  cpSync(found, cacheBin, { mode: 0o755 })
  rmSync(workDir, { recursive: true, force: true })
}

/** Resolve the uv binary for the target into the per-target cache, return its path. */
async function resolveCachedUv(binName: string, asset: string): Promise<string> {
  const cacheDir = path.join(
    os.tmpdir(),
    'amphi-uv-cache',
    `${UV_VERSION}-${asset}`,
  )
  const cacheBin = path.join(cacheDir, binName)
  if (existsSync(cacheBin)) return cacheBin
  mkdirSync(cacheDir, { recursive: true })

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
  console.log(`[prebuild-fetch-uv] downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`)
  }
  const archive = path.join(cacheDir, asset)
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
  extract(archive, binName, cacheBin)
  rmSync(archive, { force: true })
  return cacheBin
}

async function main(): Promise<void> {
  try {
    const platform = process.platform
    const arch = process.argv[2] || process.env.AMPHI_UV_ARCH || process.arch
    const binName = platform === 'win32' ? 'uv.exe' : 'uv'
    const dest = path.join(TARGET_DIR, binName)
    mkdirSync(TARGET_DIR, { recursive: true })

    // 1. Explicit local override — offline builds / CI mirrors.
    const override = process.env.AMPHI_UV_BIN
    let source: string
    if (override) {
      if (!existsSync(override)) {
        throw new Error(`AMPHI_UV_BIN points at a missing file: ${override}`)
      }
      source = override
    } else {
      // 2/3. Cached or freshly downloaded release binary.
      const asset = ASSETS[`${platform}-${arch}`]
      if (!asset) {
        throw new Error(`no uv release mapped for ${platform}-${arch}`)
      }
      source = await resolveCachedUv(binName, asset)
    }

    cpSync(source, dest, { mode: 0o755 })
    const manifest: UvRuntimeManifest = {
      version: 1,
      uvVersion: UV_VERSION,
      target: `${platform}-${arch}`,
      executable: path.relative(RUNTIME_DIR, dest).split(path.sep).join('/'),
    }
    writeFileSync(
      path.join(RUNTIME_DIR, 'runtime.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    console.log(`[prebuild-fetch-uv] bundled uv ${UV_VERSION} -> ${dest}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[prebuild-fetch-uv] failed: ${message}`)
    console.error('  Set AMPHI_UV_BIN to a local uv binary for offline builds.')
    process.exitCode = 1
  }
}

void main()
