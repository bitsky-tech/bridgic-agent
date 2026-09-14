import { LoaderCircle, MessageSquare } from 'lucide-react'
import { useI18n } from '../i18n'
import type { ExperimentSession } from './experiment-state'
import './session-history.css'

export function SessionHistoryItem({ session, active, onSelect }: {
  session: ExperimentSession
  active: boolean
  onSelect: () => void
}) {
  const { locale, t } = useI18n()
  const status = session.status === 'awaiting' ? t('experiments.awaitingInput')
    : session.status === 'running' ? t('experiments.simulating')
      : session.status === 'cancelled' ? t('experiments.stopped') : t('experiments.simulationComplete')
  return <button type="button" className={`dbg-session-item-select ${active ? 'is-active' : ''}`}
    aria-current={active ? 'true' : undefined} title={session.input} onClick={onSelect}>
    {session.status === 'running' ? <LoaderCircle className="dbg-spin" size={14} /> : <MessageSquare size={14} />}
    <span><strong>{session.input}</strong><small className={session.status === 'awaiting' ? 'is-waiting' : undefined}>
      {new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(session.createdAt)} · {status}
      {session.turns.length > 1 && <> · {session.turns.length}{t('experiments.executions')}</>}
    </small></span>
  </button>
}
