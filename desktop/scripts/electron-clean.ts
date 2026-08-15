// Remove every generated artifact:
//   apps/electron/dist
//   apps/electron/release
//   any node_modules/.vite caches
//   any .tsbuildinfo files
//
// (We avoid /** ... **/ here because the `**/` glob terminates the JSDoc.)

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dir, '..')

const targets = [
  join(ROOT_DIR, 'apps/electron/dist'),
  join(ROOT_DIR, 'apps/electron/release'),
  join(ROOT_DIR, 'apps/electron/node_modules/.vite'),
  join(ROOT_DIR, 'node_modules/.vite'),
]

for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true })
    console.log(`✔ removed ${t}`)
  }
}

console.log('done')
