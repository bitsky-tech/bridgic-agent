/**
 * Build each renderer in a fresh Vite process to bound production build memory.
 */

import { spawn } from 'bun'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { rendererBuildEnvironment, RENDERER_ENTRY_FILES, type RendererEntry } from './renderer-entries'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')

export async function buildRenderer(): Promise<void> {
  const viteBin = join(ROOT_DIR, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.exe' : ''))
  // Clean once; targeted builds preserve the HTML and assets of earlier entries.
  await rm(join(ELECTRON_DIR, 'dist/renderer'), { recursive: true, force: true })
  for (const entry of Object.keys(RENDERER_ENTRY_FILES) as RendererEntry[]) {
    console.log(`Building renderer: ${entry}`)
    const proc = spawn({
      cmd: [viteBin, 'build', '--config', join(ELECTRON_DIR, 'vite.config.ts')],
      cwd: ROOT_DIR,
      env: rendererBuildEnvironment(entry, process.env),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`vite build (${entry}) exited with ${code}`)
  }
  console.log('✔ renderer built')
}

if (import.meta.main) {
  buildRenderer().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
