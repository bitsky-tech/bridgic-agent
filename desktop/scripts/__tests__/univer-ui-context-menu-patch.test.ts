/**
 * Guards the small upstream patch that keeps Univer context-menu submenus from
 * overlapping while the pointer moves between sibling rows.
 *
 * Univer 0.25.1 intentionally waits 500 ms before closing a submenu so the
 * pointer can cross the portal gap. That delay is useful when entering the
 * current submenu, but it also leaves the previous submenu visible after a
 * sibling has already opened. The patch retains the gap tolerance while
 * enforcing one active submenu owner per menu level.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DESKTOP_DIR = path.join(import.meta.dir, '../..')
const PACKAGE_JSON = path.join(DESKTOP_DIR, 'package.json')
const PATCH_FILE = path.join(DESKTOP_DIR, 'patches/@univerjs%2Fui@0.25.1.patch')

describe('@univerjs/ui context-menu patch', () => {
  it('is registered as a patched dependency', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
      patchedDependencies?: Record<string, string>
    }

    expect(pkg.patchedDependencies?.['@univerjs/ui@0.25.1']).toBe(
      'patches/@univerjs%2Fui@0.25.1.patch',
    )
  })

  it('coordinates a single visible submenu at every menu level', () => {
    const patch = readFileSync(PATCH_FILE, 'utf-8')
    const runtimeSections = patch
      .split('diff --git ')
      .filter((section) => /a\/lib\/(?:cjs\/|es\/)?index\.js/.test(section))

    // Bun may load the ESM, CommonJS, or legacy root build depending on the
    // consumer. Keeping all three in sync avoids a fix that works only in dev.
    expect(runtimeSections).toHaveLength(3)
    for (const section of runtimeSections) {
      expect(section).toContain('activeMenuItem')
      expect(section).toContain('onMenuItemEnter: setActiveMenuItem')
      expect(section).toContain('activeSubmenuVisible = submenuVisible && activeMenuItem === menuItem')
      expect(section).toContain('onMenuItemEnter(menuItem)')
      expect(section).toContain('hasSubmenu && activeSubmenuVisible')
    }
  })
})
