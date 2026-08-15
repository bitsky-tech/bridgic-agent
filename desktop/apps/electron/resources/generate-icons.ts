#!/usr/bin/env bun
/**
 * Generate app icons (icon.png / icon.icns / icon.ico) from a single SVG source.
 *
 * Purpose:
 *   Single-source-of-truth pipeline: vector SVG in `resources/source/` →
 *   the three raster artifacts electron-builder expects in `resources/`.
 *   Keeps platform icons in lockstep with the brand SVG.
 *
 * Key invariants:
 *   - Output filenames are FIXED (`icon.png` / `icon.icns` / `icon.ico`).
 *     `electron-builder.yml` references these exact paths; do not rename.
 *   - The 1024×1024 master PNG is the parent of every other artifact —
 *     re-rasterize from the SVG instead of downsampling cascading PNGs.
 *   - The visible body is rendered at INNER (880) px and composited onto
 *     a CANVAS (1024) px transparent square — ~14% padding on every side
 *     so the dock-rendered icon matches the size of native neighbours
 *     instead of overflowing its slot. Source SVGs stay edge-to-edge so
 *     they remain usable as web favicons / message avatars without the
 *     same padding penalty.
 *   - `.icns` only emits on darwin (needs Apple's `iconutil`). Other
 *     platforms still get a fresh `.png` + `.ico` so CI on Linux/Windows
 *     can refresh the cross-platform pair.
 *
 * Non-obvious deps:
 *   - `sharp` rasterizes SVG via librsvg internally; `density: 384` tells
 *     it to upsample the small (64-viewBox) source at high DPI before the
 *     final resize, which keeps gradient edges clean.
 *   - `png-to-ico` packs multiple PNGs into a Windows ICO container.
 *   - Both packages are devDependencies of `desktop/` — install via
 *     `bun install` at the workspace root before running.
 *   - `iconutil` is Apple-shipped (Xcode CLT). Bash on macOS finds it
 *     under /usr/bin without extra setup.
 *
 * Usage (run from the `desktop/` workspace root):
 *   bun run icons
 *   bun run icons -- --source apps/electron/resources/source/icon-dark.svg
 */

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const cwd = process.cwd()
const source = resolve(cwd, arg('--source', 'apps/electron/resources/source/icon.svg'))
const outDir = resolve(cwd, arg('--out', 'apps/electron/resources'))
mkdirSync(outDir, { recursive: true })

// macOS dock + Windows 11 + Linux launchers all expect the visible icon
// body to occupy ~80% of the canvas, with transparent padding around it.
// Without this padding, our gradient fills 100% of the 1024×1024 PNG and
// the icon visually outsizes its neighbours in the dock by ~24%.
// 824/1024 ≈ 80.4% — Apple HIG's icon-grid recommendation, matching
// system apps like Finder / Safari / Mail. Earlier passes tried 880
// (~86%, "filled" style) but still read as oversized next to native
// neighbours in the dock; the strict HIG value is the right anchor.
const CANVAS = 1024
const INNER = 824

console.log(`source: ${source}`)
console.log(`outDir: ${outDir}`)

// Render the SVG to the INNER size, then composite onto a CANVAS-sized
// transparent canvas. Two-stage instead of a single resize-with-margin
// because sharp's resize doesn't expose a "fit-with-padding" mode that
// keeps the source aspect intact when the input itself is non-square.
const inner = await sharp(source, { density: 384 })
  .resize(INNER, INNER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()

const master = await sharp({
  create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: inner, gravity: 'center' }])
  .png()
  .toBuffer()

const linuxPng = resolve(outDir, 'icon.png')
writeFileSync(linuxPng, master)
console.log(`✔ ${linuxPng}`)

// Windows .ico — multi-size, 256 down to 16. png-to-ico takes an array of PNG buffers.
const icoSizes = [256, 128, 64, 48, 32, 16]
const icoBuffers = await Promise.all(
  icoSizes.map((s) =>
    sharp(master).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  )
)
const icoPath = resolve(outDir, 'icon.ico')
writeFileSync(icoPath, await pngToIco(icoBuffers))
console.log(`✔ ${icoPath}`)

// macOS .icns — only buildable on darwin (needs iconutil). Other platforms skip silently.
if (process.platform === 'darwin') {
  const iconset = resolve(outDir, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })

  // iconutil expects these exact filenames.
  const macSpecs: { size: number; name: string }[] = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ]
  await Promise.all(
    macSpecs.map(async ({ size, name }) => {
      const buf = await sharp(master)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
      writeFileSync(resolve(iconset, name), buf)
    })
  )
  const icnsPath = resolve(outDir, 'icon.icns')
  execSync(`iconutil -c icns "${iconset}" -o "${icnsPath}"`, { stdio: 'inherit' })
  rmSync(iconset, { recursive: true, force: true })
  console.log(`✔ ${icnsPath}`)
} else {
  console.log('· icon.icns skipped (not on darwin — run this on macOS to produce it)')
}
