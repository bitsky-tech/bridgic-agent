/** Presentation metadata for the three execution modes (shared by the settings card and the composer pill). The kernel has no notion of risk;
 *  this is purely user-facing wording. */
import type { ExecutionMode } from '@/atoms/permissions'

export interface ModeMeta {
  id: ExecutionMode
  labelKey: string
  descKey: string
  freqKey: string
}

export const MODE_META: ModeMeta[] = [
  { id: 'request', labelKey: 'permission.mode.request.label', descKey: 'permission.mode.request.desc', freqKey: 'permission.mode.request.freq' },
  { id: 'auto', labelKey: 'permission.mode.auto.label', descKey: 'permission.mode.auto.desc', freqKey: 'permission.mode.auto.freq' },
  { id: 'full', labelKey: 'permission.mode.full.label', descKey: 'permission.mode.full.desc', freqKey: 'permission.mode.full.freq' },
]
