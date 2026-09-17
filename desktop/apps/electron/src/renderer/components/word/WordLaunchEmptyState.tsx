import { useTranslation } from 'react-i18next'
import { Icons } from '@/components/amphi/Icons'
import { OfficeAppHeader } from '@/components/app/OfficeWorkbenchChrome'

/** Shared launch screen before a Session has an explicitly opened Word document. */
export function WordLaunchEmptyState({ creating = false, failed = false, onCreate }: {
  creating?: boolean
  failed?: boolean
  onCreate: () => void
}) {
  const { t } = useTranslation()
  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-surface" data-testid="word-launch-empty-state">
      <OfficeAppHeader icon={Icons.wordDocument(16)} iconClassName="bg-blue-500/10 text-blue-600 dark:text-blue-400" title="Word" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border-subtle bg-bg-app text-blue-600">
            {Icons.wordDocument(20)}
          </div>
          <div className="mt-4 text-sm font-medium text-text-primary">{t('word.emptyTitle')}</div>
          <div className="mt-1.5 text-xs leading-5 text-text-tertiary">{t('word.emptyDescription')}</div>
          <button
            aria-label={t('word.newDocument')}
            className="mt-4 inline-flex h-8 min-w-24 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-60"
            data-testid="word-create-document"
            disabled={creating}
            onClick={onCreate}
            type="button"
          >
            {creating ? t('word.hostLoading') : t('word.newDocument')}
          </button>
          {failed ? <div className="mt-2 text-xs text-status-error" role="alert">{t('word.hostFailed')}</div> : null}
        </div>
      </div>
    </section>
  )
}
