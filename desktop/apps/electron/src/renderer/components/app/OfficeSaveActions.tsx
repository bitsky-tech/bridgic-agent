import { useTranslation } from 'react-i18next'

export function OfficeSaveActions({ onSave, dirty, error }: { disabled?: boolean; onSave: (saveAs: boolean) => void; dirty: boolean; error?: string | null }) {
  const { t } = useTranslation()
  const status = error ? 'office.saveFailed' : 'office.saved'
  const label = !error && dirty ? 'office.saving' : status
  return <div className="flex shrink-0 items-center gap-2 px-2">
    <span role={error ? 'alert' : 'status'} title={error ?? undefined} className="text-xs text-text-tertiary">{t(label)}</span>
    {error ? <button type="button" onClick={() => onSave(false)} className="rounded px-2 py-1 text-xs hover:bg-bg-hover">{t('office.retry')}</button> : null}
  </div>
}
