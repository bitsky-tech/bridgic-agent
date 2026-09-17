import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icons } from '@/components/amphi/Icons'
import { OfficeAppHeader } from './OfficeWorkbenchChrome'

export function OfficeLaunchEmptyState({ kind, onCreate, onOpen }: { kind: 'excel' | 'presentation'; onCreate: () => Promise<unknown>; onOpen?: () => void }) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState(false)
  const presentation = kind === 'presentation'
  const title = presentation ? 'PPT' : 'Excel'
  const icon = presentation ? Icons.presentation(20) : Icons.spreadsheet(20)
  const prefix = presentation ? 'powerpoint' : 'excel'
  const createLabel = presentation ? 'session.presentation.launchButton.create' : 'excel.newWorkbook'
  return <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid={`${prefix}-launch-empty-state`}>
    <OfficeAppHeader icon={icon} iconClassName={presentation ? 'bg-orange-500/10 text-orange-600' : 'bg-emerald-500/10 text-emerald-600'} title={title} />
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-text-secondary">{icon}</div>
        <div className="mt-4 text-sm font-medium text-text-primary">{t(presentation ? 'session.presentation.launchTitle' : 'excel.emptyTitle')}</div>
        <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{t(presentation ? 'session.presentation.launchDetail' : 'excel.emptyDescription')}</div>
        <div className="mt-4 flex justify-center gap-2">
          <button className="rounded-md bg-brand-blue px-3 py-2 text-xs text-white disabled:opacity-60" data-testid={presentation ? 'powerpoint-create-session' : 'excel-create-workbook'} disabled={creating} type="button" onClick={() => {
            if (creating) return
            setCreating(true); setFailed(false)
            void onCreate().catch(() => setFailed(true)).finally(() => setCreating(false))
          }}>{t(creating ? 'office.restoring' : createLabel)}</button>
          {onOpen ? <button className="rounded-md border border-border-subtle px-3 py-2 text-xs" onClick={onOpen} type="button">{t('excel.host.open')}</button> : null}
        </div>
        {failed ? <div className="mt-2 text-xs text-status-error" role="alert">{t('office.createFailed')}</div> : null}
      </div>
    </div>
  </section>
}
