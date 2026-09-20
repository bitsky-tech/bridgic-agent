import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icons } from '@/components/amphi/Icons'
import { OfficeAppHeader } from './OfficeWorkbenchChrome'

type OfficeLaunchKind = 'excel' | 'presentation' | 'word'
type LaunchOperation = 'create' | 'open'

const launchConfig = {
  excel: {
    title: 'Excel',
    prefix: 'excel',
    icon: Icons.spreadsheet,
    iconClassName: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    titleKey: 'excel.emptyTitle',
    descriptionKey: 'excel.emptyDescription',
    createLabelKey: 'excel.newWorkbook',
    createTestId: 'excel-create-workbook',
  },
  presentation: {
    title: 'PPT',
    prefix: 'powerpoint',
    icon: Icons.presentation,
    iconClassName: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    titleKey: 'session.presentation.launchTitle',
    descriptionKey: 'session.presentation.launchDetail',
    createLabelKey: 'session.presentation.launchButton.create',
    createTestId: 'powerpoint-create-session',
  },
  word: {
    title: 'Word',
    prefix: 'word',
    icon: Icons.wordDocument,
    iconClassName: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    titleKey: 'word.emptyTitle',
    descriptionKey: 'word.emptyDescription',
    createLabelKey: 'word.newDocument',
    createTestId: 'word-create-document',
  },
} as const

export function OfficeLaunchEmptyState({ kind, onCreate, onOpen }: {
  kind: OfficeLaunchKind
  onCreate: () => unknown | Promise<unknown>
  onOpen: () => unknown | Promise<unknown>
}) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<LaunchOperation | null>(null)
  const [failed, setFailed] = useState<LaunchOperation | null>(null)
  const config = launchConfig[kind]
  const run = (operation: LaunchOperation, action: () => unknown | Promise<unknown>) => {
    if (pending) return
    setPending(operation)
    setFailed(null)
    void Promise.resolve().then(action).catch(() => setFailed(operation)).finally(() => setPending(null))
  }
  return <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid={`${config.prefix}-launch-empty-state`}>
    <OfficeAppHeader icon={config.icon(20)} iconClassName={config.iconClassName} title={config.title} />
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-text-secondary">{config.icon(20)}</div>
        <div className="mt-4 text-sm font-medium text-text-primary">{t(config.titleKey)}</div>
        <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{t(config.descriptionKey)}</div>
        <div className="mt-4 flex justify-center gap-2">
          <button
            className="inline-flex h-8 items-center justify-center rounded-md bg-brand-blue px-3 text-xs font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-60"
            data-testid={config.createTestId}
            disabled={pending !== null}
            onClick={() => run('create', onCreate)}
            type="button"
          >{t(pending === 'create' ? 'office.creating' : config.createLabelKey)}</button>
          <button
            className="inline-flex h-8 items-center justify-center rounded-md border border-border-subtle bg-bg-surface px-3 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:cursor-default disabled:opacity-60"
            data-testid={`${config.prefix}-open-file`}
            disabled={pending !== null}
            onClick={() => run('open', onOpen)}
            type="button"
          >{t(pending === 'open' ? 'office.opening' : 'office.open')}</button>
        </div>
        {failed ? <div className="mt-2 text-xs text-status-error" role="alert">{t(failed === 'create' ? 'office.createFailed' : 'office.openFailed')}</div> : null}
      </div>
    </div>
  </section>
}
