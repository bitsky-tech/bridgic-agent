/**
 * Detection of the **supplementary** key bindings for zoom — a pure function
 * that never touches electron, so it can be unit-tested.
 *
 * Division of labour (see zoomItems in `main/index.ts`): the app menu only
 * registers each action's canonical binding (`CmdOrCtrl+Plus` / `CmdOrCtrl+-` /
 * `CmdOrCtrl+0`), and this module fills in the two kinds the menu can't carry:
 *
 *   1. **`=` without Shift** — `+` requires Shift on most keyboards, so what
 *      the user actually presses is `=`;
 *   2. **The numeric keypad's +/-** — commonly used, but physically different
 *      keys from the main block.
 *
 * Why not duplicate the bindings via hidden menu items:
 * `acceleratorWorksWhenHidden` is macOS-only, and on Windows/Linux a hidden
 * item's accelerator is not guaranteed to fire, leaving those users with only
 * `Ctrl+Shift+=` for zooming.
 *
 * Invariant: **mutually exclusive with the menu bindings**. We deliberately do
 * not recognize `+` (`=` with Shift), `-`, or `0` here — those three belong to
 * the menu, and claiming them twice would send a single keypress down two
 * paths and jump the zoom by two steps.
 *
 * Callers must confirm Cmd/Ctrl is held themselves (this function does not
 * deal with the platform differences of modifier keys).
 */
import { ZOOM_LEVEL_STEP } from '@app/shared/types'

/**
 * Returns the zoom delta when a supplementary binding matches, otherwise
 * `null` (the caller uses this to decide whether to preventDefault).
 *
 * @param key   - `Electron.Input.key` — character semantics (affected by Shift)
 * @param code  - `Electron.Input.code` — the physical key (distinguishes the main block from the keypad)
 * @param shift - Whether Shift is held
 */
export function pickZoomDelta(
  key: string | undefined,
  code: string | undefined,
  shift: boolean,
): number | null {
  if (code === 'NumpadAdd') return ZOOM_LEVEL_STEP
  if (code === 'NumpadSubtract') return -ZOOM_LEVEL_STEP
  // `=` with Shift is `+`, which belongs to the menu's CmdOrCtrl+Plus, so it must be let through here.
  if (key === '=' && !shift) return ZOOM_LEVEL_STEP
  return null
}
