import { LoaderCircle, MessageSquare } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ExperimentSession } from './experiment-state'
import './session-history.css'

export function SessionHistoryItem({ session, active, onSelect }: {
  session: ExperimentSession
  active: boolean
  onSelect: () => void
}) {
  const { locale } = useI18n()
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const status = session.status === 'awaiting' ? t('等待输入', 'Awaiting input')
    : session.status === 'running' ? t('演示中', 'Simulating')
      : session.status === 'cancelled' ? t('已停止', 'Stopped') : t('演示完成', 'Simulation complete')
  return <button type="button" className={`dbg-session-item-select ${active ? 'is-active' : ''}`}
    aria-current={active ? 'true' : undefined} title={session.input} onClick={onSelect}>
    {session.status === 'running' ? <LoaderCircle className="dbg-spin" size={14} /> : <MessageSquare size={14} />}
    <span><strong>{session.input}</strong><small className={session.status === 'awaiting' ? 'is-waiting' : undefined}>
      {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(session.createdAt)} · {status}
      {session.turns.length > 1 && <> · {session.turns.length}{t(' 次执行', ' executions')}</>}
    </small></span>
  </button>
}
