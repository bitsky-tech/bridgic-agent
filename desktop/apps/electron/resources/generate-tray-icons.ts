#!/usr/bin/env bun
/**
 * Generate the tray / menu-bar icon set from the brand SVG.
 *
 * Purpose:
 *   The tray icons used to be three hand-written **solid-color dot** base64 blobs
 *   (see TRAY_ICON_*_B64 in tray-manager.ts in the git history) — placeholders,
 *   never brand assets. This script replaces them with the real logo + a status
 *   dot in the bottom-right corner, and makes `resources/source/icon-dark.svg`
 *   the single source of truth.
 *
 * Key invariants:
 *   - The output is **TypeScript source** (`src/main/tray-icons.generated.ts`),
 *     not PNG files. The reason is in "Why inline base64 instead of reading PNG
 *     files at runtime" below — that is this script's most counter-intuitive
 *     design decision, read it before changing anything.
 *   - The **dark** variant is used as the source: it is "gradient background +
 *     white glyph", which holds on both light and dark menu bars; the light
 *     variant has a **white background**, i.e. invisible on a light menu bar.
 *   - A ring of **transparent** cutout is left around the status dot (punched out
 *     by an SVG mask), so the boundary between the dot and the logo stays crisp on
 *     a menu bar / tray of any background color, regardless of light or dark.
 *   - Each status emits @1x (16px) + @2x (32px); the consumer packs both into the
 *     two representations of a single nativeImage, which is what keeps it sharp
 *     on Retina.
 *
 * Why inline base64 instead of reading PNG files at runtime:
 *   The `files` allowlist in `apps/electron/electron-builder.yml` does **not**
 *   include `resources/` (it even excludes `!dist/resources/**` explicitly); only
 *   bin / uv_runtime / python_runtime / node_runtime enter the package via
 *   extraResources. Which means there is simply no tray PNG on disk to read after
 *   packaging — it runs fine on the dev machine and ships with empty icons.
 *   Switching to file reads would require touching electron-builder.yml. Inlining
 *   into TS lets esbuild bundle it, so dev and prod behave identically, with zero
 *   fs access and zero packaging-config changes.
 *   The six images total about 8KB — not worth wrestling the packaging pipeline.
 *
 * Non-obvious deps:
 *   - `sharp` rasterizes the SVG through librsvg; `density: 384` upsamples the
 *     small 64-viewBox source at high DPI before scaling it down to the target
 *     size, which is what keeps the gradient edges clean (same approach as
 *     generate-icons.ts).
 *   - `sharp` is a devDependency of `desktop/`; run `bun install` at the
 *     workspace root first.
 *
 * Usage (run from the `desktop/` workspace root):
 *   bun run icons:tray
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'

const cwd = process.cwd()
const SOURCE = resolve(cwd, 'apps/electron/resources/source/icon-dark.svg')
const OUT = resolve(cwd, 'apps/electron/src/main/tray-icons.generated.ts')

/** Logical menu-bar / tray sizes; @2x serves Retina. */
const SIZES = [16, 32] as const

/**
 * Status-dot palette — taken from the dark-theme status colors in
 * `renderer/styles/tokens.css`, so the tray shares the in-app status semantics.
 *
 * Brand blue is NOT used for "running": the logo itself is a blue-purple
 * gradient, so a blue dot smears into it and can't be made out.
 */
const STATUS_COLORS = {
  /** Gateway ready. --status-success */
  online: '#34D399',
  /** Gateway not running / unavailable. --status-pending */
  offline: '#8B90A5',
  /** Gateway unhealthy. --status-error */
  error: '#F87171',
  /** Starting / probing. --status-warning
   *
   *  "Busy" is the state that most needs feedback, yet it used to share the grey
   *  dot with "stopped": the CLI's readiness timeout is 40s, and throughout those
   *  40 seconds the icon never moved — while on macOS the tray menu is a snapshot
   *  once opened and never refreshes itself, so short of opening and closing the
   *  menu over and over the user had no way to know it was busy. */
  starting: '#FBBF24',
} as const

type StatusKey = keyof typeof STATUS_COLORS

/** Status-dot center and radius (in the source SVG's 64-unit coordinate system). */
const DOT_CX = 47
const DOT_CY = 47
const DOT_R = 12
/** The cutout is 4 units larger than the dot → a visually 2-unit-wide transparent stroke. */
const DOT_CUTOUT_R = DOT_R + 4

/** Take everything inside the SVG root tag (including its own defs / gradients). */
function innerSvg(raw: string): string {
  const m = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(raw)
  if (!m?.[1]) throw new Error(`unparseable SVG: ${SOURCE}`)
  return m[1]
}

/** Compose the "logo (with cutout) + status dot" SVG. */
function composeSvg(inner: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <mask id="amphi-tray-cut">
      <rect width="64" height="64" fill="#fff"/>
      <circle cx="${DOT_CX}" cy="${DOT_CY}" r="${DOT_CUTOUT_R}" fill="#000"/>
    </mask>
  </defs>
  <g mask="url(#amphi-tray-cut)">${inner}</g>
  <circle cx="${DOT_CX}" cy="${DOT_CY}" r="${DOT_R}" fill="${color}"/>
</svg>`
}

async function rasterize(svg: string, size: number): Promise<string> {
  const png = await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return png.toString('base64')
}

const inner = innerSvg(readFileSync(SOURCE, 'utf-8'))
const entries: string[] = []

for (const key of Object.keys(STATUS_COLORS) as StatusKey[]) {
  const svg = composeSvg(inner, STATUS_COLORS[key])
  // Awaited one by one rather than destructuring a Promise.all result array: this
  // file is in no tsconfig `include` (`apps/electron` only picks up `src/**`), so
  // typecheck does not cover it, and array destructuring is `string | undefined`
  // under noUncheckedIndexedAccess — if one really did slip through, the literal
  // `undefined` would be written into the generated file, leaving an empty tray
  // icon with nobody reporting an error.
  const x1 = await rasterize(svg, SIZES[0])
  const x2 = await rasterize(svg, SIZES[1])
  entries.push(`  ${key}: {\n    x1: '${x1}',\n    x2: '${x2}',\n  },`)
}

// The generated file's key type is derived from STATUS_COLORS — adding a status
// no longer requires hand-syncing that `Record<...>` line, where a missed edit
// would let consumers reach for a non-existent key and still compile.
const statusKeyUnion = (Object.keys(STATUS_COLORS) as StatusKey[])
  .map((key) => `'${key}'`)
  .join(' | ')

const banner = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated by \`bun run icons:tray\` from \`resources/source/icon-dark.svg\`: the
 * brand logo with a status dot in the bottom-right corner, two base64 PNGs per
 * status — @1x (16px) + @2x (32px).
 * To change the icon, edit that SVG (or the status palette in
 * generate-tray-icons.ts) and re-run the script.
 *
 * Why inline base64 rather than PNG files: the packaging allowlist does not
 * include \`resources/\`, so the installed app has no image on disk to read. Full
 * reasoning in the header comment of \`resources/generate-tray-icons.ts\`.
 */

/** The two scale steps of one status's bitmap (base64 PNG, no data-URL prefix). */
export interface TrayIconSet {
  /** 16×16, @1x. */
  x1: string
  /** 32×32, @2x (Retina). */
  x2: string
}

/** Tray icon bitmaps indexed by gateway status. */
export const TRAY_ICONS: Record<${statusKeyUnion}, TrayIconSet> = {
`

writeFileSync(OUT, `${banner}${entries.join('\n')}\n}\n`, 'utf-8')
console.log(`[icons:tray] wrote ${OUT}`)
