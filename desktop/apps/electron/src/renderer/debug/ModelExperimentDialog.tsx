import { useEffect, useId, useRef, type ReactNode } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { ModalBackdrop } from '@/components/amphi/ModalBackdrop'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import type { DebugModelRequest } from '@shared/debug-model-types'
import { useDebugText } from './DebugSessionProvider'
import { ModelRequestEditor } from './ModelRequestEditor'
import { roundLabel, turnLabel } from './TraceParts'
import type { TraceRound } from './types'

export function ModelExperimentDialog({ round, request, running, onRun, onClose, children }: {
  round: TraceRound; request: DebugModelRequest; running: boolean; onRun: (draft: Record<string, unknown>) => void
  onClose: () => void; children: ReactNode
}) {
  const text = useDebugText()
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useEscapeToClose(onClose)
  useEffect(() => {
    const previous = document.activeElement
    closeButton.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <ModalBackdrop onClose={onClose}>
    <div ref={dialog} className="debug-experiment-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, summary, [tabindex="0"]') ?? [])]
          .filter(item => item.getClientRects().length > 0)
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <header className="debug-experiment-heading">
        <span className="debug-experiment-icon"><FlaskConical size={20} /></span>
        <div><h2 id={titleId}>{text('modelCall.experimentWorkspace')}</h2><p>Turn {turnLabel(round.turnOrdinal)} · {roundLabel(round)} <code>{round.mode} / {round.stage}</code></p></div>
        <button ref={closeButton} type="button" aria-label={text('modelCall.closeExperiment')} onClick={onClose}><X size={18} /></button>
      </header>
      <p className="debug-experiment-intro">{text('modelCall.experimentIntro')}</p>
      <div className="debug-experiment-columns">
        <div className="debug-experiment-editor">
          <ModelRequestEditor round={round} assembled={request as unknown as Record<string, unknown>} running={running} onRun={onRun} experiment />
        </div>
        <section className="debug-experiment-output">{children}</section>
      </div>
    </div>
  </ModalBackdrop>
}
