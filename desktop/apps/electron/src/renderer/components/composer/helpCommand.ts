import type { ThinkPosition } from '@shared/types'
import type { Segment } from './segments'

export const HELP_COMMAND_ID = 'help'

/** Structured /help is a Main-only affordance; unknown state stays backward-compatible. */
export function isStructuredHelpAvailable(position: ThinkPosition | null): boolean {
  return position?.mode !== 'build' && position?.mode !== 'run_workflow'
}

/** Turn a stale Main /help token back into ordinary text before a special-mode submit. */
export function demoteUnavailableHelp(segments: Segment[], available: boolean): Segment[] {
  if (available) return segments

  let changed = false
  const normalized = segments.map((segment): Segment => {
    if (segment.type !== 'slash' || segment.resource || segment.id !== HELP_COMMAND_ID) return segment
    changed = true
    return { type: 'text', value: `/${HELP_COMMAND_ID}` }
  })
  return changed ? normalized : segments
}
