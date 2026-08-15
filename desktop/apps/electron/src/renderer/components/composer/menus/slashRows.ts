/**
 * Row model + pure derivation for the "/" menu — the React-free / jotai-free part
 * extracted out of useSlashMenuState.
 *
 * Why it is its own file: the row derivation (group order · filtering · per-group cap · overflow
 * count) is the only logic in this menu with real branching, yet it used to be buried inside the
 * hook's useMemo — the project has no renderHook harness (atom tests all build a jotai store
 * directly), so it was untestable through the hook; and the hook's import chain would drag jotai /
 * amphiClient into bun:test (anti-pattern §H). Extracted as a pure function, the hook degenerates
 * into a thin shell of "hydrate side effect + useMemo wrapper" and the derivation becomes unit
 * testable (§4.12). The sibling matchesFilter.ts and main-side sanitize.ts are precedents for the
 * same move.
 *
 * Invariant: `buildSlashRows` returns a **flat, keyboard-ordered** row list with rows of the same
 * group contiguous — SlashMenu renders strictly in that order, group headers are derived from the
 * `group` changing between adjacent rows, and the keyboard index never drifts from the screen (§1.28).
 */
import type { SkillDetail, WorkflowSummary } from '@/lib/amphiClient'
import type { Schedule } from '@/lib/schedule'
import { SLASH_COMMANDS } from '@/atoms/composer-fixtures'
import { i18n } from '@/lib/i18n'
import { CapabilityMentionGroup } from '../segments'
import { HELP_COMMAND_ID } from '../helpCommand'
import { matchesFilter } from '../matchesFilter'

/** Max rows shown per dynamic group (skills/workflows/schedules) when unfiltered; the rest
 *  collapse (narrow it down with the filter) so a huge skill list does not render hundreds of
 *  buttons at once (#6). The command group is uncapped (only 3 entries). */
const MAX_PER_GROUP = 10

/** Group headers (rendered + derived header). The three capability groups reuse
 *  segments.CapabilityMentionGroup, sharing a source with getMentionPrefix's allow-list —
 *  inserting a reference takes `group` straight from here, which is what makes the badge show `/`. */
export const SlashGroup = {
  Command: 'Command',
  Skill: CapabilityMentionGroup.Skill,
  Workflow: CapabilityMentionGroup.Workflow,
  Schedule: CapabilityMentionGroup.Schedule,
} as const
export type SlashGroup = (typeof SlashGroup)[keyof typeof SlashGroup]

/** Display keys are kept separate from the persisted group values so old composer
 * drafts retain their protocol-compatible group identifiers across locale changes. */
export function slashGroupTranslationKey(group: SlashGroup): string {
  switch (group) {
    case SlashGroup.Command:
      return 'composer.slash.group.command'
    case SlashGroup.Skill:
      return 'composer.slash.group.skill'
    case SlashGroup.Workflow:
      return 'composer.slash.group.workflow'
    case SlashGroup.Schedule:
      return 'composer.slash.group.schedule'
  }
}

/** Source discriminator for one "/" menu row (§4.11). It and SlashGroup are two parallel
 *  vocabularies: `kind` decides **behaviour** (command → local dispatch; schedule → run now;
 *  everything else → insert a capability token), `group` decides **display** (header + colours).
 *  Both travel on the same row — never use one as the other. */
export const SlashRowKind = {
  Command: 'command',
  Skill: 'skill',
  Workflow: 'workflow',
  Schedule: 'schedule',
} as const
export type SlashRowKind = (typeof SlashRowKind)[keyof typeof SlashRowKind]

/** Dynamic resource row kinds — everything except commands. Derived from SlashRowKind instead of
 *  re-typing the literals: adding another entity kind only means editing the const above, and this
 *  type plus pushCapped's parameter follow automatically. */
export type ReferenceRowKind = Exclude<SlashRowKind, typeof SlashRowKind.Command>

/** One selectable "/" menu row, discriminated by source. Command rows carry an id for local
 *  dispatch; skills and workflows insert a capability token, schedules insert a "run now" action
 *  token. `overflow` is set only on the **last** row of a capped group = how many entries that
 *  group hides — stamped on the last row rather than the first because SlashMenu renders the hint
 *  after that group's final entry: the user only discovers "that's all of them" after scrolling to
 *  the bottom of the group, so that is where the hint belongs in the flow. */
