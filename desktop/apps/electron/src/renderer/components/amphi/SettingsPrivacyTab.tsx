import { useAtomValue } from 'jotai'
import { CircleCheck, ExternalLink, LockKeyhole, ShieldCheck } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_PRIVACY_NOTICE_URL, APP_PRODUCT_NAME } from '@shared/app-meta'
import { settingsAtom } from '@/atoms/settings'
import { useUpdateSettings } from '@/hooks/useSettingsBridge'
import { rlog } from '@/lib/logger'
import { Toggle } from './Primitives'

/** Privacy controls backed by the persisted GUI settings blob. */
export function SettingsPrivacyTab() {
  const { t } = useTranslation()
  const settings = useAtomValue(settingsAtom)
  const updateSettings = useUpdateSettings()
  const titleId = useId()
  const descriptionId = useId()
  const purposeId = useId()
  const optedIn = settings.ui.telemetryOptIn

  const toggleTelemetry = () => {
    void updateSettings((prev) => ({
      ...prev,
      ui: { ...prev.ui, telemetryOptIn: !prev.ui.telemetryOptIn },
    }))
  }

  const openPrivacyNotice = () => {
    void window.api.shell
      .openExternal(APP_PRIVACY_NOTICE_URL)
      .catch((error: unknown) => rlog.warn('[privacy] open notice failed', error))
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h2 className="text-base font-semibold text-text-primary">
          {t('settings.privacy.telemetry.sectionTitle', { product: APP_PRODUCT_NAME })}
        </h2>
        <p id={purposeId} className="mt-1 text-sm leading-[1.6] text-text-secondary">
          {t('settings.privacy.telemetry.sectionDescription')}
        </p>

        <button
          type="button"
          role="switch"
          aria-checked={optedIn}
          aria-labelledby={titleId}
          aria-describedby={`${purposeId} ${descriptionId}`}
          data-testid="telemetry-opt-in"
          onClick={toggleTelemetry}
          className={`mt-3 w-full cursor-pointer rounded-lg border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${
            optedIn
              ? 'border-brand-blue bg-accent-blue-subtle'
              : 'border-border-default bg-bg-surface'
          }`}
        >
          <span className="flex items-center gap-4">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span id={titleId} className="text-sm font-semibold text-text-primary">
                  {t('settings.privacy.telemetry.switchTitle')}
                </span>
                <span
                  aria-live="polite"
                  className={optedIn ? 'text-xs font-semibold text-brand-blue' : 'text-xs text-text-tertiary'}
                >
                  {t(optedIn
                    ? 'settings.privacy.telemetry.statusOn'
                    : 'settings.privacy.telemetry.statusOff')}
                </span>
              </span>
              <span id={descriptionId} className="mt-1.5 block text-sm leading-[1.6] text-text-secondary">
                {t(optedIn
                  ? 'settings.privacy.telemetry.switchDescriptionOn'
                  : 'settings.privacy.telemetry.switchDescriptionOff')}
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0">
              <Toggle on={optedIn} size={22} />
            </span>
          </span>
        </button>
      </section>

      <section className="flex items-start gap-3 px-1 py-1">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-blue" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            {t('settings.privacy.localFirst.title')}
          </h2>
          <p className="mt-0.5 text-sm leading-[1.55] text-text-secondary">
            {t('settings.privacy.localFirst.description')}
          </p>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-border-default bg-bg-surface">
        <div className="px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('settings.privacy.telemetry.dataScopeTitle')}
          </h2>
        </div>
        <PrivacySummaryRow
          icon={<CircleCheck className="h-4 w-4 text-brand-blue" />}
          title={t('settings.privacy.telemetry.sharedTitle')}
          description={t('settings.privacy.telemetry.sharedSummary')}
        />
        <PrivacySummaryRow
          icon={<LockKeyhole className="h-4 w-4 text-status-success" />}
          title={t('settings.privacy.telemetry.excludedTitle')}
          description={t('settings.privacy.telemetry.excludedSummary')}
        />
        <div className="border-t border-border-subtle bg-bg-hover px-4 py-3">
          <p className="text-xs leading-[1.6] text-text-secondary">
            {t('settings.privacy.use.description')}
          </p>
        </div>
      </section>

      <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-4">
        <span className="text-xs text-text-tertiary">{t('settings.privacy.notice.updated')}</span>
        <button
          type="button"
          data-testid="privacy-notice-link"
          onClick={openPrivacyNotice}
          className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-brand-blue hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {t('settings.privacy.notice.label')}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function PrivacySummaryRow({
  icon,
  title,
  description,
}: {
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-t border-border-subtle px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-text-primary">
        <span aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
      </div>
      <p className="text-xs leading-[1.6] text-text-secondary">{description}</p>
    </div>
  )
}
