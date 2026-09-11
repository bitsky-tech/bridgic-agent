import { WorkbenchScopeButtons } from '@/components/app/WorkbenchToolPrimitives'
import { useDebugText } from './DebugSessionProvider'
import type { TraceRound } from './types'

export function roundStageKey(round: Pick<TraceRound, 'mode' | 'stage'>): string {
  return JSON.stringify([round.mode, round.stage])
}

export function StageFilter({ rounds, value, onChange }: {
  rounds: readonly TraceRound[]
  value: string
  onChange: (value: string) => void
}) {
  const text = useDebugText()
  const stages = [...new Map(rounds.map((round) => [roundStageKey(round), round])).values()]
  const options = stages.map((round) => {
    let label = round.stage ?? text('未记录阶段', 'Stage not recorded')
    if (stages.some((other) => other.stage === round.stage && other.mode !== round.mode)) {
      label += ` · ${round.mode ?? text('未记录模式', 'Mode not recorded')}`
    }
    return { value: roundStageKey(round), label }
  })

  return <div className="mt-2.5">
    <WorkbenchScopeButtons ariaLabel={text('按阶段筛选', 'Filter by stage')} value={value} onChange={onChange}
      options={[{ value: '', label: text('全部阶段', 'All stages') }, ...options]} />
  </div>
}
