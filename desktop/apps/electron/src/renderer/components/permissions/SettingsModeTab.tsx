/**
 * Settings · Execution mode tab — three single-choice mode cards (how tight global tool permissions are).
 *
 * Reads `executionModeAtom`; picking one calls `setExecutionModeAtom` (optimistic update + POST
 * /me/execution-mode). On mount `loadExecutionModeAtom` fetches the real value once. The styling follows §LS1: each card
 * always carries a 1px transparent border which flips to a brand border + tinted background when selected, without changing box dimensions.
 *
 * Note: the scheduled-task overlap policy is no longer configurable — execution is always "start anyway" (overlap), hard-coded in the backend.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  executionModeAtom,
  loadExecutionModeAtom,
  setExecutionModeAtom,
} from '@/atoms/permissions'
import { cn } from '@/lib/cn'
import { SettingsTabLayout } from '../amphi/SettingsTabLayout'
import { MODE_META } from './modeMeta'
import { modeIcon, modeTint } from './icons'

const CARD = 'flex items-start gap-3 px-3.5 py-3 rounded-lg cursor-pointer border border-transparent bg-bg-elevated'
const CARD_ON = 'border-brand-blue bg-accent-blue-subtle'

export function SettingsModeTab() {
  const { t } = useTranslation()
  const mode = useAtomValue(executionModeAtom)
  const setMode = useSetAtom(setExecutionModeAtom)
  const load = useSetAtom(loadExecutionModeAtom)
  useEffect(() => {
    void load()
  }, [load])

  return (
    <SettingsTabLayout>
      <div className="text-sm text-text-secondary leading-relaxed">
        {t('permission.settings.desc')}
      </div>
      <div className="flex flex-col gap-2">
        {MODE_META.map((m) => {
          const on = m.id === mode
          return (
            <div key={m.id} onClick={() => void setMode(m.id)} className={cn(CARD, on && CARD_ON)}>
              <span className={cn('mt-0.5 shrink-0', modeTint(m.id))}>{modeIcon(m.id)(18)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{t(m.labelKey)}</span>
                  {m.id === 'auto' && (
                    <span className="text-2xs font-bold text-text-accent border border-brand-blue rounded-full px-1.5 py-px">
                      {t('permission.settings.defaultBadge')}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className={cn('text-xs', m.id === 'full' ? 'text-status-warning' : 'text-text-tertiary')}>
                    {t(m.freqKey)}
                  </span>
                </div>
                <div className="text-sm text-text-secondary mt-0.5 leading-snug">{t(m.descKey)}</div>
              </div>
              <span
                className={cn(
                  'mt-1 w-4 h-4 rounded-full border flex items-center justify-center shrink-0',
                  on ? 'border-brand-blue' : 'border-border-strong',
                )}
              >
                {on && <span className="w-2 h-2 rounded-full bg-brand-blue" />}
              </span>
            </div>
          )
        })}
      </div>
    </SettingsTabLayout>
  )
}
