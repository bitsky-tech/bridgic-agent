import type { DesktopDebugTurnsPage } from '@shared/debug-types'

export async function fetchTracePage(sessionId: string, cursor: string | null, signal: AbortSignal): Promise<DesktopDebugTurnsPage> {
  const query = new URLSearchParams({ limit: '30' })
  if (cursor) query.set('before', cursor)
  const response = await fetch(`/__debug-api/sessions/${encodeURIComponent(sessionId)}/turns?${query}`, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const page = await response.json() as DesktopDebugTurnsPage
  if (page.sessionId !== sessionId || !Array.isArray(page.turns)
    || page.turns.some((turn) => turn.sessionId !== sessionId)
    || typeof page.hasMore !== 'boolean'
    || (page.hasMore && typeof page.nextCursor !== 'string')) {
    throw new Error('Invalid session trace response')
  }
  return page
}
