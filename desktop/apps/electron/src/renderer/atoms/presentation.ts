import { atom } from 'jotai'
import { viewedSessionIdAtom } from './navigation'

export const PRESENTATION_WIDTH = 1280
export const PRESENTATION_HEIGHT = 720

export type PresentationAnimationEffect = 'none' | 'appear' | 'fade' | 'flyIn' | 'zoom'
export type PresentationTransition = 'none' | 'fade' | 'push' | 'wipe'

export interface PresentationElementBase {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  animation?: PresentationAnimationEffect
  animationDuration?: number
}

export interface PresentationTextElement extends PresentationElementBase {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: 400 | 500 | 600 | 700
  italic?: boolean
  underline?: boolean
  color: string
  align: 'left' | 'center' | 'right'
}

export interface PresentationShapeElement extends PresentationElementBase {
  type: 'rect' | 'ellipse'
  fill: string
  borderColor: string
  borderWidth: number
  radius?: number
}

export type PresentationElement = PresentationTextElement | PresentationShapeElement

export interface PresentationSlide {
  id: string
  name: string
  background: string
  elements: PresentationElement[]
  notes?: string
  transition?: PresentationTransition
}

export interface PresentationDocument {
  title: string
  slides: PresentationSlide[]
  selectedSlideId: string
}

type SessionStateUpdate<T> = T | ((current: T) => T)

let generatedId = 0

export function createPresentationId(prefix: string): string {
  generatedId += 1
  return `${prefix}-${Date.now().toString(36)}-${generatedId.toString(36)}`
}

export function createBlankPresentationSlide(name: string): PresentationSlide {
  return {
    id: createPresentationId('slide'),
    name,
    background: '#FFFFFF',
    elements: [],
    notes: '',
    transition: 'none',
  }
}

export function createInitialPresentationDocument(): PresentationDocument {
  const titleSlideId = createPresentationId('slide')
  const overviewSlideId = createPresentationId('slide')
  const keyPoints = [
    ['01', 'Frame the idea', 'Start with the tension your audience already feels.', '#6957D9'],
    ['02', 'Make it tangible', 'Use one memorable proof point to earn attention.', '#DF6C47'],
    ['03', 'Create momentum', 'End with a decision that is easy to understand.', '#2F8B78'],
  ] as const
  return {
    title: 'Ideas that move forward',
    selectedSlideId: titleSlideId,
    slides: [
      {
        id: titleSlideId,
        name: 'Cover',
        background: '#17182B',
        elements: [
          {
            id: createPresentationId('shape'),
            type: 'rect',
            x: 88,
            y: 82,
            width: 116,
            height: 12,
            rotation: 0,
            fill: '#8B7CFF',
            borderColor: '#8B7CFF',
            borderWidth: 0,
            radius: 6,
          },
          {
            id: createPresentationId('text'),
            type: 'text',
            x: 88,
            y: 158,
            width: 1040,
            height: 170,
            rotation: 0,
            text: 'Ideas that\nmove forward',
            fontSize: 64,
            fontFamily: 'Aptos Display',
            fontWeight: 700,
            color: '#FFFFFF',
            align: 'left',
          },
          {
            id: createPresentationId('text'),
            type: 'text',
            x: 92,
            y: 375,
            width: 760,
            height: 72,
            rotation: 0,
            text: 'Turn a clear point of view into a compelling story.',
            fontSize: 25,
            fontFamily: 'Aptos',
            fontWeight: 400,
            color: '#B7B9D5',
            align: 'left',
          },
          {
            id: createPresentationId('text'),
            type: 'text',
            x: 92,
            y: 614,
            width: 420,
            height: 34,
            rotation: 0,
            text: 'BRIDGIC PRESENTATION',
            fontSize: 14,
            fontFamily: 'Aptos',
            fontWeight: 600,
            color: '#8B7CFF',
            align: 'left',
          },
        ],
      },
      {
        id: overviewSlideId,
        name: 'Key points',
        background: '#F7F6F2',
        elements: [
          {
            id: createPresentationId('text'),
            type: 'text',
            x: 82,
            y: 70,
            width: 1050,
            height: 72,
            rotation: 0,
            text: 'One story. Three essential moves.',
            fontSize: 42,
            fontFamily: 'Aptos Display',
            fontWeight: 700,
            color: '#1D1D28',
            align: 'left',
          },
          ...keyPoints.flatMap(([number, heading, body, accent], index): PresentationElement[] => {
            const x = 82 + (index * 390)
            return [
              {
                id: createPresentationId('shape'),
                type: 'rect',
                x,
                y: 205,
                width: 350,
                height: 365,
                rotation: 0,
                fill: '#FFFFFF',
                borderColor: '#E2E0D8',
                borderWidth: 1,
                radius: 20,
              },
              {
                id: createPresentationId('text'),
                type: 'text',
                x: x + 30,
                y: 240,
                width: 80,
                height: 45,
                rotation: 0,
                text: number,
                fontSize: 20,
                fontFamily: 'Aptos',
                fontWeight: 700,
                color: accent,
                align: 'left',
              },
              {
                id: createPresentationId('text'),
                type: 'text',
                x: x + 30,
                y: 326,
                width: 285,
                height: 70,
                rotation: 0,
                text: heading,
                fontSize: 28,
                fontFamily: 'Aptos Display',
                fontWeight: 700,
                color: '#1D1D28',
                align: 'left',
              },
              {
                id: createPresentationId('text'),
                type: 'text',
                x: x + 30,
                y: 430,
                width: 285,
                height: 88,
                rotation: 0,
                text: body,
                fontSize: 18,
                fontFamily: 'Aptos',
                fontWeight: 400,
                color: '#666571',
                align: 'left',
              },
            ]
          }),
        ],
      },
    ],
  }
}

