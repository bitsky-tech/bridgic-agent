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
import { Btn, Icons, WindowedList } from '@/components/amphi'
import { hydrateSchedulesAtom, schedulesAtom } from '@/atoms/schedules'
import { openScheduleSessionAtom } from '@/atoms/schedule-session'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import { CenterPageLayout } from '../amphi/CenterPageLayout'
import { EmptyState } from '../amphi/EmptyState'
import { RefreshButton } from '../amphi/RefreshButton'
import { FilterTabs } from '../amphi/FilterTabs'
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

  return (
    <CenterPageLayout
      title={t('schedule.title')}
      subtitle={t('schedule.subtitle')}
      actions={
        <>
          <RefreshButton onRefresh={hydrate} label={t('schedule.action.refresh')} />
          <Btn variant="primary" size="md" data-testid="schedule-create" onClick={create}>
            {Icons.plus(14)} {t('schedule.action.create')}
          </Btn>
        </>
      }
      filters={
        <FilterTabs
          tabs={FILTER_KEYS.map((key) => ({
            key,
            label: t(`schedule.filter.${key}`),
            count: counts[key],
          }))}
          value={filter}
          onChange={setFilter}
          testIdPrefix="schedule-filter-"
        />
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          icon={Icons.clock}
          title={t('schedule.empty.title')}
          description={t('schedule.empty.desc')}
          action={
            <Btn variant="primary" size="md" onClick={create}>
              {Icons.plus(14)} {t('schedule.action.create')}
            </Btn>
          }
        />
      ) : (
        <WindowedList items={shown} className="flex flex-col gap-2.5">
          {(s) => <ScheduleRow key={s.id} s={s} />}
        </WindowedList>
      )}
    </CenterPageLayout>
  )
}
