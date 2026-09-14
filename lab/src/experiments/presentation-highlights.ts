import { createTranslator } from '../i18n'
import type { PresentationTrace, PresentationTraceRound } from './presentation-trace-data'

export interface PresentationChoiceQuestion {
  id: string
  header: string
  question: string
  options: string[]
  answer: string | null
}

interface PresentationInteractionBase {
  id: string
  roundId: string
  stageId: PresentationTraceRound['stage']
  stageLabel: string
  title: string
  summary: string
  status: 'answered' | 'waiting'
  toolName: string
}

export type PresentationInteractionHighlight = PresentationInteractionBase & (
  | { kind: 'human-choice'; prompt: string; questions: PresentationChoiceQuestion[] }
  | { kind: 'presentation-outline'; chapters: Array<{ title: string; slideCount: number }> }
)

export interface PresentationArtifactHighlight {
  id: 'brief' | 'outline' | 'sources'
  roundId: string
  stageId: PresentationTraceRound['stage']
  stageLabel: string
  title: string
  detail: string
  format: 'file' | 'structured'
  path?: string
}

export interface PresentationHighlights {
  interactions: PresentationInteractionHighlight[]
  artifacts: PresentationArtifactHighlight[]
}

function parseValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = parseValue(value)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function getPresentationHighlights(trace: PresentationTrace, locale: 'zh-CN' | 'en-US'): PresentationHighlights {
  const t = createTranslator(locale)
  const interactions: PresentationInteractionHighlight[] = []
  const artifacts = new Map<PresentationArtifactHighlight['id'], PresentationArtifactHighlight>()
  const stageLabels: Record<PresentationTraceRound['stage'], string> = {
    main: t('experiments.mainFlow'),
    ppt_brief: t('experiments.clarifyRequirements'),
    ppt_plan: t('experiments.planSlides'),
  }

  for (const round of trace.rounds) {
    const origin = { roundId: round.id, stageId: round.stage, stageLabel: stageLabels[round.stage] }
    for (const call of round.calls) {
      const result = call.status === 'success' ? asRecord(call.result) : {}
      if (call.name === 'request_human_choice' && call.status === 'success') {
        const parsedQuestions = parseValue(call.arguments.questions)
        const rawQuestions = Array.isArray(parsedQuestions) ? parsedQuestions : asRecord(parsedQuestions).questions
        const questions: PresentationChoiceQuestion[] = (Array.isArray(rawQuestions) ? rawQuestions : []).map((raw, index) => {
          const question = asRecord(raw)
          const header = asText(question.header) ?? t('experiments.questionOrdinal', { ordinal: index + 1 })
          const id = asText(question.id) ?? `${call.id}-question-${index + 1}`
          // The recorded demo omits question IDs and returns these two named fields.
          const field = asText(question.id) ?? ({ '受众': 'audience', Audience: 'audience', '使用方式': 'reading_mode', Format: 'reading_mode' } as Record<string, string>)[header] ?? id
          const answerValue = asText(asRecord(result.answers)[field]) ?? asText(result[field])
          const options = Array.isArray(question.options) ? question.options : []
          const selected = options.find(option => asRecord(option).value === answerValue)
          const answer = asText(asRecord(selected).label) ?? (field === 'reading_mode' && answerValue === 'self_paced' ? t('experiments.selfPacedReading') : answerValue)
          return {
            id,
            header,
            question: asText(question.question) ?? header,
            options: options.map(option => asText(option) ?? asText(asRecord(option).label)).filter((label): label is string => label !== null),
            answer,
          }
        })
        const answered = result.confirmed === true || (result.confirmed !== false && questions.length > 0 && questions.every(question => question.answer !== null))
        const answers = questions.filter(question => question.answer !== null).map(question => `${question.header}${t('experiments.answerSeparator')}${question.answer}`)
        interactions.push({
          ...origin,
          id: `${round.id}-${call.id}`,
          kind: 'human-choice',
          toolName: call.name,
          title: round.title,
          prompt: asText(call.arguments.prompt) ?? '',
          questions,
          summary: answers.join(t('experiments.questionSeparator')) || (answered ? t('experiments.userRespondedAnswerDetailsWereNotRecorded') : t('experiments.waitingForTheUserToAnswer')),
          status: answered ? 'answered' : 'waiting',
        })
      }

      const filePath = asText(result.file_path) ?? asText(result.path) ?? asText(call.arguments.file_path) ?? asText(call.arguments.path)
      if (call.name === 'write_file' && result.written === true && filePath?.split('/').at(-1) === 'brief.md') {
        artifacts.set('brief', { ...origin, id: 'brief', title: t('experiments.presentationBrief'), detail: t('experiments.audienceGoalsAndConstraintsOrganizedByTheAgent'), format: 'file', path: filePath })
      }

      if (call.name !== 'report_presentation_step') continue
      const data = asRecord(call.arguments.data)
      const chapters = (Array.isArray(data.chapters) ? data.chapters : []).map((raw, index) => {
        const chapter = asRecord(raw)
        return { title: asText(chapter.title) ?? t('experiments.chapterOrdinal', { ordinal: index + 1 }), slideCount: Array.isArray(chapter.slides) ? chapter.slides.length : 0 }
      })
      const slideCount = chapters.reduce((count, chapter) => count + chapter.slideCount, 0)
      const outlineDetail = `${chapters.length} ${t(chapters.length === 1 ? 'experiments.chapter' : 'experiments.chapters')} · ${slideCount} ${t(slideCount === 1 ? 'experiments.slide' : 'experiments.slides')}`
      if (result.status === 'awaiting_outline_confirmation') {
        interactions.push({
          ...origin,
          id: `${round.id}-${call.id}`,
          kind: 'presentation-outline',
          toolName: call.name,
          title: t('experiments.outlineConfirmation'),
          summary: Array.isArray(data.chapters) ? outlineDetail : t('experiments.outlineSubmittedWaitingForUserApproval'),
          status: 'waiting',
          chapters,
        })
      }
      if (result.accepted !== true) continue
      if (Array.isArray(data.chapters)) {
        artifacts.set('outline', { ...origin, id: 'outline', title: t('experiments.slideOutline'), detail: outlineDetail, format: 'structured' })
      }
      if (Array.isArray(data.sources)) {
        const sources = data.sources.map(asRecord).filter(source => source.kind === 'web')
        const verified = sources.filter(source => source.status === 'available').length
        artifacts.set('sources', { ...origin, id: 'sources', title: t('experiments.sourcesAndCitations'), detail: sources.length === 1 ? t('experiments.countReferenceLeadVerifiedVerified', { count: sources.length, verified }) : t('experiments.countReferenceLeadsVerifiedVerified', { count: sources.length, verified }), format: 'structured' })
      }
    }
  }
  return { interactions, artifacts: [...artifacts.values()] }
}
