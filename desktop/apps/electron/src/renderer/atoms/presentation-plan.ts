import type { PresentationChapterOutline } from '@shared/types'
import { atom } from 'jotai'
import {
  prepareInteractionContinuationAtom,
  updatePresentationOutlineConfirmBlockAtom,
  updatePresentationTemplateSelectionBlockAtom,
} from './agent'
import { markSessionAnsweredAtom } from './sessions'

export type { PresentationPaneView } from './presentation'
export {
  presentationPaneViewFamily,
  presentationTemplateSelectionFamily,
} from './presentation'

/** Resume a parked Plan Turn with the outline edited in the presentation pane. */
export const respondPresentationOutlineAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      chapters: PresentationChapterOutline[]
    },
  ) => {
    set(updatePresentationOutlineConfirmBlockAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      patch: { status: 'confirmed' },
    })
    set(prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)
    const connection = await import('@/lib/amphiWsConnection')
    connection.getAmphiWsConnection().presentationOutlineConfirm(payload.sessionId, {
      request_id: payload.requestId,
      chapters: payload.chapters.map(chapter => ({
        id: chapter.id,
        title: chapter.title,
        summary: chapter.summary,
        slides: chapter.slides.map(slide => ({
          id: slide.id,
          title: slide.title,
          purpose: slide.purpose,
          key_message: slide.keyMessage,
          content_outline: slide.contentOutline,
          source_ids: slide.sourceIds,
        })),
      })),
    })
  },
)

/** Resume a parked Plan Turn with the user's template decision. */
export const respondPresentationTemplateAtom = atom(
  null,
  async (
    _get,
    set,
    payload: {
      sessionId: string
      requestId: string
      action: 'select' | 'skip' | 'refresh'
      templateId?: string
    },
  ) => {
    let status: 'selected' | 'skipped' | 'refresh_requested' = 'refresh_requested'
    if (payload.action === 'select') status = 'selected'
    else if (payload.action === 'skip') status = 'skipped'
    set(updatePresentationTemplateSelectionBlockAtom, {
      sessionId: payload.sessionId,
      requestId: payload.requestId,
      patch: {
        status,
        selectedTemplateId: payload.templateId ?? null,
      },
    })
    set(prepareInteractionContinuationAtom, { sessionId: payload.sessionId })
    set(markSessionAnsweredAtom, payload.sessionId)
    const connection = await import('@/lib/amphiWsConnection')
    connection.getAmphiWsConnection().presentationTemplateSelection(payload.sessionId, {
      request_id: payload.requestId,
      action: payload.action,
      ...(payload.templateId ? { template_id: payload.templateId } : {}),
    })
  },
)
