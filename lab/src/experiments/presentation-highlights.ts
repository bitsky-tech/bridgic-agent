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
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const interactions: PresentationInteractionHighlight[] = []
  const artifacts = new Map<PresentationArtifactHighlight['id'], PresentationArtifactHighlight>()
  const stageLabels: Record<PresentationTraceRound['stage'], string> = {
    main: t('主流程', 'Main flow'),
    ppt_brief: t('明确需求', 'Clarify requirements'),
    ppt_plan: t('规划页面', 'Plan slides'),
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
          const header = asText(question.header) ?? t(`问题 ${index + 1}`, `Question ${index + 1}`)
          const id = asText(question.id) ?? `${call.id}-question-${index + 1}`
          // The recorded demo omits question IDs and returns these two named fields.
          const field = asText(question.id) ?? ({ '受众': 'audience', Audience: 'audience', '使用方式': 'reading_mode', Format: 'reading_mode' } as Record<string, string>)[header] ?? id
          const answerValue = asText(asRecord(result.answers)[field]) ?? asText(result[field])
          const options = Array.isArray(question.options) ? question.options : []
          const selected = options.find(option => asRecord(option).value === answerValue)
          const answer = asText(asRecord(selected).label) ?? (field === 'reading_mode' && answerValue === 'self_paced' ? t('自主阅读', 'Self-paced reading') : answerValue)
          return {
            id,
            header,
            question: asText(question.question) ?? header,
            options: options.map(option => asText(option) ?? asText(asRecord(option).label)).filter((label): label is string => label !== null),
            answer,
          }
        })
        const answered = result.confirmed === true || (result.confirmed !== false && questions.length > 0 && questions.every(question => question.answer !== null))
        const answers = questions.filter(question => question.answer !== null).map(question => `${question.header}${t('：', ': ')}${question.answer}`)
        interactions.push({
          ...origin,
          id: `${round.id}-${call.id}`,
          kind: 'human-choice',
          toolName: call.name,
          title: round.title,
          prompt: asText(call.arguments.prompt) ?? '',
          questions,
          summary: answers.join(t('；', '; ')) || (answered ? t('用户已回应，未记录具体答案', 'User responded; answer details were not recorded') : t('等待用户回答', 'Waiting for the user to answer')),
          status: answered ? 'answered' : 'waiting',
        })
      }

      const filePath = asText(result.file_path) ?? asText(result.path) ?? asText(call.arguments.file_path) ?? asText(call.arguments.path)
      if (call.name === 'write_file' && result.written === true && filePath?.split('/').at(-1) === 'brief.md') {
        artifacts.set('brief', { ...origin, id: 'brief', title: t('需求简报', 'Presentation brief'), detail: t('Agent 整理的受众、目标与制作约束', 'Audience, goals, and constraints organized by the agent'), format: 'file', path: filePath })
      }

      if (call.name !== 'report_presentation_step') continue
      const data = asRecord(call.arguments.data)
      const chapters = (Array.isArray(data.chapters) ? data.chapters : []).map((raw, index) => {
        const chapter = asRecord(raw)
        return { title: asText(chapter.title) ?? t(`第 ${index + 1} 章`, `Chapter ${index + 1}`), slideCount: Array.isArray(chapter.slides) ? chapter.slides.length : 0 }
      })
      const slideCount = chapters.reduce((count, chapter) => count + chapter.slideCount, 0)
      const outlineDetail = t(`${chapters.length} 章 · ${slideCount} 页`, `${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'} · ${slideCount} ${slideCount === 1 ? 'slide' : 'slides'}`)
      if (result.status === 'awaiting_outline_confirmation') {
        interactions.push({
          ...origin,
          id: `${round.id}-${call.id}`,
          kind: 'presentation-outline',
          toolName: call.name,
          title: t('大纲确认', 'Outline confirmation'),
          summary: Array.isArray(data.chapters) ? outlineDetail : t('已提交大纲，等待用户确认', 'Outline submitted; waiting for user approval'),
          status: 'waiting',
          chapters,
        })
      }
      if (result.accepted !== true) continue
      if (Array.isArray(data.chapters)) {
        artifacts.set('outline', { ...origin, id: 'outline', title: t('逐页大纲', 'Slide outline'), detail: outlineDetail, format: 'structured' })
      }
      if (Array.isArray(data.sources)) {
        const sources = data.sources.map(asRecord).filter(source => source.kind === 'web')
        const verified = sources.filter(source => source.status === 'available').length
        artifacts.set('sources', { ...origin, id: 'sources', title: t('资料与引用', 'Sources and citations'), detail: t(`${sources.length} 组参考线索 · ${verified} 组已核验`, `${sources.length} reference ${sources.length === 1 ? 'lead' : 'leads'} · ${verified} verified`), format: 'structured' })
      }
    }
  }
  return { interactions, artifacts: [...artifacts.values()] }
}
