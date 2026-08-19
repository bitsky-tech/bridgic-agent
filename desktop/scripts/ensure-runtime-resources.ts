/** Ensure source-mode Electron has the pinned uv, Python, and Node runtimes. */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  NODE_VERSION,
  PYTHON_TARGETS,
  PYTHON_VERSION,
  UV_VERSION,
} from './runtime-resource-spec'

type RuntimeManifest = Record<string, unknown>

export class RuntimeResourcesPreflight {
  private readonly scriptsDir: string
  readonly resourcesDir: string

  constructor(resourcesDir?: string) {
    this.scriptsDir = path.resolve(import.meta.dir ?? __dirname)
    this.resourcesDir = resourcesDir ?? path.join(
      path.resolve(this.scriptsDir, '..'),
      'apps',
      'electron',
      'resources',
    )
  }

  /** Prepare only the missing or stale host runtimes used by Electron dev. */
  ensure(): void {
    const target = `${process.platform}-${process.arch}`
    const pythonTarget = PYTHON_TARGETS[target]
    if (!pythonTarget) {
      throw new Error(`no Python runtime mapped for ${target}`)
    }

    this.ensureResource('uv', () => this.validUv(target), 'prebuild-fetch-uv.ts')
    this.ensureResource(
      'Python',
      () => this.validPython(pythonTarget),
      'prebuild-fetch-python.ts',
    )
    this.ensureResource('Node', () => this.validNode(target), 'prebuild-fetch-node.ts')
  }

  private ensureResource(name: string, valid: () => boolean, fetchScript: string): void {
    if (valid()) {
      console.log(`[ensure-runtime-resources] ${name} runtime ready`)
      return
    }

    console.log(`[ensure-runtime-resources] preparing ${name} runtime`)
    execFileSync(process.execPath, [path.join(this.scriptsDir, fetchScript)], {
      env: process.env,
      stdio: 'inherit',
    })
    if (!valid()) {
      throw new Error(`${name} runtime is invalid after ${fetchScript}`)
    }
  }

  private validUv(target: string): boolean {
    const root = path.join(this.resourcesDir, 'uv_runtime')
    const manifest = this.readManifest(root)
    const executable = this.manifestExecutable(root, manifest)
    return manifest?.version === 1
      && manifest.uvVersion === UV_VERSION
      && manifest.target === target
      && executable !== null
      && this.commandOutput(executable, ['--version'])?.split(/\s+/, 3)[1] === UV_VERSION
  }

  private validPython(target: string): boolean {
    const root = path.join(this.resourcesDir, 'python_runtime')
    const manifest = this.readManifest(root)
    const executable = this.manifestExecutable(root, manifest)
    return manifest?.version === 1
      && manifest.pythonVersion === PYTHON_VERSION
      && manifest.target === target
      && executable !== null
      // `-B` is load-bearing, not tidiness. Without it these two probes leave 67
      // .pyc files behind in `python_runtime` -- a directory that is packaging
      // INPUT. The Windows job runs `dev:resources` before `dist:win`, so those
      // files shipped in the release; whether they exist at all depends on
      // whether the runtime happened to be stale that run, which makes the
      // artifact's bytes non-deterministic and erodes differential-update block
      // matching. Same root cause as the `-B` in `_python_env.py`, build side.
      && this.commandOutput(executable, [
        '-B',
        '-c',
        'import platform; print(platform.python_version())',
      ]) === PYTHON_VERSION
      && this.commandOutput(executable, ['-B', '-m', 'ensurepip', '--version'])?.startsWith('pip ')
        === true
  }

  private validNode(target: string): boolean {
    const root = path.join(this.resourcesDir, 'node_runtime')
    const manifest = this.readManifest(root)
    const executable = this.manifestExecutable(root, manifest)
    return manifest?.version === 1
      && manifest.nodeVersion === NODE_VERSION
      && manifest.target === target
      && executable !== null
      && this.commandOutput(executable, ['--version']) === NODE_VERSION
      && this.hasNodeCli(root, 'npm-cli.js')
      && this.hasNodeCli(root, 'npx-cli.js')
  }

  private readManifest(root: string): RuntimeManifest | null {
    try {
      const value: unknown = JSON.parse(
        readFileSync(path.join(root, 'runtime.json'), 'utf-8'),
      )
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RuntimeManifest
        : null
    } catch {
      return null
    }
  }

  private manifestExecutable(root: string, manifest: RuntimeManifest | null): string | null {
    const relative = manifest?.executable
    if (typeof relative !== 'string' || relative.length === 0) return null
    const executable = path.resolve(root, relative)
    const fromRoot = path.relative(root, executable)
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      return null
    }
    return this.isFile(executable) ? executable : null
  }

  private hasNodeCli(root: string, name: string): boolean {
    return [
      path.join(root, 'lib', 'node_modules', 'npm', 'bin', name),
      path.join(root, 'node_modules', 'npm', 'bin', name),
    ].some((candidate) => this.isFile(candidate))
  }

  private commandOutput(executable: string, arguments_: string[]): string | null {
    try {
      return execFileSync(executable, arguments_, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim()
    } catch {
      return null
    }
  }

  private isFile(candidate: string): boolean {
    try {
      return existsSync(candidate) && statSync(candidate).isFile()
    } catch {
      return false
    }
  }
}

export function ensureRuntimeResources(): string {
  const preflight = new RuntimeResourcesPreflight()
  preflight.ensure()
  return preflight.resourcesDir
}

if (import.meta.main) {
  try {
    const resourcesDir = ensureRuntimeResources()
    console.log(`[ensure-runtime-resources] ready at ${resourcesDir}`)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ensure-runtime-resources] failed: ${message}`)
    process.exitCode = 1
  }
}
