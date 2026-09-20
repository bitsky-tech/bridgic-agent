import type { PresentationProject } from '@/atoms/presentation'
import { normalizePresentationProject, presentationProjectOf } from '../project'
import { presentationProjectSchema } from '../schema'

export function validatePresentationProject(project: PresentationProject): PresentationProject {
  const normalized = presentationProjectOf(normalizePresentationProject(project))
  const parsed = presentationProjectSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new Error(`Invalid PowerPoint project${location}: ${issue?.message ?? 'unknown model error'}`)
  }
  return normalized
}

/** The single content mutation gate shared by canvas edits and Agent commands. */
export function editPresentationProject(previous: PresentationProject, next: PresentationProject): PresentationProject {
  if (next.id !== previous.id) throw new Error('A presentation edit cannot replace the active project identity')
  return validatePresentationProject(normalizePresentationProject(next))
}
