/** Cycle-free top-level navigation state shared by Agent and dock atoms. */
import { atom } from 'jotai'
import { activeSessionIdAtom } from './sessions'
import { settingsAtom } from './settings'

export const NavKey = {
  Home: 'home',
  Workflows: 'workflows',
  Skills: 'skills',
  Schedules: 'schedules',
  Assets: 'assets',
} as const
export type NavKey = (typeof NavKey)[keyof typeof NavKey]

const NAV_KEYS = new Set<string>(Object.values(NavKey))

/** Guard persisted navigation against removed, renamed, or hand-edited keys. */
export function toNavKey(stored: string): NavKey {
  return NAV_KEYS.has(stored) ? (stored as NavKey) : NavKey.Home
}

/** Top-level view filling the center column. */
export const activeNavAtom = atom<NavKey>((get) => toNavKey(get(settingsAtom).ui.lastNav))

/** Active Session only while the user is actually looking at Home. */
export const viewedSessionIdAtom = atom<string | null>((get) =>
  get(activeNavAtom) === NavKey.Home ? get(activeSessionIdAtom) : null,
)
