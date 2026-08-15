/** Global asset-browser state backed by Session mounts and Workflow Runs. */
import { atom, type Getter, type Setter } from 'jotai'

import type { SessionFileAsset } from '@/lib/amphiClient'
import { fetchAllOffsetPages } from '@/lib/amphiClient'
import { i18n } from '@/lib/i18n'
import { rlog } from '@/lib/logger'
import { buildAmphiClient } from './backend'
import { hydrateAllWorkflowRunsAtom } from './workflows'

export type AssetsHydrationState = 'idle' | 'loading' | 'ready' | 'error'

const _sessionFiles = atom<SessionFileAsset[]>([])
const _hydrationState = atom<AssetsHydrationState>('idle')
const _hydrationError = atom<string | null>(null)
const _hydrationPromise = atom<Promise<void> | null>(null)

export const sessionFileAssetsAtom = atom((get) => get(_sessionFiles))
export const assetsHydrationStateAtom = atom((get) => get(_hydrationState))
export const assetsHydrationErrorAtom = atom((get) => get(_hydrationError))

/** Refresh both asset categories as one page-level operation. */
export const hydrateAssetsAtom = atom(null, (get, set): Promise<void> => {
  const existing = get(_hydrationPromise)
  if (existing) return existing
  const promise = hydrateAssets(get, set).finally(() => set(_hydrationPromise, null))
  set(_hydrationPromise, promise)
  return promise
})

async function hydrateAssets(get: Getter, set: Setter): Promise<void> {
  const client = buildAmphiClient(get)
  if (!client) {
    set(_hydrationState, 'error')
    set(_hydrationError, i18n.t('error.backendNotReadyAssets'))
    return
  }
  set(_hydrationState, 'loading')
  const [files, runs] = await Promise.allSettled([
    fetchAllOffsetPages(
      (page) => client.listSessionFileAssets(page),
      (asset) => `${asset.session_id}:${asset.id}`,
    ),
    set(hydrateAllWorkflowRunsAtom),
  ])
  if (files.status === 'fulfilled') set(_sessionFiles, files.value)

  const failures = [
    files.status === 'rejected' ? i18n.t('error.assetUserFiles', { msg: errorMessage(files.reason) }) : null,
    runs.status === 'rejected' ? i18n.t('error.assetWorkflowOutputs', { msg: errorMessage(runs.reason) }) : null,
  ].filter((message): message is string => Boolean(message))
  if (failures.length === 0) {
    set(_hydrationError, null)
    set(_hydrationState, 'ready')
  } else {
    rlog.warn('[assets] partial hydrate failed', { failures })
    set(_hydrationError, i18n.t('error.assetsPartialLoadFailed', { detail: failures.join('；') }))
    set(_hydrationState, 'error')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
