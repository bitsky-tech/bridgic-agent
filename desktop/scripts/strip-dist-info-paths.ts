/**
 * Strip pip's build-machine path records out of a copied PyInstaller payload.
 *
 * PyInstaller copies each package's `.dist-info` directory verbatim. For any
 * package pip installed from a local path — here the first-party `bridgic_agent`
 * — pip writes a `direct_url.json` recording that path ABSOLUTELY:
 *
 *   {"url":"file:///Users/<developer>/…/AmphiAgent-02","dir_info":{}}
 *
 * That file is inert at runtime but ships inside every installer, disclosing the
 * build machine's account name and directory layout to every user.
 *
 * Only `direct_url.json` is removed. The rest of each `.dist-info` is
 * load-bearing: `scripts/gen-third-party-licenses.ts` reads `METADATA` and the
 * `licenses/` subdirectory to build the Python section of
 * THIRD-PARTY-LICENSES.txt, so deleting the directories wholesale would trade a
 * privacy leak for a compliance gap. The test suite pins that distinction.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * Remove every `direct_url.json` under `<binDir>/_internal/*.dist-info/`.
 *
 * @param binDir - the populated bundle directory (`resources/bin`)
 * @returns how many records were removed; `0` when there is no payload
 */
export function stripDistInfoPaths(binDir: string): number {
  const internal = path.join(binDir, '_internal')
  if (!existsSync(internal)) return 0

  let removed = 0
  for (const entry of readdirSync(internal)) {
    if (!entry.endsWith('.dist-info')) continue
    const record = path.join(internal, entry, 'direct_url.json')
    if (!existsSync(record)) continue
    rmSync(record)
    removed += 1
  }
  return removed
}
