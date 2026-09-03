import type { PresentationChapterOutline } from '@shared/types'
import { atom } from 'jotai'
import { prepareInteractionContinuationAtom } from './agent'
import { markSessionAnsweredAtom } from './sessions'

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
          source_ids: slide.sourceIds,
        })),
      })),
    })
  },
)
