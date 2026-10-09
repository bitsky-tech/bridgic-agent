/**
 * Build the renderer with Vite. Output → apps/electron/dist/renderer/.
 */

import { spawn } from 'bun'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')

// Vite holds the whole renderer module graph (7k+ modules since the Office
// editors landed) in memory while transforming. Node caps the old-space heap at
// ~2 GiB by default on hosts with less than 16 GB of RAM — the GitHub macOS
// runners — and the build dies there; it needs ~3.5 GB. Only the build
// subprocess is affected, never the installed app.
const RENDERER_BUILD_HEAP_MB = 4096
const HEAP_FLAG = /--max[-_]old[-_]space[-_]size/

/** Environment for the Vite subprocess; an explicit caller heap limit wins. */
export function rendererBuildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const options = env.NODE_OPTIONS ?? ''
  if (HEAP_FLAG.test(options)) return { ...env }
  return { ...env, NODE_OPTIONS: `${options} --max-old-space-size=${RENDERER_BUILD_HEAP_MB}`.trim() }
}

export async function buildRenderer(): Promise<void> {
  const viteBin = join(ROOT_DIR, 'node_modules/.bin/vite' + (process.platform === 'win32' ? '.exe' : ''))
  const proc = spawn({
    cmd: [viteBin, 'build', '--config', join(ELECTRON_DIR, 'vite.config.ts')],
    cwd: ROOT_DIR,
    env: rendererBuildEnv(),
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
