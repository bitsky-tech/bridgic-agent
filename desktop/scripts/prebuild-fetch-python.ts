/**
 * Install a pinned, relocatable uv-managed Python for the package target.
 *
 * The resulting runtime is shipped next to the bundled uv binary and seeds the
 * single writable app-level Python base used by every Session, Build, Run, and
 * Child Agent.
 * No command depends on a system Python or a first-run interpreter download.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { PYTHON_TARGETS, PYTHON_VERSION } from './runtime-resource-spec'

const HERE = path.resolve(import.meta.dir ?? __dirname)
const REPO_ROOT = path.resolve(HERE, '..')
const RESOURCES_DIR = path.join(REPO_ROOT, 'apps', 'electron', 'resources')
const TARGET_DIR = path.join(RESOURCES_DIR, 'python_runtime')
const UV_BIN = path.join(
  RESOURCES_DIR,
  'uv_runtime',
  'bin',
  process.platform === 'win32' ? 'uv.exe' : 'uv',
)

interface RuntimeManifest {
  version: 1
  pythonVersion: string
  target: string
  executable: string
}

function findPythonExecutable(root: string): string | null {
  const names = process.platform === 'win32'
    ? new Set(['python.exe'])
    : new Set(['python3', `python${PYTHON_VERSION.split('.').slice(0, 2).join('.')}`])

  const visit = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = visit(full)
        if (found) return found
      } else if ((entry.isFile() || entry.isSymbolicLink()) && names.has(entry.name)) {
        return full
      }
    }
    return null
  }
  return visit(root)
}

function main(): void {
  const platform = process.platform
  const arch = process.argv[2] || process.env.AMPHI_PYTHON_ARCH || process.arch
  const target = PYTHON_TARGETS[`${platform}-${arch}`]
  if (!target) {
    throw new Error(`no Python runtime mapped for ${platform}-${arch}`)
  }
  if (!existsSync(UV_BIN) || !statSync(UV_BIN).isFile()) {
    throw new Error(
      `bundled uv not found at ${UV_BIN}; run prebuild-fetch-uv before this script`,
    )
  }

  rmSync(TARGET_DIR, { recursive: true, force: true })
  mkdirSync(TARGET_DIR, { recursive: true })
  execFileSync(
    UV_BIN,
    [
      'python',
      'install',
      target,
      '--install-dir',
      TARGET_DIR,
      '--no-bin',
      '--no-cache',
    ],
    { stdio: 'inherit' },
  )

  const executable = findPythonExecutable(TARGET_DIR)
  if (!executable) {
    throw new Error(`Python executable not found after installing ${target}`)
  }
  const manifest: RuntimeManifest = {
    version: 1,
    pythonVersion: PYTHON_VERSION,
    target,
    executable: path.relative(TARGET_DIR, executable).split(path.sep).join('/'),
  }
  writeFileSync(
    path.join(TARGET_DIR, 'runtime.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  console.log(`[prebuild-fetch-python] bundled ${target} -> ${TARGET_DIR}`)
}

try {
  main()
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[prebuild-fetch-python] failed: ${message}`)
  process.exitCode = 1
}