export type SlashRow =
  | {
      kind: typeof SlashRowKind.Command
      id: string
      label: string
      description: string
      group: typeof SlashGroup.Command
    }
  | {
      kind: ReferenceRowKind
      id: string
      label: string
      description?: string
      /** A reference row's group is always one of the three capability groups — never
       *  SlashGroup.Command (a command row is not a reference target). Typed as
       *  CapabilityMentionGroup rather than SlashGroup so it can be fed straight to
       *  useSlashTrigger.insertReference (which takes a MentionGroup and rejects the command group). */
      group: CapabilityMentionGroup
      overflow?: number
    }

/** Rows of the "insert a reference" kind — pushCapped's parameter type, and the narrowing
 *  target when SlashMenu checks `overflow`. */
export type ReferenceSlashRow = Extract<SlashRow, { kind: ReferenceRowKind }>

/** The derivation only needs these few fields from each data source — `Pick` rather than the full
 *  types: narrow parameters let unit tests use minimal fixtures and keep the tests from being
 *  dragged along whenever an upstream wire type grows. */
export interface SlashRowSources {
  skills: Pick<SkillDetail, 'skill_id' | 'name' | 'description'>[]
  workflows: Pick<WorkflowSummary, 'id' | 'name' | 'desc'>[]
  schedules: Pick<Schedule, 'id' | 'name' | 'desc'>[]
  /** Filter string between the `/` and the caret; empty string = no filtering. */
  filter: string
  /** Structured /help is Main-only; Build / Workflow Run leave typed help as ordinary text. */
  includeHelp?: boolean
}

/**
 * Derive the flat "/" menu row list from the three data sources + the filter.
 *
 * The order is always command → skill → workflow → schedule; each dynamic group is filtered
 * first, then truncated to the first MAX_PER_GROUP rows, stamping `overflow` on that group's last
 * row when it was cut. An empty group produces no rows at all (its header disappears naturally).
 */
export function buildSlashRows({
  skills,
  workflows,
  schedules,
  filter,
  includeHelp = true,
}: SlashRowSources): SlashRow[] {
  const out: SlashRow[] = []
  for (const c of SLASH_COMMANDS) {
    if (!includeHelp && c.id === HELP_COMMAND_ID) continue
    const label = i18n.t(`composer.command.${c.id}.label`)
    const description = i18n.t(`composer.command.${c.id}.description`)
    if (matchesFilter(c.id, filter) || matchesFilter(label, filter)) {
      out.push({
        kind: SlashRowKind.Command,
        id: c.id,
        label,
        description,
        group: SlashGroup.Command,
      })
    }
  }
  pushCapped(
    out,
    skills
      .filter((s) => matchesFilter(s.name, filter))
      .map((s) => ({
        kind: SlashRowKind.Skill,
        // id uses the unique skill_id (not the name) so identically named skills cannot collide
        // on the React key or make the reference id ambiguous (#4).
        id: String(s.skill_id),
        label: s.name,
        description: s.description ?? undefined,
        group: SlashGroup.Skill,
      })),
  )
  pushCapped(
    out,
    workflows
      .filter((w) => matchesFilter(w.name, filter) || matchesFilter(w.id, filter))
      .map((w) => ({
        kind: SlashRowKind.Workflow,
        id: w.id,
        label: w.name,
        description: w.desc ?? undefined,
        group: SlashGroup.Workflow,
      })),
  )
  pushCapped(
    out,
    schedules
      .filter((sc) => matchesFilter(sc.name, filter))
      .map((sc) => ({
        kind: SlashRowKind.Schedule,
        id: sc.id,
        label: sc.name,
        description: i18n.t('composer.slash.scheduleDescription', { suffix: sc.desc ? ` · ${sc.desc}` : '' }),
        group: SlashGroup.Schedule,
      })),
  )
  return out
}

/** Push a dynamic group's rows into `out`, capped at MAX_PER_GROUP; if truncated,
 *  stamp `overflow` (hidden count) on the group's LAST shown row so SlashMenu can
 *  hint the hidden count right below it. Empty group → nothing pushed. */
function pushCapped(out: SlashRow[], rows: ReferenceSlashRow[]): void {
  if (rows.length === 0) return
  const shown = rows.slice(0, MAX_PER_GROUP)
  const hidden = rows.length - shown.length
  const last = shown.length - 1
  if (hidden > 0) shown[last] = { ...shown[last]!, overflow: hidden }
  out.push(...shown)
}
