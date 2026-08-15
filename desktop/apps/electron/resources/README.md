# Resources

This directory holds packaged assets pulled into the app at build time.

## What lives here

| File | Purpose |
|---|---|
| `source/*.svg` | Source SVG icons (vector, single source of truth) |
| `source/*.ico` | Backup of the legacy 32×32 favicon, kept for reference |
| `icon.png` | 1024×1024 master PNG — Linux app icon |
| `icon.icns` | macOS app icon (generated, darwin only) |
| `icon.ico` | Windows app icon (generated, multi-size 16/32/48/64/128/256) |
| `entitlements.mac.plist` | macOS hardened runtime entitlements |
| `generate-icons.ts` | Regenerates `icon.png / .icns / .ico` from a source SVG |

## Replacing the icon

1. Drop a square SVG into `resources/source/` (any viewBox; it will be rasterized onto a 1024×1024 canvas).
2. From the `desktop/` workspace root, run:

   ```bash
   # Default source: apps/electron/resources/source/icon.svg
   bun run icons

   # Or point at any source SVG explicitly
   bun run icons -- --source apps/electron/resources/source/icon-dark.svg
   ```

3. Commit the regenerated `.png / .icns / .ico` files.

The script only writes `icon.icns` on macOS (it needs `iconutil`). On Windows / Linux you'll still get the cross-platform `.png` and `.ico`.

## DMG background (optional)

Drop a 540×380 `dmg-background.png` here and reference it in `electron-builder.yml`'s `dmg.background`. Without it, electron-builder uses a clean default — fine for development builds.
