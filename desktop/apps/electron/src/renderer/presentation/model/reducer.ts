import type { PresentationDocument } from '@/atoms/presentation'
import { normalizePresentationProject, presentationProjectOf } from '../project'
import { presentationProjectSchema } from '../schema'

export function validatePresentationDocument(document: PresentationDocument): PresentationDocument {
  const normalized = normalizePresentationProject(document)
  const parsed = presentationProjectSchema.safeParse(presentationProjectOf(normalized))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const location = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new Error(`Invalid PowerPoint project${location}: ${issue?.message ?? 'unknown model error'}`)
  }
  return normalized
}

/** The single content mutation gate shared by canvas edits and Agent commands. */
export function editPresentationDocument(previous: PresentationDocument, next: PresentationDocument, contentChanged = true): PresentationDocument {
  if (next.id !== previous.id) throw new Error('A presentation edit cannot replace the active project identity')
  const normalized = normalizePresentationProject({
    ...next,
    revision: contentChanged ? previous.revision + 1 : previous.revision,
  })
  return validatePresentationDocument(normalized)
}
