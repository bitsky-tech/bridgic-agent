/**
 * useSlashMenuState — data wiring for the "/" menu: read three atoms + hydrate on the open edge.
 *
 * The menu lists four groups in order: commands (the static SLASH_COMMANDS) · skills · workflows · schedules. Skills and workflows
 * are real backend data and are lazily loaded (they only hydrate when their nav page is visited), so we proactively hydrate once on
 * the menu's open edge, otherwise those two groups would be empty; schedules are a frontend mock and are read directly.
 *
 * Row derivation itself is a pure function living in ./slashRows.ts (which has tests); this file only handles the React / jotai
 * wiring — do not move derivation branches back in here, or they become untestable code again.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { hydrateSkillsAtom, skillsAtom } from '@/atoms/skills'
import { hydrateWorkflowsAtom, workflowsAtom } from '@/atoms/workflows'
import { schedulesAtom } from '@/atoms/schedules'
import { buildSlashRows, type SlashRow } from './slashRows'

/** Derive the flat rows of the "/" menu — hydrate skills/workflows on the open edge, and filter across groups. */
export function useSlashMenuState(isOpen: boolean, filter: string, includeHelp: boolean): SlashRow[] {
  const skills = useAtomValue(skillsAtom)
  const workflows = useAtomValue(workflowsAtom)
  const schedules = useAtomValue(schedulesAtom)
  const hydrateSkills = useSetAtom(hydrateSkillsAtom)
  const hydrateWorkflows = useSetAtom(hydrateWorkflowsAtom)

  // Hydrate the lazily loaded skills/workflows once when the menu is first opened (an imperative side effect, not derived state, §1.17).
  // Only once: the skills/workflows atoms are shared and reactive — whether the Skills/Workflows page or this hydrate fetches first,
  // the atom is updated and the menu's useAtomValue reflects it automatically; there is no need to re-fetch on every open (#3, which
  // would spam GETs and churn the global skills hydration state).
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (isOpen && !hydratedRef.current) {
      hydratedRef.current = true
      void hydrateSkills()
      void hydrateWorkflows()
    }
  }, [isOpen, hydrateSkills, hydrateWorkflows])

  return useMemo<SlashRow[]>(
    () => (isOpen ? buildSlashRows({ skills, workflows, schedules, filter, includeHelp }) : []),
    [isOpen, filter, includeHelp, skills, workflows, schedules],
  )
}
