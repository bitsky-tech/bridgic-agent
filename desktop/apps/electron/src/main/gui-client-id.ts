/**
 * Stable identifier this GUI process sends on backend requests via
 * `X-Client-Id`. The daemon tracks one record per ID in its in-memory
 * client registry exposed by `/api/gateway/clients`; we use a single
 * id for the whole Electron main-process lifetime so the daemon sees
 * one logical client per running GUI.
 *
 * Generated at module load. Process-lifetime only — closing + reopening
 * the GUI gets a fresh id. That's acceptable because:
 *  1. The daemon expires entries 5 minutes after last_seen anyway.
 *  2. The id is for observability ("which clients are online right
 *     now"), not for stable user/session tracking.
 *  3. Persisting in GuiSettings adds complexity for no functional gain
 *     until we want cross-restart presence (post-MVP).
 *
 * The `gui-` prefix makes the id easy to recognize in
 * `GET /api/gateway/clients` listings vs CLI / tray clients.
 */
import { randomUUID } from 'node:crypto'
import { ClientKind } from './python-client/types'

// Short UUID slice keeps the id readable in logs without being too
// fragile. 12 hex chars = 48 bits = collision-safe for the single-host,
// single-user scope.
const ID = `${ClientKind.Gui}-${randomUUID().slice(0, 12)}`

/** Return the process-lifetime GUI client identifier. */
export function guiClientId(): string {
  return ID
}
