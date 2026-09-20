import type { PresentationProject } from '@/atoms/presentation'

export const PRESENTATION_HISTORY_MAX_ENTRIES = 50
export const PRESENTATION_HISTORY_MAX_BYTES = 192 * 1024 * 1024

export interface PresentationHistoryEntry {
  project: PresentationProject
  estimatedBytes: number
}

/** Estimate retained JS heap without serializing large embedded data URLs. */
export function estimatePresentationProjectBytes(project: PresentationProject): number {
  const seen = new Set<object>()
  let bytes = 0

  const visit = (value: unknown) => {
    if (value === null || value === undefined) {
      bytes += 4
      return
    }
    if (typeof value === 'string') {
      // UTF-16 is deliberately conservative; data URLs are ASCII but can still be
      // promoted internally, and the budget should remain safe across runtimes.
      bytes += value.length * 2
      return
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      bytes += 8
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    bytes += Array.isArray(value) ? 24 : 32
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      bytes += key.length * 2
      visit(item)
    }
  }

  visit(project)
  return bytes
}

function cloneProject(project: PresentationProject): PresentationProject {
  // Keep immutable payload strings shared across history snapshots.
  const payloads = project.assets.map((asset) => asset.source.dataUrl)
  const payloadFreeProject: PresentationProject = {
    ...project,
    assets: project.assets.map((asset) => ({ ...asset, source: { ...asset.source, dataUrl: '' } })),
  }
  const cloned = structuredClone(payloadFreeProject)
  cloned.assets.forEach((asset, index) => { asset.source.dataUrl = payloads[index] ?? '' })
  return cloned
}

export function createPresentationHistoryEntry(project: PresentationProject, maxBytes = PRESENTATION_HISTORY_MAX_BYTES): PresentationHistoryEntry | null {
  const estimatedBytes = estimatePresentationProjectBytes(project)
  if (estimatedBytes > maxBytes) return null
  return { project: cloneProject(project), estimatedBytes }
}

/** Keep the newest contiguous history segment within both entry and byte limits. */
export function trimPresentationHistoryEntries(entries: readonly PresentationHistoryEntry[], maxEntries = PRESENTATION_HISTORY_MAX_ENTRIES, maxBytes = PRESENTATION_HISTORY_MAX_BYTES): PresentationHistoryEntry[] {
  const kept: PresentationHistoryEntry[] = []
  let retainedBytes = 0
  for (let index = entries.length - 1; index >= 0 && kept.length < Math.max(0, maxEntries); index -= 1) {
    const entry = entries[index]!
    if (entry.estimatedBytes > maxBytes - retainedBytes) break
    kept.unshift(entry)
    retainedBytes += entry.estimatedBytes
  }
  return kept
}

export function trimPresentationHistoryPair(past: PresentationHistoryEntry[], future: PresentationHistoryEntry[]): void {
  let entryCount = past.length + future.length
  let retainedBytes = [...past, ...future].reduce((sum, entry) => sum + entry.estimatedBytes, 0)
  while (entryCount > PRESENTATION_HISTORY_MAX_ENTRIES || retainedBytes > PRESENTATION_HISTORY_MAX_BYTES) {
    const removed = past.length > 0 ? past.shift() : future.shift()
    if (!removed) break
    entryCount -= 1
    retainedBytes -= removed.estimatedBytes
  }
}
