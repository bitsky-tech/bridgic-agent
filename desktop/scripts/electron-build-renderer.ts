/**
 * Build the renderer with Vite. Output → apps/electron/dist/renderer/.
 */

import { spawn } from 'bun'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')

export async function buildRenderer(): Promise<void> {
  const viteBin = join(ROOT_DIR, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.exe' : ''))
  const proc = spawn({
    cmd: [viteBin, 'build', '--config', join(ELECTRON_DIR, 'vite.config.ts')],
    cwd: ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`vite build exited with ${code}`)
  console.log('✔ renderer built')
}

if (import.meta.main) {
  buildRenderer().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
