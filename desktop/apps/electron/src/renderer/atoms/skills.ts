/**
 * atoms/skills.ts — server-mirrored Skill catalogue for the Skills page.
 *
 * Holds the user's installed skills (`GET /skills`), a hydration status machine,
 * and the toggle/delete write actions. Mirrors `atoms/models.ts` (hydrate-once
 * via a shared in-flight Promise + status machine + `lastActionError`).
 *
 * Invariants:
 * - We never filter by `enabled` here: the management list shows EVERY skill
 *   incl. disabled. Only the daemon hides disabled skills from the agent runtime
 *   (`SkillLibrary.load()`).
 * - Pure atoms only (§1.30) — no React hooks. Consumers hydrate via a mount
 *   effect that sets `hydrateSkillsAtom`.
 */
import { atom, type Getter, type Setter } from 'jotai'

import type {
  ImportCheckResult,
  ImportSummary,
  ScannedSkill,
  SkillDetail,
  SkillImportItem,
} from '../lib/amphiClient'
import { rlog } from '../lib/logger'
import { i18n } from '../lib/i18n'
import { buildAmphiClient } from './backend'

// ─── Server-mirrored state ───────────────────────────────────────────────────
const _skills = atom<SkillDetail[]>([])

/** Lifecycle of the `GET /skills` fetch backing the page. */
export type SkillsHydrationState = 'idle' | 'loading' | 'ready' | 'error'
const _hydrationState = atom<SkillsHydrationState>('idle')
const _hydrationError = atom<string | null>(null)
const _lastActionError = atom<string | null>(null)

/** Shared in-flight hydrate Promise — dedupes concurrent hydrate calls (e.g. the
 *  page mounts while a refresh kicked off by a write is still running). */
const _hydrationPromise = atom<Promise<void> | null>(null)

// ─── Read atoms ──────────────────────────────────────────────────────────────
/** Every installed skill, newest first (includes disabled rows). */
export const skillsAtom = atom((get) => get(_skills))
/** Current hydration status (drives loading / error placeholders). */
export const skillsHydrationStateAtom = atom((get) => get(_hydrationState))
/** Hydration failure message, or null. */
export const skillsHydrationErrorAtom = atom((get) => get(_hydrationError))
/** Last write-action (toggle/delete) failure message, or null. */
export const skillsLastActionErrorAtom = atom((get) => get(_lastActionError))
/** Clear the last write-action error (e.g. when the user dismisses a banner). */
export const clearSkillsLastActionErrorAtom = atom(null, (_get, set) => {
  set(_lastActionError, null)
})

// ─── Hydrate (GET /skills) ───────────────────────────────────────────────────
/** Load the user's installed skills. Idempotent + deduped: concurrent callers
 *  share one in-flight request. Call on Skills-page mount and after any write. */
export const hydrateSkillsAtom = atom(null, (get, set): Promise<void> => {
  const existing = get(_hydrationPromise)
  if (existing) return existing
  const promise = hydrateSkillsImpl(get, set).finally(() => set(_hydrationPromise, null))
  set(_hydrationPromise, promise)
  return promise
})

/** Internal hydrate body — never rejects; throws become error-state writes so
 *  the outer Promise always resolves (mirrors `hydrateModelsImpl`). */
async function hydrateSkillsImpl(get: Getter, set: Setter): Promise<void> {
  const client = buildAmphiClient(get)
  if (!client) {
    set(_hydrationState, 'error')
    set(_hydrationError, i18n.t('error.backendNotReadySkills'))
    return
  }
  set(_hydrationState, 'loading')
  try {
    const skills = await client.listSkills()
    set(_skills, skills)
    set(_hydrationError, null)
    set(_hydrationState, 'ready')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[skills] hydrate failed', err)
    set(_hydrationError, i18n.t('error.skillsLoadFailed', { msg }))
    set(_hydrationState, 'error')
  }
}

// ─── Write actions ───────────────────────────────────────────────────────────
/** Flip one skill's `enabled`, then patch the server-returned row into the list.
 *  Throws on failure (the caller surfaces it); `_lastActionError` also records it. */
export const toggleSkillAtom = atom(
  null,
  async (get, set, input: { skillId: number; enabled: boolean }) => {
    const client = buildAmphiClient(get)
    if (!client) {
      const msg = i18n.t('error.backendNotReady')
      set(_lastActionError, msg)
      throw new Error(msg)
    }
    try {
      const updated = await client.toggleSkill(input.skillId, input.enabled)
      set(
        _skills,
        get(_skills).map((s) => (s.skill_id === updated.skill_id ? updated : s)),
      )
      set(_lastActionError, null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rlog.error('[skills] toggle failed', err)
      set(_lastActionError, i18n.t('error.skillToggleFailed', { msg }))
      throw err
    }
  },
)

// ─── Import wizard actions (read-only scan/check + the install) ──────────────
// These return their result to the caller (the import modal holds the wizard
// state locally) rather than mirroring into a page atom. They throw on failure
// so the modal can surface it inline.

/** Deep-scan a daemon-side directory for importable skills (read-only). */
export const scanSkillsAtom = atom(
  null,
  (get, _set, path: string): Promise<ScannedSkill[]> => {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.backendNotReady'))
    return client.scanImportPath(path)
  },
)

/** Dry-run conflict check for the chosen items (read-only; order matches input). */
export const checkSkillImportAtom = atom(
  null,
  (get, _set, items: SkillImportItem[]): Promise<ImportCheckResult[]> => {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.backendNotReady'))
    return client.checkSkillImport(items)
  },
)

/** Install the chosen items, then refresh the page list. Returns the summary. */
export const importSkillsAtom = atom(
  null,
  async (get, set, items: SkillImportItem[]): Promise<ImportSummary> => {
    const client = buildAmphiClient(get)
    if (!client) throw new Error(i18n.t('error.backendNotReady'))
    const summary = await client.importSkills(items)
    await set(hydrateSkillsAtom)
    return summary
  },
)

/** Delete one skill, then refresh the list. Throws on failure. */
export const deleteSkillAtom = atom(null, async (get, set, skillId: number) => {
  const client = buildAmphiClient(get)
  if (!client) {
    const msg = i18n.t('error.backendNotReady')
    set(_lastActionError, msg)
    throw new Error(msg)
  }
  try {
    await client.deleteSkill(skillId)
    await set(hydrateSkillsAtom)
    set(_lastActionError, null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[skills] delete failed', err)
    set(_lastActionError, i18n.t('error.skillDeleteFailed', { msg }))
    throw err
  }
})
