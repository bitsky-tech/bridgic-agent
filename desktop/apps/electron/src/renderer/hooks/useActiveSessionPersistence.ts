/**
 * Persist the active session id so the next app launch can restore it
 * (read side: useSessionBootstrap → pickInitialSession).
 *
 * Writes `settings.ui.lastSessionId` whenever the active session changes:
 *   - null active (boot transient, before restore runs) → SKIP, so we never
 *     clobber the remembered id before useSessionBootstrap reads it.
 *   - a draft (user on Landing / new session, not yet known to the daemon) → store
 *     null, so reopening faithfully returns to Landing.
 *   - a real session → store its id.
 * Redundant writes (value already on disk) are skipped to avoid settings churn.
 *
 * Mounted once in App, alongside useSessionBootstrap.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeSessionIdAtom, draftSessionIdsAtom, nextPersistedSessionId } from '@/atoms/sessions'
import { settingsAtom, updateSettingsAtom } from '@/atoms/settings'

export function useActiveSessionPersistence(): void {
  const activeId = useAtomValue(activeSessionIdAtom)
  const draftIds = useAtomValue(draftSessionIdsAtom)
  const lastSessionId = useAtomValue(settingsAtom).ui.lastSessionId
  const updateSettings = useSetAtom(updateSettingsAtom)

  useEffect(() => {
    const next = nextPersistedSessionId(activeId, draftIds, lastSessionId)
    // Redundant write (value already on disk) → skip to avoid settings churn.
    // The null-active branch returns `lastSessionId` unchanged, so it also
    // no-ops here — never clobbering the id useSessionBootstrap is about to read.
    if (next === lastSessionId) return
    void updateSettings((prev) => ({ ...prev, ui: { ...prev.ui, lastSessionId: next } }))
  }, [activeId, draftIds, lastSessionId, updateSettings])
}
