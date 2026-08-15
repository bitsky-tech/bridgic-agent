/**
 * Copy apps/electron/resources/ to apps/electron/dist/resources/.
 *
 * electron-builder picks up resources/ directly when packaging, but the dev
 * build expects them next to main.cjs so we mirror them into dist/ here.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')
const SRC_DIR = join(ELECTRON_DIR, 'resources')
const DEST_DIR = join(ELECTRON_DIR, 'dist/resources')

export async function buildResources(): Promise<void> {
  if (!existsSync(SRC_DIR)) {
    console.warn(`! resources/ not found at ${SRC_DIR}, skipping copy`)
    return
  }
  if (existsSync(DEST_DIR)) rmSync(DEST_DIR, { recursive: true, force: true })
  mkdirSync(DEST_DIR, { recursive: true })
  cpSync(SRC_DIR, DEST_DIR, { recursive: true })
  console.log('✔ resources copied to dist/')
}

if (import.meta.main) {
  buildResources().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
