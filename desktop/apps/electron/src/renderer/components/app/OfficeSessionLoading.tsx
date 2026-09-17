import { useTranslation } from 'react-i18next'

export function OfficeSessionLoading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation()
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-text-secondary" data-testid="office-session-restoring" role={failed ? 'alert' : 'status'}>
    <span>{t(failed ? 'office.recoveryFailed' : 'office.restoring')}</span>
    {failed ? <button className="rounded-md bg-brand-blue px-3 py-2 text-white" onClick={onRetry} type="button">{t('office.retry')}</button> : null}
  </div>
}
