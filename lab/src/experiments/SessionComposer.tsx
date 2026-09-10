import { useId, useRef, useState } from 'react'
import { ArrowUp, LoaderCircle, Square } from 'lucide-react'
import { useI18n } from '../i18n'
import type { DemoScenario } from './demo-data'
import type { ExperimentSession } from './experiment-state'
import './session-composer.css'

export function SessionComposer({ session, scenario, blockedByOtherRun, onDraftChange, onSend, onStop }: {
  session: ExperimentSession
  scenario: DemoScenario
  blockedByOtherRun: boolean
  onDraftChange: (input: string) => void
  onSend: (continuation: 'reassess' | 'continue') => void
  onStop: () => void
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const [continuation, setContinuation] = useState<'reassess' | 'continue'>('reassess')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const running = session.status === 'running'
  const canSend = !!session.draft.trim() && !running && !blockedByOtherRun
  const currentStage = scenario.stages[Math.min(session.completedStages, scenario.stages.length - 1)]!
  const status = running ? t('演示中', 'Simulating') : session.status === 'cancelled' ? t('已停止，可追加消息', 'Stopped · send a follow-up')
    : session.status === 'awaiting' ? t('等待用户，可补充要求', 'Awaiting user · add instructions') : t('本轮完成，可继续测试', 'Complete · continue this test')

  function send() {
    if (!canSend) return
    onSend(continuation)
    inputRef.current?.focus()
  }

  return <form className="session-composer" aria-label={t('会话消息', 'Session message')} onSubmit={event => { event.preventDefault(); send() }}>
    <div className="session-composer-status" role="status">
      {running && <LoaderCircle className="dbg-spin" size={12} />}
      <span>{t(`第 ${session.turns.length} 次执行`, `Execution ${session.turns.length}`)} · {status}</span>
      {running && <span>{currentStage.title}</span>}
    </div>
    <div className="session-composer-box">
      <label className="session-composer-label" htmlFor={inputId}>{t('追加消息', 'Follow-up message')}</label>
      <textarea ref={inputRef} id={inputId} rows={2} maxLength={10000} value={session.draft}
        placeholder={running ? t('可以先写补充要求，停止后发送…', 'Draft instructions to send after stopping…') : t('输入补充要求，继续这个测试…', 'Add instructions to continue this test…')}
        onChange={event => onDraftChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
        }} />
      <div className="session-composer-actions">
        <label>{t('下一轮（模拟）', 'Next execution (mock)')}
          <select value={continuation} onChange={event => setContinuation(event.target.value as 'reassess' | 'continue')} disabled={running}>
            <option value="reassess">{t('重新评估需求', 'Reassess requirements')}</option>
            <option value="continue">{session.status === 'completed' ? t('从最后阶段重试', 'Retry the final stage') : t('从上次阶段继续', 'Continue from the last stage')}</option>
          </select>
        </label>
        {running ? <button type="button" className="dbg-button session-stop" onClick={() => { onStop(); inputRef.current?.focus() }}><Square size={11} fill="currentColor" />{t('停止', 'Stop')}</button>
          : <button type="submit" className="dbg-button dbg-primary" disabled={!canSend}><ArrowUp size={15} />{t('发送并运行', 'Send & run')}</button>}
      </div>
    </div>
    {blockedByOtherRun && <p className="session-composer-blocked">{t('此模式还有其他测试正在执行，结束后即可发送。草稿会保留。', 'Another test in this mode is running. Your draft is kept until you can send it.')}</p>}
  </form>
}