const fallbackPresentationDocument = createInitialPresentationDocument()
const presentationDocumentsBySessionAtom = atom<ReadonlyMap<string, PresentationDocument>>(new Map())
const expandedPresentationSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** The viewed Session's editable presentation document. */
export const currentPresentationDocumentAtom = atom(
  (get) => {
    const sessionId = get(viewedSessionIdAtom)
    return sessionId
      ? get(presentationDocumentsBySessionAtom).get(sessionId) ?? fallbackPresentationDocument
      : fallbackPresentationDocument
  },
  (get, set, update: SessionStateUpdate<PresentationDocument>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(currentPresentationDocumentAtom)
    const next = typeof update === 'function' ? update(current) : update
    const documents = new Map(get(presentationDocumentsBySessionAtom))
    documents.set(sessionId, next)
    set(presentationDocumentsBySessionAtom, documents)
  },
)

/** Whether the viewed Session's presentation owns the work area. */
export const presentationExpandedAtom = atom(
  (get) => {
    const sessionId = get(viewedSessionIdAtom)
    return sessionId ? get(expandedPresentationSessionsAtom).has(sessionId) : false
  },
  (get, set, update: SessionStateUpdate<boolean>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(expandedPresentationSessionsAtom)
    const isExpanded = current.has(sessionId)
    const next = typeof update === 'function' ? update(isExpanded) : update
    if (next === isExpanded) return
    const sessions = new Set(current)
    if (next) sessions.add(sessionId)
    else sessions.delete(sessionId)
    set(expandedPresentationSessionsAtom, sessions)
  },
)

/** Drop presentation state when its owning Session is deleted. */
export const purgePresentationSessionAtom = atom(null, (get, set, sessionId: string) => {
  const documents = get(presentationDocumentsBySessionAtom)
  if (documents.has(sessionId)) {
    const nextDocuments = new Map(documents)
    nextDocuments.delete(sessionId)
    set(presentationDocumentsBySessionAtom, nextDocuments)
  }
  const expandedSessions = get(expandedPresentationSessionsAtom)
  if (expandedSessions.has(sessionId)) {
    const nextExpandedSessions = new Set(expandedSessions)
    nextExpandedSessions.delete(sessionId)
    set(expandedPresentationSessionsAtom, nextExpandedSessions)
  }
})
