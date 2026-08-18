import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { PermissionApproval } from '@/components/permissions'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'

export type CompletedInteractionBlock = Extract<
  MessageBlock,
  { type: 'confirmation' | 'permission' | 'build_confirm' | 'task_confirm' | 'workflow_confirm' }
>

/** Keep system-owned AC ids in data while presenting friendly copy in chat UI. */
export function humanizeAcceptanceRuleText(text: string): string {
  return text
    .replace(/(^|\n)(?:\s*AC[-_ ]?\d+\s*[:：.)、-]\s*)+/gim, '$1')
    .trim()
}

/** Read-only detail card for one completed human interaction. */
export function CompletedInteractionCard({ block, sessionId }: { block: CompletedInteractionBlock; sessionId?: string }) {
  const { t } = useTranslation()
  if (block.type === 'permission') {
    return (
      <PermissionApproval
        items={block.items}
        questions={block.questions}
        requestId={block.requestId}
        decided
        sessionId={sessionId}
      />
    )
  }

  if (block.type === 'confirmation') {
    if (
      block.kind === 'accept_rule_message' ||
      block.kind === 'confirmation_message'
    ) {
      const acceptanceReply = block.kind === 'accept_rule_message'
      return (
        <div className="max-w-xl overflow-hidden rounded-lg border border-status-warning/30 bg-bg-elevated shadow-sm">
          <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-status-warning-bg text-status-warning">
              {Icons.chat(15)}
            </span>
            <div>
              <div className="text-sm font-semibold text-text-primary">
                {acceptanceReply
                  ? t('session.interaction.card.acceptRuleDeferredTitle')
                  : t('session.interaction.label.replied', { question: block.question })}
              </div>
              <div className="text-xs text-text-tertiary">{t('session.interaction.card.newMessageDesc')}</div>
            </div>
          </div>
          <div className="px-3.5 py-3.5">
            <div className="mb-1 text-xs font-semibold text-text-tertiary">{t('session.interaction.card.newMessageLabel')}</div>
            <MarkdownMessage content={block.response} className="text-sm leading-6 text-text-primary" />
          </div>
        </div>
      )
    }
    if (block.kind === 'accept_rule') {
      if (block.acceptanceMode === 'execution_only') {
        return (
          <div className="max-w-xl overflow-hidden rounded-lg border border-brand-blue/30 bg-bg-elevated shadow-sm">
            <div className="flex items-center gap-2.5 px-3.5 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
                {Icons.workflowResult(16)}
              </span>
              <div>
                <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.noAcceptanceTitle')}</div>
                <div className="text-xs text-text-tertiary">{t('session.interaction.card.noAcceptanceDesc')}</div>
              </div>
            </div>
          </div>
        )
      }
      const rules = block.rules?.length
        ? block.rules
        : block.response
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
              const matched = line.match(/^(AC-\d{3})\s*[:：]\s*(.+)$/)
              return matched
                ? { id: matched[1]!, text: matched[2]! }
                : { id: `AC-${String(index + 1).padStart(3, '0')}`, text: line }
            })
      return (
        <div className="max-w-xl overflow-hidden rounded-lg border border-brand-blue/30 bg-bg-elevated shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
                {Icons.workflowResult(16)}
              </span>
              <div>
                <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.acceptanceTitle')}</div>
                <div className="text-xs text-text-tertiary">{t('session.interaction.card.acceptanceDesc')}</div>
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-status-success-bg px-2 py-1 text-xs font-semibold text-status-success">
              {Icons.check(11)} {t('session.interaction.card.acceptanceCount', { n: rules.length })}
            </span>
          </div>
          <ol aria-label={t('session.interaction.card.acceptanceTitle')} className="max-h-[420px] divide-y divide-border-subtle overflow-y-auto">
            {rules.map((rule, index) => (
              <li key={rule.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 px-3.5 py-3.5">
                <span className="mt-0.5 inline-flex h-6 items-center justify-center rounded-md bg-accent-blue-subtle px-2 text-xs font-semibold text-text-accent">
                  {t('session.interaction.card.ruleBadge', { n: index + 1 })}
                </span>
                <MarkdownMessage
                  content={humanizeAcceptanceRuleText(rule.text)}
                  className="min-w-0 text-sm leading-6 text-text-primary"
                />
              </li>
            ))}
          </ol>
        </div>
      )
    }
    const pairQuestionsAndAnswers = (): Array<{ question: string; answer: string }> => {
      const questions = block.question.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean)
      const response = block.response.trim()
      if (questions.length <= 1) {
        return [{ question: questions[0] ?? block.question.trim(), answer: response }]
      }

      const pairs: Array<{ question: string; answer: string }> = []
      let remaining = response
      for (const [index, question] of questions.entries()) {
        const prefix = [`${question}:`, `${question}：`].find((value) => remaining.startsWith(value))
        if (!prefix) break
        remaining = remaining.slice(prefix.length).trimStart()

        const nextQuestion = questions[index + 1]
        if (!nextQuestion) {
          pairs.push({ question, answer: remaining.trim() })
          remaining = ''
          continue
        }
        const nextOffsets = [`\n${nextQuestion}:`, `\n${nextQuestion}：`]
          .map((marker) => remaining.indexOf(marker))
          .filter((offset) => offset >= 0)
        if (nextOffsets.length === 0) break
        const nextOffset = Math.min(...nextOffsets)
        pairs.push({ question, answer: remaining.slice(0, nextOffset).trim() })
        remaining = remaining.slice(nextOffset + 1)
      }
      if (pairs.length === questions.length && !remaining) return pairs

      const responseLines = response.split('\n').map((value) => value.trim()).filter(Boolean)
      if (responseLines.length === questions.length) {
        return questions.map((question, index) => {
          const line = responseLines[index] ?? ''
          const prefix = [`${question}:`, `${question}：`].find((value) => line.startsWith(value))
          return { question, answer: prefix ? line.slice(prefix.length).trim() : line }
        })
      }
      return [{ question: block.question.trim(), answer: response }]
    }
    const pairs = pairQuestionsAndAnswers()

    return (
      <div className="max-w-xl overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-sm">
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
            {Icons.chat(15)}
          </span>
          <div>
            <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.qaTitle')}</div>
            <div className="text-xs text-text-tertiary">{t('session.interaction.card.qaDesc')}</div>
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {block.prompt && (
            <section aria-label={t('session.interaction.card.contextLabel')} className="border-b border-border-subtle px-3.5 py-3">
              <MarkdownMessage content={block.prompt} density="compact" className="text-sm text-text-secondary" />
            </section>
          )}
          <ol aria-label={t('session.interaction.card.qaListLabel')} className="divide-y divide-border-subtle">
            {pairs.map((pair, index) => (
              <li key={`${index}:${pair.question}`} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 px-3.5 py-3.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-hover text-2xs font-semibold text-text-secondary">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="mb-1 text-xs font-semibold text-text-tertiary">{t('session.interaction.card.questionLabel')}</div>
                  <MarkdownMessage content={pair.question} className="text-sm leading-6 text-text-primary" />
                  <div className="mt-2.5 border-l-2 border-status-success pl-3">
                    <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-status-success">
                      {Icons.check(11)} {t('session.interaction.card.answerLabel')}
                    </div>
                    <MarkdownMessage content={pair.answer} className="text-sm leading-6 text-text-primary" />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    )
  }

  if (block.type === 'build_confirm') {
    const cancelled = block.status === 'cancelled'
    return (
      <div className="max-w-xl overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-purple-subtle text-text-accent-purple">
              {Icons.workflow(15)}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.buildTitle')}</div>
              <div className="text-xs text-text-tertiary">{t('session.interaction.card.buildDesc')}</div>
            </div>
          </div>
          <span className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold',
            cancelled ? 'bg-bg-hover text-text-tertiary' : 'bg-status-success-bg text-status-success',
          )}>
            {cancelled ? Icons.x(11) : Icons.check(11)}
            {cancelled ? t('session.interaction.card.buildOnceBadge') : t('session.interaction.card.buildConfirmedBadge')}
          </span>
        </div>
        <div className="px-3.5 py-3">
          <MarkdownMessage content={block.goal} density="compact" className="text-sm leading-6 text-text-primary" />
          {block.reason && (
            <MarkdownMessage content={block.reason} density="compact" className="mt-1 text-xs leading-5 text-text-tertiary" />
          )}
        </div>
      </div>
    )
  }

  if (block.type === 'task_confirm') {
    const revised = block.status === 'revision_requested'
    return (
      <div className="max-w-xl overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-text-accent">
              {Icons.file(15)}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.taskTitle')}</div>
              <div className="text-xs text-text-tertiary">task.md</div>
            </div>
          </div>
          <span className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold',
            revised
              ? 'bg-status-warning-bg text-status-warning'
              : 'bg-status-success-bg text-status-success',
          )}>
            {revised ? Icons.edit(11) : Icons.check(11)}
            {revised ? t('session.interaction.card.taskRevisedBadge') : t('session.common.confirmed')}
          </span>
        </div>
        {revised && block.feedback && (
          <div className="border-b border-border-subtle bg-status-warning-bg px-3.5 py-2.5 text-sm leading-6 text-text-secondary">
            <span className="font-semibold text-status-warning">{t('session.interaction.card.feedbackLabel')}</span>{block.feedback}
          </div>
        )}
        <div className="max-h-72 overflow-auto p-3.5">
          <MarkdownMessage content={block.taskMarkdown} className="text-sm leading-6 text-text-primary" />
        </div>
      </div>
    )
  }

  const cancelled = block.status === 'cancelled'
  const workflowName = block.name || block.defaultName
  return (
    <div className="max-w-xl overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated shadow-sm">
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-purple-subtle text-text-accent-purple">
            {Icons.workflow(15)}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">{t('session.interaction.card.workflowTitle')}</div>
            <div className="truncate text-xs text-text-tertiary">{workflowName}</div>
          </div>
        </div>
        <span className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold',
          cancelled ? 'bg-bg-hover text-text-tertiary' : 'bg-status-success-bg text-status-success',
        )}>
          {cancelled ? Icons.x(11) : Icons.check(11)}
          {cancelled ? t('session.common.cancelled') : t('session.common.saved')}
        </span>
      </div>
      {block.summary && (
        <div className="border-t border-border-subtle px-3.5 py-3">
          <MarkdownMessage content={block.summary} density="compact" className="text-sm leading-6 text-text-secondary" />
        </div>
      )}
    </div>
  )
}
