/**
 * Bundle the Electron main process into apps/electron/dist/main.cjs.
 *
 *   bun run scripts/electron-build-main.ts
 *
 * Pulls .env into esbuild --define so build-time secrets and feature flags
 * are inlined exactly the same way in dev and CI builds.
 */

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')
const DIST_DIR = join(ELECTRON_DIR, 'dist')
const OUTPUT = join(DIST_DIR, 'main.cjs')
const ENTRY = join(ELECTRON_DIR, 'src/main/index.ts')

// Inline values from .env that the main process reads at startup.
const BUILD_TIME_ENV_VARS = [
  'APP_NAME',
  'APP_DEEPLINK_SCHEME',
  'APP_UPDATE_URL',
  'APP_DEBUG',
  'POSTHOG_PROJECT_TOKEN',
]

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
}

function getDefines(): Record<string, string> {
  const defines: Record<string, string> = {}
  for (const key of BUILD_TIME_ENV_VARS) {
    defines[`process.env.${key}`] = JSON.stringify(process.env[key] ?? '')
  }
  return defines
}

export async function buildMain(): Promise<void> {
  loadEnvFile()
  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true })

  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUTPUT,
    external: ['electron', 'electron-updater', 'electron-log'],
    define: getDefines(),
    sourcemap: true,
    logLevel: 'info',
  })

  if (!existsSync(OUTPUT) || statSync(OUTPUT).size === 0) {
    throw new Error(`main.cjs build did not produce output at ${OUTPUT}`)
  }
  console.log(`✔ main.cjs (${(statSync(OUTPUT).size / 1024).toFixed(1)} KB)`)
}

if (import.meta.main) {
  buildMain().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
