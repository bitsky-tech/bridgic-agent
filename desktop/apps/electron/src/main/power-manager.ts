/**
 * Power Save Blocker — prevents the display from sleeping while a long-running
 * task is active.
 *
 * Caller pattern:
 *   onTaskStarted()   // ref-counted
 *   ...
 *   onTaskStopped()
 *
 * The setting is gated by `keepAwakeEnabled` so users can opt out.
 */

import { powerSaveBlocker } from 'electron'
import { mainLog } from './logger'

let blockerId: number | null = null
let activeCount = 0
let keepAwakeEnabled = false

export function setKeepAwakeEnabled(enabled: boolean): void {
  keepAwakeEnabled = enabled
  reconcile()
}

export function onTaskStarted(): void {
  activeCount++
  reconcile()
}

export function onTaskStopped(): void {
  if (activeCount > 0) activeCount--
  reconcile()
}

export function cleanupPowerManager(): void {
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  activeCount = 0
}

function reconcile(): void {
  const shouldBlock = keepAwakeEnabled && activeCount > 0

  if (shouldBlock && blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
    mainLog.info('[power] started', { blockerId, activeCount })
  } else if (!shouldBlock && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    mainLog.info('[power] stopped', { blockerId })
    blockerId = null
  }
}
