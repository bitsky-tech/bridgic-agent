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
    let label = round.stage ?? text('stageNotRecorded')
    if (stages.some((other) => other.stage === round.stage && other.mode !== round.mode)) {
      label += ` · ${round.mode ?? text('modeNotRecorded')}`
    }
    return { value: roundStageKey(round), label }
  })

  return <div className="mt-2.5">
    <WorkbenchScopeButtons ariaLabel={text('filterByStage')} value={value} onChange={onChange}
      options={[{ value: '', label: text('allStages') }, ...options]} />
  </div>
}
