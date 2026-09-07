/**
 * Bundle the preload script into apps/electron/dist/bootstrap-preload.cjs.
 */

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')
const DIST_DIR = join(ELECTRON_DIR, 'dist')
const OUTPUT = join(DIST_DIR, 'bootstrap-preload.cjs')
const ENTRY = join(ELECTRON_DIR, 'src/preload/bootstrap.ts')
const EXCEL_OUTPUT = join(DIST_DIR, 'excel-host-preload.cjs')
const EXCEL_ENTRY = join(ELECTRON_DIR, 'src/preload/excel-host.ts')

export async function buildPreload(): Promise<void> {
  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true })

  await Promise.all([
    esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: OUTPUT,
      external: ['electron'],
      sourcemap: true,
      logLevel: 'info',
    }),
    esbuild.build({
      entryPoints: [EXCEL_ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: EXCEL_OUTPUT,
      external: ['electron'],
      sourcemap: true,
      logLevel: 'info',
    }),
  ])

  if (!existsSync(OUTPUT) || statSync(OUTPUT).size === 0) {
    throw new Error(`preload build did not produce output at ${OUTPUT}`)
  }
  if (!existsSync(EXCEL_OUTPUT) || statSync(EXCEL_OUTPUT).size === 0) {
    throw new Error(`preload build did not produce output at ${EXCEL_OUTPUT}`)
  }
  console.log(
    `✔ preloads: bootstrap ${(statSync(OUTPUT).size / 1024).toFixed(1)} KB · `
    + `Excel host ${(statSync(EXCEL_OUTPUT).size / 1024).toFixed(1)} KB`,
  )
}

if (import.meta.main) {
  buildPreload().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
