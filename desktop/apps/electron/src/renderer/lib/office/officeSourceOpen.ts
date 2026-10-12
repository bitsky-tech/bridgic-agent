export type OfficeSourceOpenAction = 'create' | 'reuse' | 'refresh' | 'conflict'

/** All Office domains preserve a live document when its prepared source is unchanged. */
export function resolveOfficeSourceOpen(current: { mtimeMs: number | null | undefined; dirty: boolean } | undefined, incomingMtimeMs: number | null): OfficeSourceOpenAction {
  if (!current) return 'create'
  if (current.mtimeMs === incomingMtimeMs) return 'reuse'
  return current.dirty ? 'conflict' : 'refresh'
}
