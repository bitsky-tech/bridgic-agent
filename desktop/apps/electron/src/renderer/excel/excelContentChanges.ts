import { CommandType } from '@univerjs/core'
import {
  SetFormulaCalculationNotificationMutation,
  SetFormulaCalculationStartMutation,
  SetFormulaCalculationStopMutation,
  SetTriggerFormulaCalculationStartMutation,
} from '@univerjs/engine-formula'

const calculationLifecycle = new Set([
  SetFormulaCalculationNotificationMutation.id,
  SetFormulaCalculationStartMutation.id,
  SetFormulaCalculationStopMutation.id,
  SetTriggerFormulaCalculationStartMutation.id,
])

/** The cell input document and calculation lifecycle do not change workbook contents. */
export function isExcelContentMutation(event: { id: string; type: CommandType }): boolean {
  return event.type === CommandType.MUTATION
    && !event.id.startsWith('doc.')
    && !calculationLifecycle.has(event.id)
}
