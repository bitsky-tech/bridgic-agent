/**
 * Schedule center — the list view (title + filters + empty state + task list).
 *
 * Rendered by CenterView when activeNav===Schedules and there is no scheduleDetailId. The data comes from
 * schedulesAtom (wired to the real daemon REST API, hydrated on mount). "Create scheduled task" goes through a real new session +
 * a Doubao-style template pre-fill (openScheduleSessionAtom → buildScheduleTemplateSegments).
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Btn, Icons, WindowedList } from '@/components/amphi'
import { hydrateSchedulesAtom, schedulesAtom } from '@/atoms/schedules'
import { openScheduleSessionAtom } from '@/atoms/schedule-session'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import { ScheduleRow } from './ScheduleRow'

const FILTER_KEYS = ['all', 'active', 'paused'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

/** Schedule list view (title + filter tabs + empty state + task rows). */
export function CenterSchedules() {
  const { t } = useTranslation()
  const list = useAtomValue(schedulesAtom)
  const openSession = useSetAtom(openScheduleSessionAtom)
  const hydrate = useSetAtom(hydrateSchedulesAtom)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [refreshing, setRefreshing] = useState(false)

  // Load the real schedule list on mount (external sync — not derived state).
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The counts and the filters must use identical criteria: "enabled" = not paused (including running / needs action), "paused" = paused.
  const counts = {
    all: list.length,
    active: list.filter((s) => !s.paused).length,
    paused: list.filter((s) => s.paused).length,
  }
  const shown = list.filter((s) => {
    if (filter === 'paused') return s.paused
    if (filter === 'active') return !s.paused
    return true
  })

  const create = () => openSession({ mode: ScheduleTemplateMode.Create })
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    await hydrate()
    setRefreshing(false)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-8 pt-5 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary m-0">{t('schedule.title')}</h2>
          <p className="text-sm text-text-secondary mt-1">
            {t('schedule.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <Btn variant="default" size="md" onClick={refresh}>
            <span className={cn('flex', refreshing && 'animate-spin')}>{Icons.refresh(14)}</span> {t('schedule.action.refresh')}
          </Btn>
          <Btn variant="primary" size="md" data-testid="schedule-create" onClick={create}>
            {Icons.plus(14)} {t('schedule.action.create')}
          </Btn>
        </div>
      </div>

      {/* Filter tabs — §LS1: the font weight is fixed in the base class and the selected state only flips color/background. Going from weight 400→600 would
          make CJK glyphs wider and push the tabs in the group, along with the count parentheses after them, sideways. */}
      <div className="px-8 pt-4">
        <div className="flex gap-1 p-1 rounded-md border border-border-subtle bg-bg-surface w-fit">
          {FILTER_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`schedule-filter-${key}`}
              onClick={() => setFilter(key)}
              className={cn(
                'px-3.5 py-1 rounded-[5px] text-xs font-semibold',
                filter === key
                  ? 'bg-bg-elevated text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              {t(`schedule.filter.${key}`)}
              <span className="ml-1 opacity-60">({counts[key]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pt-[18px] pb-8">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-[52px] h-[52px] rounded-full border-[1.5px] border-dashed border-border-strong flex items-center justify-center text-text-tertiary mb-4">
              {Icons.clock(22)}
            </div>
            <div className="text-lg font-semibold text-text-primary mb-1.5">{t('schedule.empty.title')}</div>
            <div className="text-sm text-text-secondary mb-[18px] max-w-[340px]">
              {t('schedule.empty.desc')}
            </div>
            <Btn variant="primary" size="md" onClick={create}>
              {Icons.plus(14)} {t('schedule.action.create')}
            </Btn>
          </div>
        ) : (
          <WindowedList items={shown} className="flex flex-col gap-2.5">
            {(s) => <ScheduleRow key={s.id} s={s} />}
          </WindowedList>
        )}
      </div>
    </div>
  )
}
