/**
 * Orchestrator — build main + preload + renderer + resources for distribution.
 *
 *   bun run build
 */

import { buildMain } from './electron-build-main'
import { buildPreload } from './electron-build-preload'
import { buildRenderer } from './electron-build-renderer'
import { buildResources } from './electron-build-resources'
import { generateReleaseManifest } from './release-manifest'

async function main(): Promise<void> {
  console.log('🔨 Building Electron app...\n')

  // Before anything else: the manifest is an input to both packaging
  // (extraResources reads resources/release-manifest.json) and dev
  // (buildResources mirrors it into dist/resources/). Generating it first also
  // means a desktop/backend version drift fails the build here rather than
  // shipping an app that blocks every user at the compatibility gate.
  const manifest = generateReleaseManifest()
  console.log(
    `✔ release manifest: desktop ${manifest.desktopVersion} requires backend ${manifest.requiredBackendVersion}`,
  )

  // main + preload are independent, build them in parallel
  await Promise.all([buildMain(), buildPreload()])
  // renderer depends on assets resolved by Vite, run after main/preload
  await buildRenderer()
  // copy static assets last (idempotent)
  await buildResources()

  console.log('\n✅ Build complete')
}

main().catch((err) => {
  console.error('\n❌', err)
  process.exit(1)
})
