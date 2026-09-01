/**
 * The one name both workbench pages publish their agent bridge under.
 *
 * Keeping it single means the agent's transport does not have to know which
 * page is open; a call for the wrong workbench is answered by the bridge's
 * `kind` instead of failing to find a global.
 */
import type { DocBridge } from './doc/bridge'
import type { SheetBridge } from './sheet/bridge'

declare global {
  interface Window {
    __univerBridge?: DocBridge | SheetBridge
  }
}
